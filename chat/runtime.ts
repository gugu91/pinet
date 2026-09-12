import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type SpawnSpec = { prompt: string; cwd: string; sessionId: string; sessionPath?: string };
export type RuntimeHandle = {
  adapter: "process" | "tmux" | "herdr";
  handle: string;
  identity: string;
};
export interface RuntimeAdapter {
  spawn(spec: SpawnSpec): Promise<RuntimeHandle>;
  stop(handle: RuntimeHandle): Promise<boolean>;
  isAlive(handle: RuntimeHandle): Promise<boolean>;
}
export interface CommandRunner {
  start(command: string, args: string[], cwd: string): Promise<{ pid: number; identity: string }>;
  exec(command: string, args: string[]): Promise<{ stdout: string }>;
  signal(pid: number, signal: NodeJS.Signals): Promise<void>;
  processIdentity(pid: number): Promise<string | undefined>;
}

const exec = promisify(execFile);
export class NodeCommandRunner implements CommandRunner {
  async start(
    command: string,
    args: string[],
    cwd: string,
  ): Promise<{ pid: number; identity: string }> {
    const child = spawn(command, args, { cwd, detached: true, stdio: "ignore" });
    child.unref();
    if (!child.pid) throw new Error("runtime process did not return a PID");
    const identity = await this.processIdentity(child.pid);
    if (!identity) throw new Error("runtime process exited before identity verification");
    return { pid: child.pid, identity };
  }
  async exec(command: string, args: string[]): Promise<{ stdout: string }> {
    const result = await exec(command, args);
    return { stdout: result.stdout };
  }
  async signal(pid: number, signal: NodeJS.Signals): Promise<void> {
    process.kill(pid, signal);
  }
  async processIdentity(pid: number): Promise<string | undefined> {
    try {
      const result = await exec("ps", ["-o", "lstart=,command=", "-p", String(pid)]);
      return result.stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }
}

export class ProcessRuntimeAdapter implements RuntimeAdapter {
  constructor(
    private readonly runner: CommandRunner = new NodeCommandRunner(),
    private readonly executable = "pi",
  ) {}
  async spawn(spec: SpawnSpec): Promise<RuntimeHandle> {
    const result = await this.runner.start(
      this.executable,
      ["--session-id", spec.sessionId, spec.prompt],
      spec.cwd,
    );
    return { adapter: "process", handle: String(result.pid), identity: result.identity };
  }
  async isAlive(handle: RuntimeHandle): Promise<boolean> {
    const current = await this.runner.processIdentity(Number(handle.handle));
    return current === handle.identity;
  }
  async stop(handle: RuntimeHandle): Promise<boolean> {
    if (!(await this.isAlive(handle))) return false;
    await this.runner.signal(Number(handle.handle), "SIGTERM");
    return true;
  }
}

export class TmuxRuntimeAdapter implements RuntimeAdapter {
  constructor(private readonly runner: CommandRunner = new NodeCommandRunner()) {}
  async spawn(spec: SpawnSpec): Promise<RuntimeHandle> {
    const name = `pinet-${spec.sessionId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    await this.runner.exec("tmux", [
      "new-session",
      "-d",
      "-s",
      name,
      "-c",
      spec.cwd,
      "pi",
      "--session-id",
      spec.sessionId,
      spec.prompt,
    ]);
    const pane = (
      await this.runner.exec("tmux", [
        "list-panes",
        "-t",
        name,
        "-F",
        "#{pane_id}|#{pane_start_command}",
      ])
    ).stdout.trim();
    if (!pane) throw new Error("tmux did not report the launched pane");
    const [handle, identity] = pane.split("|", 2);
    return { adapter: "tmux", handle: handle!, identity: identity! };
  }
  async isAlive(handle: RuntimeHandle): Promise<boolean> {
    try {
      const current = (
        await this.runner.exec("tmux", [
          "display-message",
          "-p",
          "-t",
          handle.handle,
          "#{pane_start_command}",
        ])
      ).stdout.trim();
      return current === handle.identity;
    } catch {
      return false;
    }
  }
  async stop(handle: RuntimeHandle): Promise<boolean> {
    if (!(await this.isAlive(handle))) return false;
    await this.runner.exec("tmux", ["kill-pane", "-t", handle.handle]);
    return true;
  }
}

export class HerdrRuntimeAdapter implements RuntimeAdapter {
  constructor(
    private readonly runner: CommandRunner = new NodeCommandRunner(),
    private readonly session = "pinet-workers",
  ) {}
  async spawn(spec: SpawnSpec): Promise<RuntimeHandle> {
    const created = await this.runner.exec("herdr", [
      "--session",
      this.session,
      "workspace",
      "create",
      "--cwd",
      spec.cwd,
      "--label",
      `pinet-${spec.sessionId}`,
      "--no-focus",
    ]);
    const payload = JSON.parse(created.stdout) as { result?: { root_pane?: { pane_id?: string } } };
    const pane = payload.result?.root_pane?.pane_id;
    if (!pane) throw new Error("Herdr workspace create returned no pane ID");
    const identity = await this.paneIdentity(pane);
    if (!identity) throw new Error("Herdr pane returned no shell PID");
    const quotedPrompt = `'${spec.prompt.replaceAll("'", "'\\''")}'`;
    await this.runner.exec("herdr", [
      "--session",
      this.session,
      "pane",
      "run",
      pane,
      `pi --session-id ${spec.sessionId} ${quotedPrompt}`,
    ]);
    return { adapter: "herdr", handle: pane, identity };
  }
  private async paneIdentity(pane: string): Promise<string | undefined> {
    try {
      const output = await this.runner.exec("herdr", [
        "--session",
        this.session,
        "pane",
        "process-info",
        "--pane",
        pane,
      ]);
      const payload = JSON.parse(output.stdout) as {
        result?: { process_info?: { shell_pid?: number } };
      };
      const pid = payload.result?.process_info?.shell_pid;
      return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? String(pid) : undefined;
    } catch {
      return undefined;
    }
  }
  async isAlive(handle: RuntimeHandle): Promise<boolean> {
    return (await this.paneIdentity(handle.handle)) === handle.identity;
  }
  async stop(handle: RuntimeHandle): Promise<boolean> {
    if (!(await this.isAlive(handle))) return false;
    await this.runner.exec("herdr", ["--session", this.session, "pane", "close", handle.handle]);
    return true;
  }
}
