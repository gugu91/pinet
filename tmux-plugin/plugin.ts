import { fileURLToPath } from "node:url";
import { FOCUS_HOOK, Tmux } from "../tmux/transport.ts";

export const HOOK = "pane-focus-in[1079]";
const SAVED_HOOK = "@pi_plugin_focus_hook";
const OPTIONS = [
  "status-left",
  "status-right",
  "window-status-format",
  "window-status-current-format",
];
/** Placeholders read options written by the single status job, so window formats start no processes. */
export const PLACEHOLDERS = {
  pi_state: "#{@pi_window_state}",
  pi_name: "#{@pi_window_name}",
  pi_unread: "#{?#{@pi_window_unread},#{@pi_window_unread},0}",
  pi_count: "#{?#{@pi_window_count},#{@pi_window_count},0}",
  pi_window_summary: "#{@pi_window_summary}",
  pi_session_summary: "#{@pi_session_summary}",
} as const;
/** Pre-#1095 expansions: one Node job per placeholder per window per tick. Rewritten on load. */
const LEGACY_JOBS = {
  pi_state: ["window", "state"],
  pi_name: ["window", "name"],
  pi_unread: ["window", "unread"],
  pi_count: ["window", "count"],
  pi_window_summary: ["window", "summary"],
  pi_session_summary: ["session", "summary"],
} as const;
export function shellQuote(text: string): string {
  if (text.includes("\n") || text.includes("\r") || text.includes("\0"))
    throw new Error("Unsupported executable/package path");
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}
/** Holds the shell-quoted node/query paths; jobs reference it so paths never reach tmux's format parser. */
export const QUERY = "@pi_query";
/**
 * The one job that refreshes every aggregate. It lives in status-right, outside the window list:
 * tmux keys jobs by window inside the list, but by client here, so it runs once per client per tick.
 * It prints nothing.
 */
export const PUBLISH_JOB = `#(#{${QUERY}} env publish)`;
export function expand(format: string): string {
  let result = format;
  for (const [placeholder, read] of Object.entries(PLACEHOLDERS)) {
    const [scope, mode] = LEGACY_JOBS[placeholder as keyof typeof LEGACY_JOBS];
    const target = scope === "window" ? "#{window_id}" : "#{session_id}";
    result = result
      .replaceAll(`#{${placeholder}}`, read)
      .replaceAll(`#(#{${QUERY}} env ${scope} '${target}' ${mode})`, read);
  }
  return result;
}
const READS = /#\{@pi_(?:window_[a-z]+|session_summary)\}/;
/** TPM adapter: only expand explicit placeholders; never choose/add a layout. */
export async function configure(
  tmux: Tmux,
  node: string,
  query: string,
  remove = false,
): Promise<void> {
  const current = await tmux.run(["show-hooks", "-g", HOOK]);
  const saved = await tmux.run(["show-options", "-gqv", SAVED_HOOK]);
  if (remove) {
    if (saved && saved === current) await tmux.run(["set-hook", "-gu", HOOK]);
    await tmux.run(["set-option", "-gu", SAVED_HOOK]);
    await tmux.run(["set-option", "-gu", QUERY]);
    const right = await tmux.run(["show-options", "-gqv", "status-right"]);
    if (right.includes(PUBLISH_JOB))
      await tmux.run(["set-option", "-g", "status-right", right.replaceAll(PUBLISH_JOB, "")]);
    return;
  }
  if (current.trim() !== HOOK && (!saved || saved !== current))
    throw new Error(`${HOOK} is occupied; refusing to replace another plugin's hook`);
  // Behavioral opt-in, not a UI preference. Other plugins may require it too; uninstall leaves it enabled.
  await tmux.run(["set-option", "-g", "focus-events", "on"]);
  await tmux.run(["set-hook", "-g", HOOK, FOCUS_HOOK]);
  await tmux.run(["set-option", "-g", SAVED_HOOK, await tmux.run(["show-hooks", "-g", HOOK])]);
  await tmux.run(["set-option", "-g", QUERY, `${shellQuote(node)} ${shellQuote(query)}`]);
  let used = false;
  for (const option of OPTIONS) {
    const original = await tmux.run(["show-options", "-gqv", option]);
    const replacement = expand(original);
    used ||= READS.test(replacement);
    if (replacement !== original) await tmux.run(["set-option", "-g", option, replacement]);
  }
  // Preserve window-local overrides, including their themes, and expand only their explicit tokens.
  const windows = await tmux.run(["list-windows", "-a", "-F", "#{window_id}"]);
  for (const window of new Set(windows.split("\n").filter(Boolean))) {
    for (const option of OPTIONS.slice(2)) {
      const original = await tmux.run(["show-options", "-wqv", "-t", window, option]);
      const replacement = expand(original);
      used ||= READS.test(replacement);
      if (replacement !== original)
        await tmux.run(["set-option", "-w", "-t", window, option, replacement]);
    }
  }
  const right = await tmux.run(["show-options", "-gqv", "status-right"]);
  if (used && !right.includes(PUBLISH_JOB))
    await tmux.run(["set-option", "-g", "status-right", right + PUBLISH_JOB]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [socket, action] = process.argv.slice(2);
  if (!socket || (action && action !== "uninstall")) {
    console.error("Usage: node tmux-plugin/plugin.ts SOCKET [uninstall]");
    process.exitCode = 2;
  } else {
    try {
      await configure(
        new Tmux(socket),
        process.execPath,
        fileURLToPath(new URL("../tmux/status.ts", import.meta.url)),
        action === "uninstall",
      );
    } catch (error) {
      console.error(`pinet tmux plugin: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
