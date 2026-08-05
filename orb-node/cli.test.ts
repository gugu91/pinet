import { describe, expect, it } from "vitest";
import {
  buildAmpOrbLaunchArgs,
  ORB_NODE_USAGE,
  parseOrbNodeCliArgs,
  runOrbNodeCli,
  type OrbNodeCliDeps,
} from "./cli.js";

function captureDeps(launchResult: number | Error = 0): {
  deps: OrbNodeCliDeps;
  out: string[];
  err: string[];
  launches: { command: string; args: string[] }[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const launches: { command: string; args: string[] }[] = [];
  return {
    out,
    err,
    launches,
    deps: {
      write: (text) => out.push(text),
      writeErr: (text) => err.push(text),
      launch: (command, args) => {
        launches.push({ command, args });
        return launchResult instanceof Error
          ? Promise.reject(launchResult)
          : Promise.resolve(launchResult);
      },
    },
  };
}

describe("parseOrbNodeCliArgs", () => {
  it("parses the up command with defaults", () => {
    const args = parseOrbNodeCliArgs(["up"]);
    expect(args.command).toBe("up");
    expect(args.dryRun).toBe(false);
    expect(args.mode).toBeNull();
    expect(args.ampCommand).toBe("amp");
    expect(args.serviceName).toBe("pinet-broker");
  });

  it("parses all options", () => {
    const args = parseOrbNodeCliArgs([
      "up",
      "--dry-run",
      "--mode",
      "high",
      "--amp-command",
      "/opt/amp",
      "--service",
      "mesh-hub",
    ]);
    expect(args.dryRun).toBe(true);
    expect(args.mode).toBe("high");
    expect(args.ampCommand).toBe("/opt/amp");
    expect(args.serviceName).toBe("mesh-hub");
  });

  it("rejects invalid modes, missing values, and unknown flags", () => {
    expect(() => parseOrbNodeCliArgs(["up", "--mode", "turbo"])).toThrow(/--mode must be one of/);
    expect(() => parseOrbNodeCliArgs(["up", "--mode"])).toThrow(/--mode requires a value/);
    expect(() => parseOrbNodeCliArgs(["up", "--wat"])).toThrow(/Unknown argument: --wat/);
  });
});

describe("buildAmpOrbLaunchArgs", () => {
  it("always launches a non-archiving orb execute turn", () => {
    expect(buildAmpOrbLaunchArgs({ mode: null, prompt: "P" })).toEqual([
      "--orb-execute",
      "--no-archive-after-execute",
      "-x",
      "P",
    ]);
  });

  it("threads the agent mode through when set", () => {
    expect(buildAmpOrbLaunchArgs({ mode: "high", prompt: "P" })).toEqual([
      "--orb-execute",
      "--no-archive-after-execute",
      "--mode",
      "high",
      "-x",
      "P",
    ]);
  });
});

describe("runOrbNodeCli", () => {
  it("prints usage on --help and exits 0", async () => {
    const { deps, out } = captureDeps();
    expect(await runOrbNodeCli(["--help"], deps)).toBe(0);
    expect(out.join("")).toBe(ORB_NODE_USAGE);
  });

  it("prints usage to stderr and exits 2 without a command", async () => {
    const { deps, err } = captureDeps();
    expect(await runOrbNodeCli([], deps)).toBe(2);
    expect(err.join("")).toBe(ORB_NODE_USAGE);
  });

  it("reports parse errors with usage and exits 2", async () => {
    const { deps, err } = captureDeps();
    expect(await runOrbNodeCli(["up", "--wat"], deps)).toBe(2);
    expect(err.join("")).toContain("Unknown argument: --wat");
    expect(err.join("")).toContain("Usage: pinet-orb-node");
  });

  it("dry-run prints the invocation and prompt without launching", async () => {
    const { deps, out, launches } = captureDeps();
    expect(await runOrbNodeCli(["up", "--dry-run", "--mode", "low"], deps)).toBe(0);
    expect(launches).toHaveLength(0);
    const text = out.join("");
    expect(text).toContain("amp --orb-execute --no-archive-after-execute --mode low -x <prompt>");
    expect(text).toContain("orb-node/setup/orb-broker-setup.sh");
  });

  it("launches amp with the bootstrap prompt and returns its exit code", async () => {
    const { deps, launches } = captureDeps(3);
    expect(await runOrbNodeCli(["up", "--service", "mesh-hub"], deps)).toBe(3);
    expect(launches).toHaveLength(1);
    expect(launches[0].command).toBe("amp");
    expect(launches[0].args.slice(0, 2)).toEqual(["--orb-execute", "--no-archive-after-execute"]);
    expect(launches[0].args.at(-1)).toContain("PINET_ORB_SERVICE_NAME=mesh-hub");
  });

  it("reports launch failures and exits 1", async () => {
    const { deps, err } = captureDeps(new Error("amp not found"));
    expect(await runOrbNodeCli(["up"], deps)).toBe(1);
    expect(err.join("")).toContain("amp not found");
  });
});
