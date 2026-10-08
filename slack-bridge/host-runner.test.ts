import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostRunner, type RuntimeHandle } from "./host-runner.js";
import { writeJoinProfile } from "./join-profile.js";

vi.mock("node:fs", { spy: true });
vi.mock("node:child_process", { spy: true });

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) fn();
});

describe("host runner", () => {
  it("starts, addresses, reads and stops an owned plain-shell process without inherited Slack tokens", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pinet-host-"));
    cleanups.push(() => fs.rmSync(root, { force: true, recursive: true }));
    const profile = path.join(root, "join.json");
    writeJoinProfile(profile, {
      version: 1,
      endpoint: { path: path.join(root, "broker.sock") },
      hostId: "host",
      workerId: "worker",
      credentialId: "test",
      credentialSecret: "test",
      repos: [root],
      capabilities: [],
    });
    const runner = new HostRunner(path.join(root, "runtimes"));
    const handle = await runner.adapter("shell").start({
      cwd: root,
      profilePath: profile,
      command: ["/bin/sh", "-c", 'printf "token=%s\\n" "${SLACK_BOT_TOKEN-unset}"; cat'],
    });
    cleanups.push(() => runner.stop(handle));
    expect(runner.status(handle)).toBe("running");
    expect(runner.attachCommand(handle)).toBeNull();
    const shortWrite = vi.spyOn(fs, "writeSync").mockReturnValue(3);
    expect(() => runner.send(handle, "€€")).toThrow("3/6 bytes written");
    shortWrite.mockRestore();
    runner.send(handle, "hello-worker\n");
    await expect.poll(() => runner.read(handle)).toContain("hello-worker");
    expect(runner.read(handle)).toContain("token=unset");
    expect(runner.report([root])).toMatchObject({
      repos: [root],
      capacity: 1,
      health: { status: "ready" },
    });
    await expect(
      runner.start("shell", { cwd: root, profilePath: profile, command: ["/bin/cat"] }),
    ).rejects.toThrow("capacity");
    runner.stop(handle);
    await expect.poll(() => runner.status(handle), { timeout: 10_000 }).toBe("stopped");
  }, 20_000);

  it.each(["tmux", "rex"] as const)(
    "rolls back owned %s launches on persistence failure and retains state if cleanup fails",
    async (kind) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "pinet-host-review-"));
      cleanups.push(() => fs.rmSync(root, { force: true, recursive: true }));
      const profile = path.join(root, "join.json");
      writeJoinProfile(profile, {
        version: 1,
        endpoint: { path: path.join(root, "broker.sock") },
        hostId: "host",
        workerId: "worker",
        credentialId: "test",
        credentialSecret: "test",
        repos: [root],
        capabilities: [],
      });
      const runtimeRoot = path.join(root, "runtimes");
      const runner = new HostRunner(runtimeRoot);
      const calls: Array<{ file: string; args: readonly string[] }> = [];
      let stopped = false;
      let failCleanup = false;
      vi.spyOn(childProcess, "execFileSync").mockImplementation((file, args) => {
        const command = args as readonly string[];
        calls.push({ file, args: command });
        if (
          (file === "tmux" && command.includes("kill-session")) ||
          (file === "rex" && command[0] === "block" && command[1] === "close")
        ) {
          expect(fs.readdirSync(runtimeRoot).some((name) => name.startsWith("pinet-"))).toBe(true);
          if (failCleanup) throw new Error("injected cleanup failure");
          stopped = true;
        }
        return Buffer.from(
          file === "rex" && command[0] === "run"
            ? JSON.stringify({ block_ids: ["block:review-owned"] })
            : "",
        );
      });
      const actualFs = await vi.importActual<typeof fs>("node:fs");
      const writeFile = actualFs.writeFileSync;
      vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
        if (String(file).endsWith("handle.json"))
          throw new Error("injected handle persistence failure");
        return writeFile(file, data, options);
      });
      await expect(
        runner.start(kind, { cwd: root, profilePath: profile, command: ["/bin/cat"] }),
      ).rejects.toThrow("injected handle persistence failure");
      expect(stopped).toBe(true);
      if (kind === "rex")
        expect(calls.at(-1)).toEqual({
          file: "rex",
          args: ["block", "close", "block:review-owned"],
        });
      else {
        const create = calls.find((call) => call.args.includes("new-session"))!;
        const session = create.args[create.args.indexOf("-s") + 1];
        expect(calls.at(-1)).toEqual({
          file: "tmux",
          args: [
            "-S",
            path.join(fs.realpathSync(runtimeRoot), "tmux.sock"),
            "kill-session",
            "-t",
            session,
          ],
        });
      }
      expect(fs.readdirSync(runtimeRoot)).toEqual([]);
      stopped = false;
      failCleanup = true;
      await expect(
        runner.start(kind, { cwd: root, profilePath: profile, command: ["/bin/cat"] }),
      ).rejects.toThrow("retained");
      expect(stopped).toBe(false);
      expect(fs.readdirSync(runtimeRoot)).toHaveLength(1);
      await expect(
        runner.start(kind, { cwd: root, profilePath: profile, command: ["/bin/cat"] }),
      ).rejects.toThrow("Incomplete runtime record");
    },
  );

  it("rejects out-of-repo starts and handles outside the owned runner", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pinet-host-"));
    cleanups.push(() => fs.rmSync(root, { force: true, recursive: true }));
    const profile = path.join(root, "join.json");
    writeJoinProfile(profile, {
      version: 1,
      endpoint: { path: path.join(root, "broker.sock") },
      hostId: "host",
      workerId: "worker",
      credentialId: "test",
      credentialSecret: "test",
      repos: [root],
      capabilities: [],
    });
    const runner = new HostRunner(path.join(root, "runtimes"));
    await expect(
      runner.start("shell", { cwd: "/", profilePath: profile, command: ["/bin/cat"] }),
    ).rejects.toThrow("repository allowlist");
    fs.writeFileSync(
      path.join(root, "foreign.json"),
      JSON.stringify({
        version: 1,
        kind: "shell",
        host: os.hostname(),
        directory: root,
        id: "foreign",
      } satisfies Partial<RuntimeHandle>),
    );
    expect(() => runner.load(path.join(root, "foreign.json"))).toThrow("outside this runner");
  });
});
