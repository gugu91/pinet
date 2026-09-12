import { execFile, spawn } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export type SpawnSpec = {
  prompt: string;
  cwd: string;
  sessionId: string;
  sessionPath: string;
  env: Record<string, string>;
};
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
  start(
    command: string,
    args: string[],
    cwd: string,
    input?: string,
    env?: Record<string, string>,
  ): Promise<{ pid: number; identity: string }>;
  exec(command: string, args: string[]): Promise<{ stdout: string }>;
  signal(pid: number, signal: NodeJS.Signals): Promise<void>;
  processIdentity(pid: number): Promise<string | undefined>;
  processCommand(pid: number): Promise<string | undefined>;
}

const exec = promisify(execFile);
export class NodeCommandRunner implements CommandRunner {
  async start(
    command: string,
    args: string[],
    cwd: string,
    input?: string,
    env?: Record<string, string>,
  ): Promise<{ pid: number; identity: string }> {
    const inherited = { ...process.env };
    delete inherited.PINET_HOST_TOKEN;
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...inherited, ...env },
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (!child.pid) throw new Error("runtime process did not return a PID");
    child.stdin.on("error", () => {});
    if (input)
      await new Promise<void>((resolve, reject) =>
        child.stdin.write(`${input}\n`, (error) => (error ? reject(error) : resolve())),
      ).catch((error) => {
        child.kill("SIGTERM");
        throw error;
      });
    const identity = await this.processIdentity(child.pid);
    if (!identity) {
      child.kill("SIGTERM");
      throw new Error("runtime process exited before identity verification");
    }
    child.unref();
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
      const result = await exec("ps", ["-o", "lstart=", "-p", String(pid)]);
      return result.stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }
  async processCommand(pid: number): Promise<string | undefined> {
    try {
      const result = await exec("ps", ["-o", "command=", "-p", String(pid)]);
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
      ["--mode", "rpc", "--session", spec.sessionPath],
      spec.cwd,
      JSON.stringify({ id: `pinet-${spec.sessionId}`, type: "prompt", message: spec.prompt }),
      spec.env,
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

async function waitForPiIdentity(
  runner: CommandRunner,
  readPid: () => Promise<number | undefined>,
  sessionPath: string,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const pid = await readPid();
    if (pid) {
      const [generation, command] = await Promise.all([
        runner.processIdentity(pid),
        runner.processCommand(pid),
      ]);
      if (generation && command?.includes(sessionPath)) return `${pid}|${generation}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
}

async function createLauncher(spec: SpawnSpec): Promise<string> {
  const path = join(spec.sessionPath.replace(/\.jsonl$/, ""), "..", `${spec.sessionId}.launch.sh`);
  const environment = Object.entries(spec.env)
    .map(([key, value]) => `export ${key}='${value.replaceAll("'", "'\\''")}'`)
    .join("\n");
  const quotedPrompt = `'${spec.prompt.replaceAll("'", "'\\''")}'`;
  const quotedPath = `'${spec.sessionPath.replaceAll("'", "'\\''")}'`;
  await writeFile(
    path,
    `#!/bin/sh\nunset PINET_HOST_TOKEN\n${environment}\nexec pi --session ${quotedPath} ${quotedPrompt}\n`,
    { mode: 0o700 },
  );
  return path;
}

export class TmuxRuntimeAdapter implements RuntimeAdapter {
  constructor(private readonly runner: CommandRunner = new NodeCommandRunner()) {}
  async spawn(spec: SpawnSpec): Promise<RuntimeHandle> {
    const name = `pinet-${spec.sessionId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const launcher = await createLauncher(spec);
    try {
      await this.runner.exec("tmux", ["new-session", "-d", "-s", name, "-c", spec.cwd, launcher]);
      const pane = (
        await this.runner.exec("tmux", ["list-panes", "-t", name, "-F", "#{pane_id}|#{pane_pid}"])
      ).stdout.trim();
      if (!pane) throw new Error("tmux did not report the launched pane");
      const [handle] = pane.split("|", 1);
      if (!handle) throw new Error("tmux returned incomplete pane identity");
      const identity = await waitForPiIdentity(
        this.runner,
        async () => {
          const value = (
            await this.runner.exec("tmux", ["display-message", "-p", "-t", handle, "#{pane_pid}"])
          ).stdout.trim();
          return /^\d+$/.test(value) ? Number(value) : undefined;
        },
        spec.sessionPath,
      );
      if (!identity) throw new Error("tmux Pi process did not become ready");
      await unlink(launcher);
      return { adapter: "tmux", handle, identity };
    } catch (error) {
      await this.runner.exec("tmux", ["kill-session", "-t", name]).catch(() => ({ stdout: "" }));
      await unlink(launcher).catch(() => {});
      throw error;
    }
  }
  async isAlive(handle: RuntimeHandle): Promise<boolean> {
    try {
      const pid = (
        await this.runner.exec("tmux", [
          "display-message",
          "-p",
          "-t",
          handle.handle,
          "#{pane_pid}",
        ])
      ).stdout.trim();
      const [expectedPid, expectedIdentity] = handle.identity.split("|", 2);
      return (
        pid === expectedPid && (await this.runner.processIdentity(Number(pid))) === expectedIdentity
      );
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
    const launcher = await createLauncher(spec);
    try {
      await this.runner.exec("herdr", ["--session", this.session, "pane", "run", pane, launcher]);
      const identity = await waitForPiIdentity(
        this.runner,
        () => this.panePid(pane),
        spec.sessionPath,
      );
      if (!identity) throw new Error("Herdr Pi process did not become ready");
      await unlink(launcher);
      return { adapter: "herdr", handle: pane, identity };
    } catch (error) {
      await this.runner
        .exec("herdr", ["--session", this.session, "pane", "close", pane])
        .catch(() => ({ stdout: "" }));
      await unlink(launcher).catch(() => {});
      throw error;
    }
  }
  private async panePid(pane: string): Promise<number | undefined> {
    const output = await this.runner.exec("herdr", [
      "--session",
      this.session,
      "pane",
      "process-info",
      "--pane",
      pane,
    ]);
    const payload = JSON.parse(output.stdout) as {
      result?: { process_info?: { foreground_pid?: number } };
    };
    const pid = payload.result?.process_info?.foreground_pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  }
  async isAlive(handle: RuntimeHandle): Promise<boolean> {
    try {
      const pid = await this.panePid(handle.handle);
      const [expectedPid, generation] = handle.identity.split("|", 2);
      return Boolean(
        pid &&
        String(pid) === expectedPid &&
        (await this.runner.processIdentity(pid)) === generation,
      );
    } catch {
      return false;
    }
  }
  async stop(handle: RuntimeHandle): Promise<boolean> {
    if (!(await this.isAlive(handle))) return false;
    await this.runner.exec("herdr", ["--session", this.session, "pane", "close", handle.handle]);
    return true;
  }
}
