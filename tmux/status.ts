import { Tmux } from "./transport.ts";
import { summarize } from "./query.ts";

// Explicit socket/target avoid accidentally querying another attached client's session.
const [socket, scope, target, mode = "summary"] = process.argv.slice(2);
if (
  !socket ||
  (scope !== "session" && scope !== "window") ||
  !target ||
  !/^[$@%]\d+$/.test(target) ||
  !["json", "summary", "state", "name", "unread", "count", "aggregate"].includes(mode)
) {
  console.error(
    "Usage: node status.ts SOCKET session|window TARGET [json|aggregate|summary|state|name|unread|count]",
  );
  process.exitCode = 2;
} else {
  try {
    const panes = await new Tmux(socket).snapshot(target, scope);
    const summary = summarize(panes);
    console.log(
      mode === "json"
        ? JSON.stringify(panes)
        : mode === "aggregate"
          ? JSON.stringify(summary)
          : mode === "summary"
            ? summary.text
            : summary[mode as "state" | "name" | "unread" | "count"],
    );
  } catch (error) {
    if (mode === "json" || mode === "aggregate")
      console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
