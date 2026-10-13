import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import extension from "./index.ts";
import { Tmux } from "./transport.ts";

test("publisher is TUI-only, owns only pane data, settles correctly and never customizes UI/config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-state-events-"));
  const socket = join(dir, "socket");
  const tmux = new Tmux(socket);
  const originalTmux = process.env.TMUX;
  const originalPane = process.env.TMUX_PANE;
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
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
    const optionsBefore = await tmux.run(["show-options", "-g"]);
    const hooksBefore = await tmux.run(["show-hooks", "-g"]);
    process.env.TMUX = `${socket},0,0`;
    process.env.TMUX_PANE = pane;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
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
    const ctx = {
      mode: "rpc",
      cwd: "/tmp/project",
      sessionManager: { getSessionFile: () => "/tmp/current-session.json" },
      ui: {
        setStatus: () => assert.fail("Publisher must not customize the Pi footer"),
        confirm: () => assert.fail("Publisher must not install UI/config"),
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
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    await emit("session_start");
    assert.equal(await state(), undefined, "non-terminal child cannot claim pane");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    await emit("session_start");
    assert.equal((await state()).state, "idle");
    assert.equal(
      await tmux.run([
        "display-message",
        "-p",
        "-t",
        pane,
        "#{@pi_state}|#{@pi_name}|#{@pi_unread}",
      ]),
      "idle|cool beans|0",
    );
    await commands.get("unread").handler("", ctx);
    const oldAttention = await tmux.run([
      "show-options",
      "-pqv",
      "-t",
      pane,
      "@pi_rollup_attention",
    ]);
    assert.equal((await state()).unread, true);
    await tmux.run(["set-option", "-p", "-t", pane, "@pi_rollup_ack", oldAttention]);
    assert.equal((await state()).unread, false);
    await commands.get("unread").handler("", ctx);
    assert.equal((await state()).unread, true, "renew an externally acknowledged marker");
    terminalInput("\x1b[?1;2c");
    await commands.get("tmux").handler("", ctx);
    assert.equal((await state()).unread, true);
    terminalInput("\x1b[I");
    await commands.get("tmux").handler("", ctx);
    assert.equal((await state()).unread, false);
    sessionName = "new ' $name (safe)";
    await emit("session_info_changed");
    assert.equal(await tmux.run(["show-options", "-pqv", "-t", pane, "@pi_name"]), sessionName);
    await emit("agent_start");
    await emit("ui_prompt_start");
    await emit("ui_prompt_start");
    assert.equal((await state()).state, "blocked");
    terminalInput("a");
    await commands.get("tmux").handler("", ctx);
    assert.equal((await state()).unread, false);
    await emit("ui_prompt_end");
    assert.equal((await state()).state, "blocked");
    await emit("ui_prompt_end");
    assert.equal((await state()).state, "working");
    bus.get("pinet:compaction-start")({ phase: "start", sessionFile: "/tmp/other-session.json" });
    await commands.get("tmux").handler("", ctx);
    assert.equal((await state()).state, "working");
    bus.get("pinet:compaction-start")({ phase: "start", sessionFile: "/tmp/current-session.json" });
    await commands.get("tmux").handler("", ctx);
    assert.equal((await state()).state, "compacting");
    await emit("session_compact");
    assert.equal((await state()).state, "working");
    await emit("agent_before_settle", { outcome: "error" });
    assert.equal((await state()).state, "working");
    await emit("agent_settled", { aborted: false });
    assert.equal((await state()).state, "error");
    await Promise.all([
      emit("agent_start"),
      emit("agent_before_settle", { outcome: "completed" }),
      emit("agent_settled", { aborted: false }),
    ]);
    assert.equal((await state()).state, "done");
    await commands.get("tmux").handler("ack", ctx);
    assert.equal((await state()).unread, false);
    await emit("agent_start");
    await emit("agent_settled", { aborted: true });
    assert.equal((await state()).state, "idle");
    assert.equal((await state()).unread, false);
    await emit("session_before_compact");
    await emit("session_compact_failed", { aborted: true });
    assert.equal((await state()).state, "idle");
    await emit("session_before_compact");
    await emit("session_compact_failed", { aborted: false });
    assert.equal((await state()).state, "error");
    // Background subagents (pi-subagents lifecycle events) keep an idle parent working.
    await emit("agent_start");
    bus.get("subagent:async-started")({ id: "run-a", pid: process.pid });
    bus.get("subagent:async-started")({ id: "run-dead", pid: 2147483647 });
    await emit("agent_settled", { aborted: false });
    assert.deepEqual(
      [(await state()).state, (await state()).unread],
      ["working", false],
      "waiting on a live background run; the exited runner is dropped",
    );
    bus.get("subagent:async-complete")({ runId: "run-a" });
    await commands.get("tmux").handler("", ctx);
    assert.deepEqual([(await state()).state, (await state()).unread], ["done", true]);
    await commands.get("tmux").handler("setup", ctx);
    assert.ok(notices.at(-1).startsWith("Usage: /tmux"));
    await emit("session_shutdown");
    assert.equal(terminalInput, undefined);
    assert.equal(bus.size, 0);
    assert.equal(await state(), undefined);
    assert.equal(await tmux.run(["show-options", "-pqv", "-t", pane, "@pi_state"]), "");
    assert.equal(await tmux.run(["show-options", "-g"]), optionsBefore);
    assert.equal(await tmux.run(["show-hooks", "-g"]), hooksBefore);
    assert.equal(
      notices.some((message) => message.startsWith("tmux-pi:")),
      false,
      notices.join("\n"),
    );
  } finally {
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
