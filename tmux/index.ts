import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  INITIAL,
  reduce,
  safeName,
  isInteraction,
  attentionChanged,
  visibleState,
  visibleUnread,
  backgroundRun,
  compactionNoticeMatches,
  type Outcome,
  type Activity,
  type Event,
  type PaneRecord,
} from "./helpers.ts";
import { processIdentity, Tmux } from "./transport.ts";

/** State publisher only: presentation and tmux integration belong to the companion plugin. */
export default function tmuxPi(pi: ExtensionAPI) {
  const tmux = new Tmux();
  const pane = process.env.TMUX_PANE;
  let record: PaneRecord | undefined;
  let activity: Activity = { ...INITIAL };
  let queue = Promise.resolve();
  let warned = false;
  let name = "Pi";
  let attention = randomUUID();
  let unsubscribeInput: (() => void) | undefined;
  let unsubscribeCompaction: (() => void) | undefined;
  let unsubscribeBackground: (() => void)[] = [];
  /** Background subagent run IDs and runner PIDs (pi-subagents lifecycle events). */
  const background = new Map<string, number | undefined>();
  let backgroundSweep: ReturnType<typeof setInterval> | undefined;

  function serialize(work: () => Promise<void>, ctx: ExtensionContext): Promise<void> {
    queue = queue.then(work).catch((error: Error) => {
      if (!warned) {
        warned = true;
        ctx.ui.notify(`tmux-pi: ${error.message}`, "warning");
      }
    });
    return queue;
  }
  function transition(event: Event, ctx: ExtensionContext): Promise<void> {
    return serialize(async () => {
      if (!record || !pane) return;
      const before = activity;
      activity = reduce(activity, event);
      const state = visibleState(activity);
      const nextName = safeName(pi.getSessionName() || basename(ctx.cwd) || "Pi");
      if (
        event.type !== "unread" &&
        record.state === state &&
        record.unread === visibleUnread(activity) &&
        name === nextName
      )
        return;
      if (
        (event.type !== "unread" && attentionChanged(before, activity)) ||
        event.type === "unread"
      )
        attention = randomUUID();
      const next = { ...record, state, unread: visibleUnread(activity) };
      if (!(await tmux.publish(pane, next, { name: nextName, attention }))) {
        record = undefined;
        return;
      }
      record = next;
      name = nextName;
    }, ctx);
  }

  function syncBackground(ctx: ExtensionContext): void {
    // A missed completion event must not pin the pane to "working": drop runs whose runner exited.
    for (const [id, pid] of background) {
      if (pid === undefined || pid === process.pid) continue;
      try {
        process.kill(pid, 0);
      } catch {
        background.delete(id);
      }
    }
    if (background.size && !backgroundSweep) {
      backgroundSweep = setInterval(() => syncBackground(ctx), 15_000);
      backgroundSweep.unref();
    } else if (!background.size && backgroundSweep) {
      clearInterval(backgroundSweep);
      backgroundSweep = undefined;
    }
    if (background.size !== activity.background)
      void transition({ type: "background", count: background.size }, ctx);
  }
  function stopBackground(): void {
    for (const unsubscribe of unsubscribeBackground) unsubscribe();
    unsubscribeBackground = [];
    background.clear();
    clearInterval(backgroundSweep);
    backgroundSweep = undefined;
  }

  pi.on("session_start", (_event, ctx) =>
    serialize(async () => {
      if (
        ctx.mode !== "tui" ||
        !process.stdout.isTTY ||
        !process.env.TMUX ||
        !pane ||
        !/^%\d+$/.test(pane)
      )
        return;
      activity = { ...INITIAL };
      record = {
        pid: process.pid,
        started: await processIdentity(process.pid),
        owner: randomUUID(),
        state: "idle",
        unread: false,
      };
      name = safeName(pi.getSessionName() || basename(ctx.cwd) || "Pi");
      attention = randomUUID();
      await tmux.claim(pane, record, { name, attention });
      stopBackground();
      unsubscribeBackground = [
        pi.events?.on("subagent:async-started", (data) => {
          const run = data && typeof data === "object" ? backgroundRun(data) : undefined;
          if (!run) return;
          background.set(run.id, run.pid);
          syncBackground(ctx);
        }),
        pi.events?.on("subagent:async-complete", (data) => {
          const run = data && typeof data === "object" ? backgroundRun(data) : undefined;
          if (!run || !background.delete(run.id)) return;
          syncBackground(ctx);
        }),
      ].filter((unsubscribe) => unsubscribe !== undefined);
      unsubscribeCompaction?.();
      unsubscribeCompaction = pi.events?.on("pinet:compaction-start", (data) => {
        if (
          data &&
          typeof data === "object" &&
          compactionNoticeMatches(data, ctx.sessionManager.getSessionFile())
        )
          void transition({ type: "compact-start" }, ctx);
      });
      unsubscribeInput?.();
      unsubscribeInput = ctx.ui.onTerminalInput((data) => {
        if (activity.unread && isInteraction(data)) void transition({ type: "ack" }, ctx);
        return undefined;
      });
    }, ctx),
  );
  pi.on("session_info_changed", (_event, ctx) => transition({ type: "refresh" }, ctx));
  pi.on("session_before_compact", (_event, ctx) => transition({ type: "compact-start" }, ctx));
  pi.on("session_compact", (_event, ctx) =>
    transition({ type: "compact-end", failed: false, aborted: false }, ctx),
  );
  pi.on("session_compact_failed", (event: { aborted: boolean }, ctx) =>
    transition({ type: "compact-end", failed: true, aborted: event.aborted }, ctx),
  );
  pi.on("agent_start", (_event, ctx) => transition({ type: "start" }, ctx));
  pi.on("agent_before_settle", (event: { outcome: Outcome }, ctx) =>
    transition({ type: "outcome", outcome: event.outcome }, ctx),
  );
  pi.on("agent_settled", (event: { aborted: boolean }, ctx) =>
    transition({ type: "settled", aborted: event.aborted }, ctx),
  );
  pi.on("ui_prompt_start", (_event, ctx) => transition({ type: "prompt-start" }, ctx));
  pi.on("ui_prompt_end", (_event, ctx) => transition({ type: "prompt-end" }, ctx));
  pi.on("input", async (_event, ctx) => {
    await transition({ type: "ack" }, ctx);
  });
  pi.on("session_shutdown", (_event, ctx) =>
    serialize(async () => {
      unsubscribeInput?.();
      unsubscribeInput = undefined;
      unsubscribeCompaction?.();
      unsubscribeCompaction = undefined;
      stopBackground();
      const old = record;
      record = undefined;
      if (old && pane) await tmux.release(pane, old.owner);
    }, ctx),
  );

  pi.registerCommand("tmux", {
    description: "Inspect published Pi pane state, or acknowledge it (no UI/config setup)",
    handler: async (args, ctx) => {
      await queue;
      if (!record || !pane) {
        ctx.ui.notify("/tmux needs interactive Pi inside tmux (Pi 1.1+).", "warning");
        return;
      }
      if (args.trim() === "ack") await transition({ type: "ack" }, ctx);
      else if (args.trim() && args.trim() !== "status") {
        ctx.ui.notify(
          "Usage: /tmux [status | ack]. Configure presentation with the companion tmux plugin.",
          "warning",
        );
        return;
      }
      ctx.ui.notify(JSON.stringify(await tmux.snapshot(pane, "window"), null, 2), "info");
    },
  });
  pi.registerCommand("unread", {
    description: "Mark this Pi pane unread without changing its execution state",
    handler: async (args, ctx) => {
      await queue;
      if (args.trim()) {
        ctx.ui.notify("Usage: /unread", "warning");
        return;
      }
      if (!record || !pane) {
        ctx.ui.notify("/unread needs interactive Pi inside tmux. Reload to activate.", "warning");
        return;
      }
      await transition({ type: "unread" }, ctx);
    },
  });
}
