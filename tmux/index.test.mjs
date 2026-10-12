import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import extension from "./index.ts";
import { Tmux } from "./transport.ts";

test("extension wiring: TUI-only, outcomes, nested prompts, queued transitions, opt-in bells, shutdown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rollup-events-"));
  const socket = join(dir, "socket");
  const tmux = new Tmux(socket);
  const originalTmux = process.env.TMUX;
  const originalPane = process.env.TMUX_PANE;
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const originalWrite = process.stdout.write;
  let bells = 0;
  try {
    const pane = await tmux.run([
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "test",
      "-P",
      "-F",
      "#{pane_id}",
      "sleep 120",
    ]);
    process.env.TMUX = `${socket},0,0`;
    process.env.TMUX_PANE = pane;
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    process.stdout.write = function (chunk, ...args) {
      if (chunk === "\x07") {
        bells++;
        return true;
      }
      return originalWrite.call(this, chunk, ...args);
    };
    const handlers = new Map();
    const commands = new Map();
    const bus = new Map();
    let sessionName = "cool beans";
    let terminalInput;
    extension({
      events: {
        on: (name, handler) => {
          bus.set(name, handler);
          return () => bus.delete(name);
        },
      },
      getSessionName: () => sessionName,
      on: (event, handler) => handlers.set(event, handler),
      registerCommand: (name, command) => commands.set(name, command),
    });
    const notices = [];
    const statuses = new Map();
    const ctx = {
      mode: "rpc",
      cwd: "/tmp/project",
      sessionManager: { getSessionFile: () => "/tmp/current-session.json" },
      ui: {
        setStatus: (key, text) => {
          if (text === undefined) statuses.delete(key);
          else statuses.set(key, text);
        },
        notify: (text) => notices.push(text),
        onTerminalInput: (callback) => {
          terminalInput = callback;
          return () => {
            terminalInput = undefined;
          };
        },
      },
    };
    const emit = (name, event = {}) => handlers.get(name)(event, ctx);
    const state = async () => (await tmux.snapshot(pane))[0]?.record;
    await emit("session_start");
    assert.equal(await state(), undefined, "RPC child cannot claim pane");
    ctx.mode = "tui";
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    await emit("session_start");
    assert.equal(await state(), undefined, "non-terminal child cannot claim pane");
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    await emit("session_start");
    assert.equal((await state()).state, "idle");
    assert.equal(statuses.get("tmux-pi"), "💤");
    assert.equal((await tmux.snapshot(pane))[0].name, "cool beans");
    terminalInput("\r");
    await commands.get("unread").handler("", ctx);
    assert.equal((await state()).state, "idle", "/unread preserves execution state");
    assert.equal((await state()).unread, true, "submitting the command does not clear its mark");
    assert.equal(statuses.get("tmux-pi"), "💤 🔔");
    const oldAttention = await tmux.run([
      "show-options",
      "-pqv",
      "-t",
      pane,
      "@pi_rollup_attention",
    ]);
    await tmux.run(["set-option", "-p", "-t", pane, "@pi_rollup_ack", oldAttention]);
    assert.equal((await state()).unread, false, "tmux focus hook acknowledges the marker");
    await commands.get("unread").handler("", ctx);
    assert.equal(
      (await state()).unread,
      true,
      "repeat /unread renews an externally acknowledged marker",
    );
    assert.notEqual(
      await tmux.run(["show-options", "-pqv", "-t", pane, "@pi_rollup_attention"]),
      oldAttention,
    );
    terminalInput("\x1b[?1;2c");
    await commands.get("tmux-pi").handler("", ctx);
    assert.equal(statuses.get("tmux-pi"), "💤 🔔", "protocol replies do not clear unread");
    terminalInput("\x1b[I");
    await commands.get("tmux-pi").handler("", ctx);
    assert.equal((await state()).unread, false, "returning focus clears manual unread");
    assert.equal(statuses.get("tmux-pi"), "💤");
    sessionName = "new name";
    await emit("session_info_changed", { name: sessionName });
    assert.equal((await tmux.snapshot(pane))[0].name, "new name");
    await emit("agent_start");
    await emit("ui_prompt_start");
    await emit("ui_prompt_start");
    assert.equal((await state()).state, "blocked");
    terminalInput("\x1b[?1;2c");
    await commands.get("tmux-pi").handler("", ctx);
    assert.equal((await state()).unread, true, "terminal response is not acknowledgement");
    terminalInput("a");
    await commands.get("tmux-pi").handler("", ctx);
    assert.equal((await state()).unread, false, "typing auto acknowledges");
    await emit("ui_prompt_end");
    assert.equal((await state()).state, "blocked");
    await emit("ui_prompt_end");
    assert.equal((await state()).state, "working");
    bus.get("pinet:compaction-start")({ phase: "start", sessionFile: "/tmp/other-session.json" });
    await commands.get("tmux-pi").handler("", ctx);
    assert.equal((await state()).state, "working", "other sessions cannot overlay this pane");
    bus.get("pinet:compaction-start")({ phase: "start", sessionFile: "/tmp/current-session.json" });
    await commands.get("tmux-pi").handler("", ctx);
    assert.equal(
      (await state()).state,
      "compacting",
      "custom compactor signals before awaited core observer",
    );
    await emit("session_before_compact");
    assert.equal((await state()).state, "compacting");
    assert.equal(statuses.get("tmux-pi"), "🗜️");
    await emit("session_compact");
    assert.equal((await state()).state, "working");
    await emit("agent_before_settle", { outcome: "error" });
    assert.equal((await state()).state, "working", "no premature failure");
    await emit("agent_settled");
    assert.equal((await state()).state, "error");
    assert.equal(bells, 0, "bells off by default");
    await commands.get("tmux-pi").handler("bell on", ctx);
    await commands.get("tmux-pi").handler("ack", ctx);
    await commands.get("unread").handler("", ctx);
    assert.equal(statuses.get("tmux-pi"), "❌ 🔔");
    assert.equal(bells, 0, "manual unread is silent even with bells enabled");
    await Promise.all([
      emit("agent_start"),
      emit("agent_before_settle", { outcome: "completed" }),
      emit("agent_settled"),
    ]);
    assert.equal((await state()).state, "done");
    assert.equal(statuses.get("tmux-pi"), "✅ 🔔");
    assert.equal(bells, 1);
    await emit("agent_settled");
    assert.equal(bells, 1, "duplicate settled event does not ring");
    await emit("agent_start");
    await emit("agent_before_settle", { outcome: "aborted" });
    await emit("agent_settled");
    assert.equal((await state()).state, "idle");
    assert.equal(bells, 1, "cancel does not ring");
    await emit("session_before_compact");
    assert.equal((await state()).state, "compacting");
    await emit("session_compact_failed", { aborted: true });
    assert.equal((await state()).state, "idle");
    assert.equal(bells, 1);
    await emit("session_before_compact");
    await emit("session_compact_failed", { aborted: false });
    assert.equal((await state()).state, "error");
    assert.equal(bells, 2);
    await emit("session_shutdown");
    assert.equal(terminalInput, undefined, "input listener unsubscribed");
    assert.equal(bus.size, 0, "shared compaction listener unsubscribed");
    assert.equal(await state(), undefined);
    assert.equal(statuses.has("tmux-pi"), false, "shutdown removes footer status");
    assert.equal(
      notices.some((message) => message.startsWith("tmux-pi:")),
      false,
      notices.join("\n"),
    );
  } finally {
    process.stdout.write = originalWrite;
    if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
    else delete process.stdout.isTTY;
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
    if (originalPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = originalPane;
    await tmux.run(["kill-server"]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
