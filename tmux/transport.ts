import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { encode, parseRecord, type PaneRecord, type PaneStatus } from "./helpers.ts";
const exec = promisify(execFile);
export const OPTION = "@pi_rollup";
export const OWNER = "@pi_rollup_owner";
export const NAME = "@pi_rollup_name";
export const ATTENTION = "@pi_rollup_attention";
export const ACK = "@pi_rollup_ack";
export const STATE = "@pi_state";
export const DISPLAY_NAME = "@pi_name";
export const UNREAD = "@pi_unread";
export const FOCUS_HOOK = `if-shell -F '#{!=:#{${OWNER}},}' "set-option -p -F ${ACK} '#{${ATTENTION}}' ; set-option -p ${UNREAD} 0"`;
export function quoteTmuxValue(text: string): string {
  return JSON.stringify(text).replaceAll("$", "\\$");
}
export interface Metadata {
  name: string;
  attention: string;
}

/** Start-time text is localized; publisher and queries may run under different locales/zones. */
function psEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: "C", TZ: "UTC" };
}
export async function processIdentity(pid: number): Promise<string> {
  const { stdout } = await exec("ps", ["-p", String(pid), "-o", "lstart="], {
    timeout: 2000,
    env: psEnvironment(),
  });
  if (!stdout.trim()) throw new Error("Process start time unavailable");
  return Buffer.from(stdout.trim()).toString("base64");
}
export function decodeOutput(text: string, escapedDollars: boolean): string {
  const value = text.replace(/\n$/, "");
  // tmux <=3.4 inserts one slash before dollars followed by a letter, underscore or brace.
  return escapedDollars ? value.replace(/\\\$(?=[A-Za-z_{])/g, "$") : value;
}
export class Tmux {
  private prefix: string[];
  private escapedDollars: boolean | undefined;
  constructor(socket?: string) {
    this.prefix = socket ? ["-S", socket] : [];
  }
  async run(args: string[]): Promise<string> {
    const { stdout } = await exec("tmux", [...this.prefix, ...args], {
      timeout: 2000,
      maxBuffer: 1024 * 1024,
    });
    if (this.escapedDollars === undefined && stdout.includes("$")) {
      const probe = await exec(
        "tmux",
        [...this.prefix, "display-message", "-p", "#{l:$PI_TMUX_PROBE}"],
        { timeout: 2000 },
      );
      this.escapedDollars = probe.stdout.startsWith("\\$PI_TMUX_PROBE");
    }
    return decodeOutput(stdout, this.escapedDollars === true);
  }
  async claim(
    pane: string,
    record: PaneRecord,
    metadata: Metadata = { name: "Pi", attention: record.owner },
  ): Promise<void> {
    if (!/^%\d+$/.test(pane)) throw new Error("Invalid tmux pane ID");
    await this.run([
      "set-option",
      "-p",
      "-t",
      pane,
      OWNER,
      record.owner,
      ";",
      "set-option",
      "-p",
      "-t",
      pane,
      OPTION,
      encode(record),
      ";",
      "set-option",
      "-p",
      "-t",
      pane,
      NAME,
      Buffer.from(metadata.name).toString("base64"),
      ";",
      "set-option",
      "-p",
      "-t",
      pane,
      ATTENTION,
      metadata.attention,
      ";",
      "set-option",
      "-p",
      "-t",
      pane,
      STATE,
      record.state,
      ";",
      "set-option",
      "-p",
      "-t",
      pane,
      DISPLAY_NAME,
      // A trailing ";" in an argv element is tmux's command separator; "\\;" is its literal escape.
      metadata.name.replace(/;$/, "\\;"),
      ";",
      "set-option",
      "-p",
      "-t",
      pane,
      UNREAD,
      record.unread ? "1" : "0",
    ]);
  }
  async publish(
    pane: string,
    record: PaneRecord,
    metadata: Metadata = { name: "Pi", attention: record.owner },
  ): Promise<boolean> {
    const result = await this.run([
      "if-shell",
      "-F",
      "-t",
      pane,
      `#{==:#{${OWNER}},${record.owner}}`,
      `set-option -p -t ${pane} ${OPTION} '${encode(record)}' ; set-option -p -t ${pane} ${NAME} '${Buffer.from(metadata.name).toString("base64")}' ; set-option -p -t ${pane} ${ATTENTION} '${metadata.attention}' ; set-option -p -t ${pane} ${STATE} ${record.state} ; set-option -p -t ${pane} ${DISPLAY_NAME} ${quoteTmuxValue(metadata.name)} ; set-option -p -F -t ${pane} ${UNREAD} '${record.unread ? `#{?#{==:#{${ACK}},${metadata.attention}},0,1}` : "0"}' ; display-message -p published`,
    ]);
    return result === "published";
  }
  async release(pane: string, owner: string): Promise<void> {
    await this.run([
      "if-shell",
      "-F",
      "-t",
      pane,
      `#{==:#{${OWNER}},${owner}}`,
      [OPTION, OWNER, NAME, ATTENTION, ACK, STATE, DISPLAY_NAME, UNREAD]
        .map((option) => `set-option -pu -t ${pane} ${option}`)
        .join(" ; "),
    ]);
  }
  async snapshot(target: string, scope: "session" | "window" = "session"): Promise<PaneStatus[]> {
    // Explicit target: a status-right command must use its client's session, not the server's latest client.
    const rows = await this.run([
      "list-panes",
      ...(scope === "session" ? ["-s"] : []),
      "-t",
      target,
      "-F",
      `#{pane_id}\t#{window_id}\t#{${OPTION}}\t#{${OWNER}}\t#{${NAME}}\t#{pane_active}\t#{${ATTENTION}}\t#{${ACK}}`,
    ]);
    const candidates: PaneStatus[] = [];
    for (const row of rows.split("\n")) {
      const [pane, window, text = "", owner, encodedName = "", active, attention, ack] =
        row.split("\t");
      const record = parseRecord(text);
      if (record && record.owner === owner) {
        if (attention && attention === ack) record.unread = false;
        const name = /^[A-Za-z0-9+/=]{0,2048}$/.test(encodedName)
          ? Buffer.from(encodedName, "base64").toString("utf8")
          : "Pi";
        candidates.push({ pane, window, record, name, active: active === "1" });
      }
    }
    if (!candidates.length) return [];
    // Batch liveness check; matching start time also rejects a recycled PID. Do not mutate stale records here.
    const { stdout } = await exec("ps", ["-axo", "pid=,lstart="], {
      timeout: 2000,
      env: psEnvironment(),
      maxBuffer: 4 * 1024 * 1024,
    });
    const processes = new Map<number, string>();
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (match) processes.set(Number(match[1]), Buffer.from(match[2]).toString("base64"));
    }
    return candidates.filter(({ record }) => processes.get(record.pid) === record.started);
  }
}
