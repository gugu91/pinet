import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { getProcessStartTime } from "./broker/leader.js";
import { readJoinProfile, joinIdentity } from "./join-profile.js";

export type RuntimeKind = "shell" | "tmux" | "rex";
export interface RuntimeHandle {
  version: 1;
  kind: RuntimeKind;
  id: string;
  host: string;
  workerStableId: string;
  cwd: string;
  directory: string;
  pid: number | null;
  processStartTime: string | null;
}
export interface RuntimeStart {
  cwd: string;
  profilePath: string;
  command: string[];
}
export interface RuntimeAdapter {
  start(input: RuntimeStart): Promise<RuntimeHandle>;
  /** Throws on backpressure or partial delivery; partial input requires stream recovery, not a full retry. */
  send(handle: RuntimeHandle, text: string): void;
  read(handle: RuntimeHandle): string;
  status(handle: RuntimeHandle): "running" | "stopped";
  stop(handle: RuntimeHandle): void;
  attachCommand(handle: RuntimeHandle): string[] | null;
}

// agent-default (not a user rule): retain at most 128 KiB in a read response.
const READ_BYTES = 128 * 1024;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function runtimeAvailability(): RuntimeKind[] {
  const found: RuntimeKind[] = ["shell"];
  for (const runtime of ["tmux", "rex"] as const) {
    // Detect binaries without contacting or autostarting runtime servers.
    try {
      execFileSync("/bin/sh", ["-c", `command -v ${runtime}`], { stdio: "ignore" });
      found.push(runtime);
    } catch {
      /* unavailable binary */
    }
  }
  return found;
}

export function hostReport(repos: string[], capacity: number) {
  const worktrees = [
    ...new Set(
      repos.flatMap((repo) => {
        try {
          return execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          })
            .split("\n")
            .filter((line) => line.startsWith("worktree "))
            .map((line) => line.slice(9));
        } catch {
          return [];
        }
      }),
    ),
  ];
  return {
    hostname: os.hostname(),
    repos,
    worktrees,
    runtimes: runtimeAvailability(),
    capacity,
    health: {
      status: "ready",
      reportedAt: new Date().toISOString(),
      loadAverage: os.loadavg(),
      freeMemoryBytes: os.freemem(),
    },
  };
}

