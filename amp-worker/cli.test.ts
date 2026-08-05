import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AMP_WORKER_VERSION, buildAmpWorkerRegistrationMetadata } from "./cli.js";
import { parseAmpWorkerArgs, resolveAmpWorkerConfig } from "./config.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "amp-cli-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeMetadata(
  overrides: {
    orbIdentity?: Parameters<typeof buildAmpWorkerRegistrationMetadata>[0]["orbIdentity"];
    git?: Parameters<typeof buildAmpWorkerRegistrationMetadata>[0]["git"];
  } = {},
) {
  const config = resolveAmpWorkerConfig(
    parseAmpWorkerArgs(["--cwd", tempDir, "--name", "amp-meta", "--stable-id", "amp-meta-1"]),
  );
  return buildAmpWorkerRegistrationMetadata({
    config,
    mode: config.mode,
    ampVersion: "0.0.1-test",
    git: overrides.git ?? { repo: null, repoRoot: null, branch: null },
    orbIdentity: overrides.orbIdentity ?? null,
  });
}

describe("buildAmpWorkerRegistrationMetadata", () => {
  it("advertises first-class harness/protocol/host identity", () => {
    const metadata = makeMetadata();
    expect(metadata).toMatchObject({
      role: "worker",
      harness: "amp",
      adapter: "amp-worker",
      adapterVersion: AMP_WORKER_VERSION,
      protocol: "pinet-broker/jsonrpc2",
      ampVersion: "0.0.1-test",
      mode: "medium",
      transport: "socket",
      executor: "local",
    });
    expect(metadata.host).toBe(os.hostname());
    expect(metadata.capabilities).toMatchObject({ harness: "amp" });
    expect(metadata.tags).toContain("harness:amp");
    expect(metadata.tags).toContain("executor:local");
  });

  it("includes repo/branch identity when available", () => {
    const metadata = makeMetadata({
      git: { repo: "git@github.com:gugu91/pinet.git", repoRoot: "/repo", branch: "main" },
    });
    expect(metadata).toMatchObject({
      repo: "git@github.com:gugu91/pinet.git",
      repoRoot: "/repo",
      branch: "main",
    });
    expect(metadata.tags).toContain("branch:main");
  });

  it("attaches orb identity claims without any token material", () => {
    const metadata = makeMetadata({
      orbIdentity: {
        issuer: "https://ampcode.com/api/workload-identity",
        audience: "pinet-mesh",
        subject: "orb:sub",
        tokenUse: "exchanged",
        ampThreadId: "T-abc12345",
        workspaceId: "W-1",
        projectId: "P-1",
      },
    });
    expect(metadata.executor).toBe("orb");
    expect(metadata.orb).toEqual({
      issuer: "https://ampcode.com/api/workload-identity",
      audience: "pinet-mesh",
      ampThreadId: "T-abc12345",
      workspaceId: "W-1",
      projectId: "P-1",
    });
    expect(JSON.stringify(metadata)).not.toContain("token");
    expect(metadata.tags).toContain("executor:orb");
  });
});
