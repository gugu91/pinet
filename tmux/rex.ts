import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isatty } from "node:tty";
import { safeName, type PaneStatus } from "./helpers.ts";
import { Tmux } from "./transport.ts";

export const CLIENT_FORMAT =
  "#{client_pid}\t#{client_tty}\t#{client_created}\t#{session_id}\t#{client_control_mode}\t#{client_flags}\t#{session_name}";
export interface Client {
  pid: number;
  tty: string;
  created: string;
  session: string;
  name: string;
}
export function parseClients(text: string): Client[] {
  return text.split("\n").flatMap((line) => {
    const [pid, tty, created, session, control, flags, ...name] = line.split("\t");
    if (
      !/^[1-9]\d*$/.test(pid) ||
      !/^\/dev\/(?:ttys\d+|pts\/\d+)$/.test(tty ?? "") ||
      !/^\d+$/.test(created ?? "") ||
      !/^\$\d+$/.test(session ?? "") ||
      control !== "0" ||
      flags?.includes("suspended")
    )
      return [];
    return [
      {
        pid: Number(pid),
        tty,
        created,
        session,
        name: safeName(name.join(" ")),
      },
    ];
  });
}
const ID = "pi-tmux";
export const CLEAR = `\x1b]7501;state=clear:id=${ID}\x1b\\`;
export function report(panes: PaneStatus[], sessionName: string): string {
  const unique = [...new Map(panes.map((pane) => [pane.pane, pane])).values()];
  if (!unique.length) return CLEAR;
  const state = unique.some((p) => p.record.state === "blocked")
    ? "blocked"
    : unique.some((p) => p.record.state === "error" && p.record.unread)
      ? "error"
      : unique.some((p) => p.record.state === "working" || p.record.state === "compacting")
        ? "working"
        : unique.some((p) => p.record.state === "done" && p.record.unread)
          ? "done"
          : "idle";
  const counts = ["blocked", "error", "compacting", "working", "done", "idle"]
    .map((s) => {
      const count = unique.filter((p) => p.record.state === s).length;
      return count ? `${count} ${s}` : "";
    })
    .filter(Boolean)
    .join(", ");
  const message =
    unique.length === 1
      ? `${safeName(unique[0].name || "Pi")}: ${counts}`
      : `${unique.length} Pi panes: ${counts}`;
  const title = Buffer.from(`Pi in ${safeName(sessionName)}`).toString("base64");
  const msg = Buffer.from(message).toString("base64");
  return `\x1b]7501;state=${state}:id=${ID}:app=tmux:title=${title}:msg=${msg}\x1b\\`;
}

// Writes to the attached client's *outer* terminal, not a pane PTY. No tmux DCS
// wrapper or allow-passthrough is needed on this side of the multiplexer.
export async function writeTerminal(client: Client, frame: string): Promise<void> {
  const file = await open(
    client.tty,
    constants.O_WRONLY | constants.O_NOCTTY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (!stat.isCharacterDevice() || !isatty(file.fd) || stat.uid !== process.getuid?.()) {
      throw new Error("Refusing non-owned/non-terminal output target");
    }
    const buffer = Buffer.from(frame);
    const result = await file.write(buffer);
    if (result.bytesWritten !== buffer.length) throw new Error("Incomplete terminal report");
  } finally {
    await file.close();
  }
}

export interface RelayTransport {
  run(args: string[]): Promise<string>;
  snapshot(target: string, scope: "session"): Promise<PaneStatus[]>;
}
export async function relay(
  tmux: RelayTransport,
  pid: number,
  mode: "on" | "off" | "tick" | "preview",
  write: (client: Client, frame: string) => Promise<void> = writeTerminal,
): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid client PID");
  const format = CLIENT_FORMAT;
  const clients = async () => parseClients(await tmux.run(["list-clients", "-F", format]));
  const client = (await clients()).find((c) => c.pid === pid);
  if (!client) throw new Error("No eligible attached terminal client");
  const enabledKey = `@pi_rex_enabled_${pid}`;
  const sentKey = `@pi_rex_sent_${pid}`;
  const identity = `${client.created}:${client.tty}`;
  const enabled = await tmux.run(["show-options", "-sqv", enabledKey]);
  if (mode === "off") {
    await tmux.run(["set-option", "-su", enabledKey]);
    if (enabled === identity) await write(client, CLEAR);
    await tmux.run(["set-option", "-su", sentKey]);
    return "Rex relay disabled";
  }
  if (mode === "on") await tmux.run(["set-option", "-s", enabledKey, identity]);
  else if (mode === "tick" && enabled !== identity) return "";
  const frame = report(await tmux.snapshot(client.session, "session"), client.name);
  if (mode === "preview")
    return JSON.stringify({ session: client.session, tty: client.tty, frame });
  const signature = Buffer.from(`${identity}\n${client.session}\n${frame}`).toString("base64");
  const previous = await tmux.run(["show-options", "-sqv", sentKey]);
  if (mode !== "on" && previous === signature) return "";
  const current = (await clients()).find((c) => c.pid === pid);
  if (
    !current ||
    current.tty !== client.tty ||
    current.created !== client.created ||
    current.session !== client.session
  )
    return "";
  if ((await tmux.run(["show-options", "-sqv", enabledKey])) !== identity) return "";
  await write(client, frame);
  await tmux.run(["set-option", "-s", sentKey, signature]);
  return mode === "on" ? "Rex relay enabled for this attached client" : "";
}

export async function runRelay(args: string[]): Promise<void> {
  const [socket, pid, mode] = args;
  if (
    !socket ||
    !pid ||
    !/^[1-9]\d*$/.test(pid) ||
    !["on", "off", "tick", "preview"].includes(mode)
  ) {
    throw new Error("Usage: node rex-cli.ts SOCKET CLIENT_PID on|off|tick|preview");
  }
  const output = await relay(
    new Tmux(socket),
    Number(pid),
    mode as "on" | "off" | "tick" | "preview",
  );
  if (output) console.log(output);
}
