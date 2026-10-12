import { Tmux } from "./transport.ts";
import { rollup, windowLabel, safeName } from "./helpers.ts";

// Run with Node 24+. Explicit socket + target also work when invoked by tmux's status job environment.
const [socket, scope, target, mode] = process.argv.slice(2);
if (
  !socket ||
  (scope !== "session" && scope !== "window") ||
  !target ||
  !/^[$@%]\d+$/.test(target) ||
  (mode && mode !== "json")
) {
  console.error("Usage: node status.ts SOCKET session|window TARGET [json]");
  process.exitCode = 2;
} else {
  try {
    const tmux = new Tmux(socket);
    const panes = await tmux.snapshot(target, scope);
    const fallback =
      scope === "window" && !panes.length && mode !== "json"
        ? safeName(await tmux.run(["display-message", "-p", "-t", target, "#{window_name}"]))
        : "";
    console.log(
      mode === "json"
        ? JSON.stringify(panes, null, 2)
        : scope === "window"
          ? windowLabel(panes) || fallback
          : rollup(panes),
    );
  } catch (error) {
    // Never put process failures in a status line. Explicit JSON inspection reports failures to stderr.
    if (mode === "json") console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
