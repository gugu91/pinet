import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AmpRunner, parseAmpMode, AMP_MODES } from "./amp-runner.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "amp-runner-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Install a fake `amp` executable that records its argv/stdin to files and
 * behaves per the FAKE_AMP_BEHAVIOR environment variable.
 */
function installFakeAmp(): {
  command: string;
  argvLog: string;
  stdinLog: string;
  readyLog: string;
} {
  const command = path.join(tempDir, "fake-amp");
  const argvLog = path.join(tempDir, "argv.json");
  const stdinLog = path.join(tempDir, "stdin.txt");
  const readyLog = path.join(tempDir, "ready.txt");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
const behavior = process.env.FAKE_AMP_BEHAVIOR || "ok";
if (behavior === "hang-ignore-sigterm") {
  // Install before signalling readiness so the test's SIGTERM cannot race it.
  process.on("SIGTERM", () => {});
  fs.writeFileSync(${JSON.stringify(readyLog)}, "ready");
}
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(stdinLog)}, stdin);
  const args = process.argv.slice(2);
  if (args[0] === "threads" && args[1] === "new") {
    if (behavior === "new-fails") { process.stderr.write("boom\\n"); process.exit(1); }
    if (behavior === "new-no-id") { process.stdout.write("created a thread\\n"); process.exit(0); }
    if (behavior === "new-hang") { setTimeout(() => { process.exit(0); }, 60000); return; }
    process.stdout.write("T-0199aaaa-bbbb-cccc-dddd-eeeeffff0001\\n");
    process.exit(0);
  }
  if (behavior === "error-result") {
    process.stdout.write(JSON.stringify({ type: "result", result: "it broke", session_id: args[2], is_error: true }) + "\\n");
    process.exit(0);
  }
  if (behavior === "exit-nonzero") {
    process.stderr.write("amp crashed\\n");
    process.exit(3);
  }
  if (behavior === "hang") {
    setTimeout(() => { process.exit(0); }, 60000);
    return;
  }
  if (behavior === "hang-ignore-sigterm") {
    setTimeout(() => { process.exit(0); }, 60000);
    return;
  }
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", result: "echo:" + stdin, session_id: args[2], is_error: false }) + "\\n");
  process.exit(0);
});
`;
  fs.writeFileSync(command, script, { mode: 0o755 });
  return { command, argvLog, stdinLog, readyLog };
}

async function waitForFile(filePath: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function makeRunner(
  command: string,
  behavior: string,
  extra: Partial<{ executionTimeoutMs: number; setupTimeoutMs: number; killGraceMs: number }> = {},
): AmpRunner {
  return new AmpRunner({
    ampCommand: command,
    cwd: tempDir,
    mode: "high",
    env: { ...process.env, FAKE_AMP_BEHAVIOR: behavior },
    ...extra,
  });
}

describe("parseAmpMode", () => {
  it("accepts exactly the documented Amp modes", () => {
    for (const mode of AMP_MODES) {
      expect(parseAmpMode(mode)).toBe(mode);
      expect(parseAmpMode(mode.toUpperCase())).toBe(mode);
    }
    expect(() => parseAmpMode("turbo")).toThrow(/Valid modes: low, medium, high, ultra/);
  });
});

describe("AmpRunner.createThread", () => {
  it("runs `amp threads new` and extracts the thread ID", async () => {
    const fake = installFakeAmp();
    const runner = makeRunner(fake.command, "ok");
    const threadId = await runner.createThread();
    expect(threadId).toBe("T-0199aaaa-bbbb-cccc-dddd-eeeeffff0001");
    expect(JSON.parse(fs.readFileSync(fake.argvLog, "utf-8"))).toEqual(["threads", "new"]);
  });

  it("fails with stderr context when thread creation exits nonzero", async () => {
    const fake = installFakeAmp();
    const runner = makeRunner(fake.command, "new-fails");
    await expect(runner.createThread()).rejects.toThrow(/exited with code 1: boom/);
  });

  it("fails when no thread ID is printed", async () => {
    const fake = installFakeAmp();
    const runner = makeRunner(fake.command, "new-no-id");
    await expect(runner.createThread()).rejects.toThrow(/did not print a thread ID/);
  });

  it("bounds a hung thread creation with the setup timeout", async () => {
    const fake = installFakeAmp();
    const runner = makeRunner(fake.command, "new-hang", { setupTimeoutMs: 300 });
    await expect(runner.createThread()).rejects.toThrow(/timed out after 300ms/);
    expect(runner.isBusy()).toBe(false);
  }, 10000);

  it("owns the setup child so interrupt can stop a hung thread creation", async () => {
    const fake = installFakeAmp();
    const runner = makeRunner(fake.command, "new-hang");
    const pending = runner.createThread();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(runner.isBusy()).toBe(true);
    expect(runner.interrupt()).toBe(true);
    await expect(pending).rejects.toThrow(/was interrupted/);
    expect(runner.isBusy()).toBe(false);
  }, 10000);
});

describe("AmpRunner.continueThread", () => {
  it("invokes the exact continuation argv and passes the message via stdin", async () => {
    const fake = installFakeAmp();
    const runner = makeRunner(fake.command, "ok");
    const result = await runner.continueThread("T-abc12345", "secret prompt body");

    expect(JSON.parse(fs.readFileSync(fake.argvLog, "utf-8"))).toEqual([
      "threads",
      "continue",
      "T-abc12345",
      "-x",
      "--stream-json",
      "-m",
      "high",
    ]);
    expect(fs.readFileSync(fake.stdinLog, "utf-8")).toBe("secret prompt body");
    expect(result).toMatchObject({
      status: "ok",
      resultText: "echo:secret prompt body",
      ampThreadId: "T-abc12345",
      exitCode: 0,
      signal: null,
    });
  });

  it("reports stream-level errors as a durable error outcome without rejecting", async () => {
    const fake = installFakeAmp();
    const runner = makeRunner(fake.command, "error-result");
    const result = await runner.continueThread("T-abc12345", "msg");
    expect(result.status).toBe("error");
    expect(result.resultText).toBe("it broke");
  });

  it("reports nonzero exits as errors with a bounded stderr tail", async () => {
    const fake = installFakeAmp();
    const runner = makeRunner(fake.command, "exit-nonzero");
    const result = await runner.continueThread("T-abc12345", "msg");
    expect(result.status).toBe("error");
    expect(result.exitCode).toBe(3);
    expect(result.stderrTail).toContain("amp crashed");
  });

  it("keeps the requested thread ID when the stream reports none", async () => {
    const fake = installFakeAmp();
    const runner = makeRunner(fake.command, "exit-nonzero");
    const result = await runner.continueThread("T-abc12345", "msg");
    expect(result.ampThreadId).toBe("T-abc12345");
  });

  it("interrupt() SIGTERMs the owned child and reports an interrupted outcome", async () => {
    const fake = installFakeAmp();
    const runner = makeRunner(fake.command, "hang");
    const pending = runner.continueThread("T-abc12345", "msg");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(runner.isBusy()).toBe(true);
    expect(runner.interrupt()).toBe(true);
    const result = await pending;
    expect(result.status).toBe("interrupted");
    expect(result.signal).toBe("SIGTERM");
    expect(runner.isBusy()).toBe(false);
  });

  it("interrupt() is a no-op without an owned child", () => {
    const fake = installFakeAmp();
    const runner = makeRunner(fake.command, "ok");
    expect(runner.interrupt()).toBe(false);
  });

  it("classifies an execution timeout as an error, not an operator interrupt", async () => {
    const fake = installFakeAmp();
    const runner = makeRunner(fake.command, "hang", { executionTimeoutMs: 300 });
    const result = await runner.continueThread("T-abc12345", "msg");
    expect(result.status).toBe("error");
    expect(result.stderrTail).toMatch(/exceeded the 300ms timeout/);
    expect(runner.isBusy()).toBe(false);
  }, 10000);

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const fake = installFakeAmp();
    const runner = makeRunner(fake.command, "hang-ignore-sigterm", { killGraceMs: 300 });
    const pending = runner.continueThread("T-abc12345", "msg");
    await waitForFile(fake.readyLog);
    expect(runner.interrupt()).toBe(true);
    const result = await pending;
    expect(result.status).toBe("interrupted");
    expect(result.signal).toBe("SIGKILL");
    expect(runner.isBusy()).toBe(false);
  }, 10000);

  it("rejects concurrent executions", async () => {
    const fake = installFakeAmp();
    const runner = makeRunner(fake.command, "hang");
    const pending = runner.continueThread("T-abc12345", "msg");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(runner.continueThread("T-abc12345", "again")).rejects.toThrow(/busy/);
    runner.interrupt();
    await pending;
  });

  it("rejects when the amp executable is missing", async () => {
    const runner = new AmpRunner({
      ampCommand: path.join(tempDir, "does-not-exist"),
      cwd: tempDir,
      mode: "low",
    });
    await expect(runner.continueThread("T-abc12345", "msg")).rejects.toThrow(/Failed to run/);
  });
});
