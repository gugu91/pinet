import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostRunner, type RuntimeHandle } from "./host-runner.js";
import { writeJoinProfile } from "./join-profile.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
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
