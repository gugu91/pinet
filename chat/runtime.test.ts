import { describe, expect, it } from "vitest";
import {
  HerdrRuntimeAdapter,
  ProcessRuntimeAdapter,
  TmuxRuntimeAdapter,
  type CommandRunner,
} from "./runtime.js";

class FakeRunner implements CommandRunner {
  identity: string | undefined = "start pi";
  signalled = false;
  startedArgs: string[] = [];
  startedInput: string | undefined;
  async start(_command: string, args: string[], _cwd: string, input?: string) {
    this.startedArgs = args;
    this.startedInput = input;
    return { pid: 42, identity: "start pi" };
  }
  async exec(_command: string, _args: string[]) {
    return { stdout: "" };
  }
  async signal(pid: number) {
    expect(pid).toBe(42);
    this.signalled = true;
  }
  async processIdentity() {
    return this.identity;
  }
}
describe("runtime adapter safety", () => {
  it("only terminates a process whose recorded launch identity still matches", async () => {
    const runner = new FakeRunner();
    const adapter = new ProcessRuntimeAdapter(runner);
    const handle = await adapter.spawn({
      prompt: "do work",
      cwd: "/tmp",
      sessionId: "session",
      sessionPath: "/tmp/session.jsonl",
    });
    expect(runner.startedArgs).toEqual(["--mode", "rpc", "--session", "/tmp/session.jsonl"]);
    expect(JSON.parse(runner.startedInput!)).toMatchObject({ type: "prompt", message: "do work" });
    runner.identity = "reused pid";
    expect(await adapter.stop(handle)).toBe(false);
    expect(runner.signalled).toBe(false);
    runner.identity = "start pi";
    expect(await adapter.stop(handle)).toBe(true);
    expect(runner.signalled).toBe(true);
  });
  it("uses verified tmux pane identity for cleanup", async () => {
    const calls: string[][] = [];
    const runner = new FakeRunner();
    runner.exec = async (_command, args) => {
      calls.push(args);
      return { stdout: args[0] === "list-panes" ? "%7|pi launch" : "pi launch" };
    };
    const adapter = new TmuxRuntimeAdapter(runner);
    const handle = await adapter.spawn({
      prompt: "work",
      cwd: "/tmp",
      sessionId: "session",
      sessionPath: "/tmp/session.jsonl",
    });
    expect(handle).toEqual({ adapter: "tmux", handle: "%7", identity: "pi launch" });
    expect(await adapter.stop(handle)).toBe(true);
    expect(calls.at(-1)).toEqual(["kill-pane", "-t", "%7"]);
  });
  it("rolls back a Herdr pane when launch verification fails", async () => {
    const calls: string[][] = [];
    const runner = new FakeRunner();
    runner.exec = async (_command, args) => {
      calls.push(args);
      if (args.includes("create"))
        return { stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p2" } } }) };
      if (args.includes("run")) throw new Error("launch failed");
      return { stdout: "{}" };
    };
    const adapter = new HerdrRuntimeAdapter(runner, "workers");
    await expect(
      adapter.spawn({
        prompt: "work",
        cwd: "/tmp",
        sessionId: "session",
        sessionPath: "/tmp/session.jsonl",
      }),
    ).rejects.toThrow("launch failed");
    expect(calls.at(-1)).toEqual(["--session", "workers", "pane", "close", "w1:p2"]);
  });
  it("uses Herdr pane and launched PID as its safe handle generation", async () => {
    const calls: string[][] = [];
    const runner = new FakeRunner();
    runner.exec = async (_command, args) => {
      calls.push(args);
      if (args.includes("create"))
        return { stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p2" } } }) };
      if (args.includes("process-info"))
        return { stdout: JSON.stringify({ result: { process_info: { foreground_pid: 77 } } }) };
      return { stdout: "{}" };
    };
    const adapter = new HerdrRuntimeAdapter(runner, "workers");
    const handle = await adapter.spawn({
      prompt: "don't stop",
      cwd: "/tmp",
      sessionId: "session",
      sessionPath: "/tmp/session.jsonl",
    });
    expect(handle).toEqual({ adapter: "herdr", handle: "w1:p2", identity: "77|start pi" });
    expect(await adapter.stop(handle)).toBe(true);
    expect(calls.at(-1)).toEqual(["--session", "workers", "pane", "close", "w1:p2"]);
  });
});
