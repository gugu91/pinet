import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  INITIAL,
  ICONS,
  reduce,
  windowLabel,
  safeName,
  isInteraction,
  shouldBell,
  visibleState,
  compactionNoticeMatches,
  type Outcome,
  type Activity,
  type Event,
  type PaneRecord,
} from "./helpers.ts";
import { processIdentity, Tmux } from "./transport.ts";
import { setupPaths, preview, install, uninstall, installation, snapshot } from "./setup.ts";
import { CLIENT_FORMAT, parseClients, relay } from "./rex.ts";

export default function tmuxPi(pi: ExtensionAPI) {
  const tmux = new Tmux();
  const pane = process.env.TMUX_PANE;
  let record: PaneRecord | undefined;
  let activity: Activity = { ...INITIAL };
  let bell = false;
  let queue = Promise.resolve();
  let warned = false;
  let name = "Pi";
  let attention = randomUUID();
  let unsubscribeInput: (() => void) | undefined;
  let unsubscribeCompaction: (() => void) | undefined;

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
        record.unread === activity.unread &&
        name === nextName
      )
        return;
      const alert = event.type !== "unread" && shouldBell(before, activity);
      if (alert || event.type === "unread") attention = randomUUID();
      const next = { ...record, state, unread: activity.unread };
      if (!(await tmux.publish(pane, next, { name: nextName, attention }))) {
        record = undefined;
        ctx.ui.setStatus("tmux-pi", undefined);
        return;
      }
      record = next;
      name = nextName;
      ctx.ui.setStatus("tmux-pi", `${ICONS[state]}${activity.unread ? " 🔔" : ""}`);
      if (bell && alert) process.stdout.write("\x07");
    }, ctx);
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
      ctx.ui.setStatus("tmux-pi", ICONS.idle);
      unsubscribeCompaction?.();
      unsubscribeCompaction = pi.events?.on("pinet:compaction-start", (data) => {
        if (
          data &&
          typeof data === "object" &&
          compactionNoticeMatches(data, ctx.sessionManager.getSessionFile())
        ) {
          void transition({ type: "compact-start" }, ctx);
        }
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
  pi.on("agent_settled", (_event, ctx) => transition({ type: "settled" }, ctx));
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
      const old = record;
      record = undefined;
      ctx.ui.setStatus("tmux-pi", undefined);
      if (old && pane) await tmux.release(pane, old.owner);
    }, ctx),
  );

  pi.registerCommand("tmux", {
    description:
      "Pi window labels: status, preview/setup, doctor/uninstall, rex on/off, bell on/off",
    handler: async (args, ctx) => {
      await queue;
      if (!record || !pane) {
        ctx.ui.notify("/tmux needs interactive Pi inside tmux (Pi 1.1+).", "warning");
        return;
      }
      const paths = setupPaths();
      try {
        switch (args.trim()) {
          case "preview":
          case "setup": {
            const plan = await preview(tmux, paths);
            const detail = `${paths.config}\n\n${plan.block}\n${plan.include}`;
            if (args.trim() === "preview") ctx.ui.notify(detail, "info");
            else if (
              await ctx.ui.confirm(
                "Set up @pinet/tmux?",
                `${detail}\nExisting config will be backed up. No Rex forwarding is enabled.`,
              )
            ) {
              await install(tmux, paths, plan);
              ctx.ui.notify(
                "@pinet/tmux setup completed. /tmux doctor checks the installed options.",
                "info",
              );
            }
            return;
          }
          case "uninstall":
            if (
              await ctx.ui.confirm(
                "Remove @pinet/tmux integration?",
                "Remove only the managed include and restore unchanged managed options. Other configuration is preserved.",
              )
            ) {
              await uninstall(tmux, paths);
              ctx.ui.notify(
                "Managed tmux integration removed. Remove the Pi package separately with pi remove npm:@pinet/tmux.",
                "info",
              );
            }
            return;
          case "doctor": {
            const saved = await installation(paths);
            const current = await snapshot(tmux);
            const drift = saved
              ? Object.keys(saved.applied).filter(
                  (key) =>
                    current[key as keyof typeof current] !==
                    saved.applied[key as keyof typeof current],
                )
              : [];
            ctx.ui.notify(
              `${await tmux.run(["-V"])} · Pi 1.1+ required\nPane: ${pane} · managed setup: ${saved ? "installed" : "not installed"}\n${drift.length ? `Changed options (preserved on uninstall): ${drift.join(", ")}` : "No managed option drift"}\nRex forwarding is experimental and per-client opt-in. Desktop banners are unverified; no automatic notifications are sent.`,
              "info",
            );
            return;
          }
          case "rex on":
          case "rex off": {
            const session = await tmux.run(["display-message", "-p", "-t", pane, "#{session_id}"]);
            const clients = parseClients(
              await tmux.run(["list-clients", "-F", CLIENT_FORMAT]),
            ).filter((client) => client.session === session);
            if (clients.length !== 1)
              throw new Error(
                "Rex opt-in needs exactly one attached terminal client for this session; select a client explicitly with rex-cli.js instead",
              );
            ctx.ui.notify(
              await relay(tmux, clients[0].pid, args.trim() === "rex on" ? "on" : "off"),
              "info",
            );
            return;
          }
          case "bell on":
            bell = true;
            break;
          case "bell off":
            bell = false;
            break;
          case "ack":
            await transition({ type: "ack" }, ctx);
            break;
          case "":
          case "status":
            break;
          default:
            ctx.ui.notify(
              "Usage: /tmux [status | preview | setup | doctor | uninstall | rex on/off | bell on/off | ack]",
              "warning",
            );
            return;
        }
        ctx.ui.notify(
          `${windowLabel(await tmux.snapshot(pane, "window")) || "No live Pi panes"}\nBell: ${bell ? "on" : "off"} · /unread marks attention silently`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `@pinet/tmux: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    },
  });

  pi.registerCommand("unread", {
    description: "Mark this Pi pane unread without changing its state or ringing a bell",
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

  pi.registerCommand("tmux-pi", {
    description: "Preview this window's Pi names/states; bell on/off (automatic acknowledgement)",
    handler: async (args, ctx) => {
      await queue;
      if (!record || !pane) {
        ctx.ui.notify("tmux-pi needs interactive Pi inside tmux. Reload to activate.", "warning");
        return;
      }
      switch (args.trim()) {
        case "ack":
          await transition({ type: "ack" }, ctx);
          break;
        case "bell on":
          bell = true;
          break;
        case "bell off":
          bell = false;
          break;
        case "":
          break;
        default:
          ctx.ui.notify("Usage: /tmux-pi [ack | bell on | bell off]", "warning");
          return;
      }
      const panes = await tmux.snapshot(pane, "window");
      ctx.ui.notify(
        `${windowLabel(panes) || "No live Pi panes"}\nBell: ${bell ? "on" : "off"} · 🙋 needs input · ❌ error · ⚙️ working · 🗜️ compacting · ✅ done · 💤 idle · 🔔 unread panes`,
        "info",
      );
    },
  });
}