/** Local operator API only; no remote command-execution RPC. Owns only handles it creates. */
export class HostRunner {
  constructor(
    private readonly root: string,
    private readonly capacity = 1,
  ) {
    this.root = path.resolve(root);
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new Error("Host capacity must be a positive integer");
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.root = fs.realpathSync(this.root);
    const stat = fs.lstatSync(this.root);
    if (
      !stat.isDirectory() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Host runner directory must be owner-only (chmod 700).");
  }

  adapter(kind: RuntimeKind): RuntimeAdapter {
    return {
      start: (input) => this.start(kind, input),
      send: (handle, text) => this.send(handle, text),
      read: (handle) => this.read(handle),
      status: (handle) => this.status(handle),
      stop: (handle) => this.stop(handle),
      attachCommand: (handle) => this.attachCommand(handle),
    };
  }

  report(repos: string[]) {
    return hostReport(repos, this.capacity);
  }

  async start(kind: RuntimeKind, input: RuntimeStart): Promise<RuntimeHandle> {
    const lock = path.join(this.root, ".start.lock");
    const fd = fs.openSync(lock, "wx", 0o600);
    fs.writeSync(fd, String(process.pid));
    try {
      return await this.startLocked(kind, input);
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  }

  private async startLocked(kind: RuntimeKind, input: RuntimeStart): Promise<RuntimeHandle> {
    const profile = readJoinProfile(input.profilePath);
    const cwd = fs.realpathSync(input.cwd);
    if (
      !profile.repos.some((repo) => {
        const relative = path.relative(fs.realpathSync(repo), cwd);
        return (
          relative === "" ||
          (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
        );
      })
    )
      throw new Error("Worker cwd is outside its profile's repository allowlist.");
    if (!input.command.length) throw new Error("Worker command is required");
    const live = this.handles().filter((h) => this.status(h) === "running");
    if (live.length >= this.capacity) throw new Error("Host runner capacity reached");
    const stableId = joinIdentity(profile);
    if (live.some((h) => h.workerStableId === stableId))
      throw new Error("Worker identity already running");
    const localId = `pinet-${randomUUID()}`;
    const directory = path.join(this.root, localId);
    fs.mkdirSync(directory, { mode: 0o700 });
    const script = path.join(directory, "launch.sh");
    const handle: RuntimeHandle = {
      version: 1,
      kind,
      id: localId,
      host: os.hostname(),
      workerStableId: stableId,
      cwd,
      directory,
      pid: null,
      processStartTime: null,
    };
    const command = input.command.map(quote).join(" ");
    const environment = [
      "unset SLACK_BOT_TOKEN SLACK_APP_TOKEN",
      `export PINET_JOIN_PROFILE=${quote(path.resolve(input.profilePath))}`,
      `export PINET_RUNTIME_KIND=${quote(kind)}`,
      `export PINET_RUNTIME_HANDLE=${quote(directory)}`,
      `export PINET_HOST_CAPACITY=${this.capacity}`,
    ].join("\n");
    fs.writeFileSync(
      script,
      `#!/bin/sh\n${environment}\ncd ${quote(cwd)}\n${kind === "shell" ? `exec 3<>${quote(path.join(directory, "input"))}\nexec ${command} <&3\n` : `exec ${command}\n`}`,
      { mode: 0o700, flag: "wx" },
    );
    let launched = false;
    try {
      if (kind === "shell") {
        execFileSync("mkfifo", ["-m", "600", path.join(directory, "input")]);
        const log = fs.openSync(path.join(directory, "output"), "a", 0o600);
        try {
          const child = spawn("/bin/sh", [script], {
            cwd,
            detached: true,
            stdio: ["ignore", log, log],
          });
          await new Promise<void>((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", reject);
          });
          handle.pid = child.pid!;
          handle.processStartTime = getProcessStartTime(child.pid!);
          if (!handle.processStartTime) {
            child.kill("SIGTERM");
            throw new Error("Cannot establish shell process identity; launch stopped.");
          }
          child.unref();
        } finally {
          fs.closeSync(log);
        }
      } else if (kind === "tmux") {
        execFileSync("tmux", [
          "-S",
          path.join(this.root, "tmux.sock"),
          "new-session",
          "-d",
          "-s",
          localId,
          "-c",
          cwd,
          `/bin/sh ${quote(script)}`,
        ]);
      } else {
        const result = JSON.parse(
          execFileSync(
            "rex",
            [
              "run",
              "--focus=false",
              "--shell=none",
              "--json",
              "--cwd",
              cwd,
              "--",
              "/bin/sh",
              script,
            ],
            { encoding: "utf8" },
          ),
        ) as { block_ids?: string[] };
        if (
          !Array.isArray(result.block_ids) ||
          result.block_ids.length !== 1 ||
          typeof result.block_ids[0] !== "string" ||
          !result.block_ids[0].startsWith("block:")
        )
          throw new Error("Rex returned no unique block handle");
        handle.id = result.block_ids[0];
      }
      launched = true;
      fs.writeFileSync(
        path.join(directory, "handle.json"),
        JSON.stringify(handle, null, 2) + "\n",
        { mode: 0o600, flag: "wx" },
      );
      return handle;
    } catch (error) {
      if (launched) {
        try {
          this.stopOwnedRuntime(handle);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `Launch failed and ${kind} runtime ${handle.id} could not be stopped; retained ${directory} for recovery.`,
          );
        }
      }
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  handles(): RuntimeHandle[] {
    return fs
      .readdirSync(this.root)
      .filter((name) => name.startsWith("pinet-"))
      .flatMap((name) => {
        const filename = path.join(this.root, name, "handle.json");
        if (!fs.existsSync(filename))
          throw new Error(
            `Incomplete runtime record at ${filename}; recover the owned runtime before starting another.`,
          );
        return [this.load(filename)];
      });
  }

  load(filename: string): RuntimeHandle {
    const handle = JSON.parse(fs.readFileSync(filename, "utf8")) as RuntimeHandle;
    if (
      handle.version !== 1 ||
      !["shell", "tmux", "rex"].includes(handle.kind) ||
      typeof handle.id !== "string" ||
      typeof handle.directory !== "string" ||
      typeof handle.host !== "string" ||
      handle.host !== os.hostname()
    )
      throw new Error("Invalid local runtime handle");
    if (
      path.dirname(handle.directory) !== path.resolve(this.root) ||
      fs.realpathSync(handle.directory) !== handle.directory
    )
      throw new Error("Runtime handle is outside this runner");
    return handle;
  }

  private checked(handle: RuntimeHandle): RuntimeHandle {
    return this.load(path.join(handle.directory, "handle.json"));
  }

  status(input: RuntimeHandle): "running" | "stopped" {
    const handle = this.checked(input);
    if (handle.kind === "shell")
      return handle.pid &&
        handle.processStartTime &&
        getProcessStartTime(handle.pid) === handle.processStartTime
        ? "running"
        : "stopped";
    try {
      if (handle.kind === "tmux")
        execFileSync(
          "tmux",
          ["-S", path.join(this.root, "tmux.sock"), "has-session", "-t", handle.id],
          { stdio: "ignore" },
        );
      else execFileSync("rex", ["block", "inspect", handle.id], { stdio: "ignore" });
      return "running";
    } catch {
      return "stopped";
    }
  }

  send(input: RuntimeHandle, text: string): void {
    const handle = this.checked(input);
    if (this.status(handle) !== "running") throw new Error("Runtime is not running");
    if (handle.kind === "shell") {
      const fd = fs.openSync(
        path.join(handle.directory, "input"),
        fs.constants.O_WRONLY | fs.constants.O_NONBLOCK,
      );
      try {
        const input = Buffer.from(text, "utf8");
        const written = fs.writeSync(fd, input);
        if (written !== input.length) {
          throw new Error(
            `Incomplete shell input delivery: ${written}/${input.length} bytes written. Recover the input stream before retrying; do not resend the whole message.`,
          );
        }
      } finally {
        fs.closeSync(fd);
      }
    } else if (handle.kind === "tmux") {
      execFileSync("tmux", [
        "-S",
        path.join(this.root, "tmux.sock"),
        "send-keys",
        "-t",
        handle.id,
        "-l",
        "--",
        text,
      ]);
    } else execFileSync("rex", ["send", "-b", handle.id, "--", text]);
  }

  read(input: RuntimeHandle): string {
    const handle = this.checked(input);
    if (handle.kind === "shell") {
      const fd = fs.openSync(path.join(handle.directory, "output"), "r");
      try {
        const size = fs.fstatSync(fd).size;
        const buffer = Buffer.alloc(Math.min(size, READ_BYTES));
        fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - READ_BYTES));
        return buffer.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    }
    const output =
      handle.kind === "tmux"
        ? execFileSync(
            "tmux",
            ["-S", path.join(this.root, "tmux.sock"), "capture-pane", "-p", "-t", handle.id],
            { encoding: "utf8" },
          )
        : execFileSync("rex", ["capture", "-b", handle.id, "--trim"], { encoding: "utf8" });
    return output.slice(-READ_BYTES);
  }

  stop(input: RuntimeHandle): void {
    const handle = this.checked(input);
    if (this.status(handle) !== "running") return;
    this.stopOwnedRuntime(handle);
  }

  private stopOwnedRuntime(handle: RuntimeHandle): void {
    if (handle.kind === "shell") {
      if (
        handle.pid &&
        handle.processStartTime &&
        getProcessStartTime(handle.pid) === handle.processStartTime
      )
        process.kill(-handle.pid, "SIGTERM");
    } else if (handle.kind === "tmux")
      execFileSync("tmux", [
        "-S",
        path.join(this.root, "tmux.sock"),
        "kill-session",
        "-t",
        handle.id,
      ]);
    else execFileSync("rex", ["block", "close", handle.id]);
  }

  attachCommand(input: RuntimeHandle): string[] | null {
    const handle = this.checked(input);
    if (handle.kind === "shell") return null; // Pipe-backed processes have no terminal to attach.
    return handle.kind === "tmux"
      ? ["tmux", "-S", path.join(this.root, "tmux.sock"), "attach-session", "-t", handle.id]
      : ["rex", "block", "attach", handle.id];
  }
}
