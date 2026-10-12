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
export const PLACEHOLDERS = {
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
export function expand(format: string, node: string, query: string): string {
  let result = format;
  for (const [placeholder, [scope, mode]] of Object.entries(PLACEHOLDERS)) {
    const target = scope === "window" ? "#{window_id}" : "#{session_id}";
    result = result.replaceAll(
      `#{${placeholder}}`,
      `#(PI_TMUX_SOCKET=\${TMUX%,*}; ${shellQuote(node)} ${shellQuote(query)} "\${PI_TMUX_SOCKET%,*}" ${scope} '${target}' ${mode})`,
    );
  }
  return result;
}
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
    return;
  }
  if (current.trim() !== HOOK && (!saved || saved !== current))
    throw new Error(`${HOOK} is occupied; refusing to replace another plugin's hook`);
  // Behavioral opt-in, not a UI preference. Other plugins may require it too; uninstall leaves it enabled.
  await tmux.run(["set-option", "-g", "focus-events", "on"]);
  await tmux.run(["set-hook", "-g", HOOK, FOCUS_HOOK]);
  await tmux.run(["set-option", "-g", SAVED_HOOK, await tmux.run(["show-hooks", "-g", HOOK])]);
  for (const option of OPTIONS) {
    const original = await tmux.run(["show-options", "-gqv", option]);
    const replacement = expand(original, node, query);
    if (replacement !== original) await tmux.run(["set-option", "-g", option, replacement]);
  }
  // Preserve window-local overrides, including their themes, and expand only their explicit tokens.
  const windows = await tmux.run(["list-windows", "-a", "-F", "#{window_id}"]);
  for (const window of new Set(windows.split("\n").filter(Boolean))) {
    for (const option of OPTIONS.slice(2)) {
      const original = await tmux.run(["show-options", "-wqv", "-t", window, option]);
      const replacement = expand(original, node, query);
      if (replacement !== original)
        await tmux.run(["set-option", "-w", "-t", window, option, replacement]);
    }
  }
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
