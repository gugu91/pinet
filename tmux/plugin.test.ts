import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { configure, expand, HOOK, shellQuote } from "../tmux-plugin/plugin.ts";
import { Tmux, processIdentity } from "./transport.ts";
const exec = promisify(execFile);

test("TPM adapter does not choose layouts; expands only explicit tokens, preserves overrides/hooks, is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pinet-plugin-"));
  const tmux = new Tmux(join(dir, "socket"));
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
    const before = await tmux.run(["show-options", "-g"]);
    const query = fileURLToPath(new URL("./status.ts", import.meta.url));
    await configure(tmux, process.execPath, query);
    // No explicit placeholders: nothing in the actual layout should change.
    for (const line of before
      .split("\n")
      .filter((line) => /^(status-|window-status-)/.test(line))) {
      assert.ok((await tmux.run(["show-options", "-g"])).split("\n").includes(line));
    }
    const normal = "#[fg=red] #I #W #F";
    const right = "#{pi_session_summary} #(continuum-save) %H:%M";
    const local = "#[bold] #I #{pi_window_summary} #F";
    await tmux.run(["set-option", "-g", "window-status-format", normal]);
    await tmux.run(["set-option", "-g", "status-right", right]);
    await tmux.run(["set-option", "-w", "-t", pane, "window-status-current-format", local]);
    await tmux.run(["set-hook", "-g", "pane-focus-in[123]", "display-message retained"]);
    await configure(tmux, process.execPath, query);
    assert.equal(await tmux.run(["show-options", "-gqv", "window-status-format"]), normal);
    assert.equal(
      await tmux.run(["show-options", "-gqv", "status-right"]),
      expand(right, process.execPath, query),
    );
    assert.equal(
      await tmux.run(["show-options", "-wqv", "-t", pane, "window-status-current-format"]),
      expand(local, process.execPath, query),
    );
    const configured = await tmux.run(["show-options", "-g"]);
    await configure(tmux, process.execPath, query);
    assert.equal(await tmux.run(["show-options", "-g"]), configured);
    const hook = await tmux.run(["show-hooks", "-g", HOOK]);
    assert.ok(hook.includes("@pi_unread"));
    await configure(tmux, process.execPath, query, true);
    assert.equal(await tmux.run(["show-hooks", "-g", HOOK]), HOOK);
    assert.ok((await tmux.run(["show-hooks", "-g", "pane-focus-in[123]"])).includes("retained"));
    await tmux.run(["set-hook", "-g", HOOK, "display-message user-owned"]);
    const after = await tmux.run(["show-options", "-g"]);
    await assert.rejects(() => configure(tmux, process.execPath, query), /occupied/);
    assert.equal(await tmux.run(["show-options", "-g"]), after);
    await configure(tmux, process.execPath, query, true);
    assert.ok((await tmux.run(["show-hooks", "-g", HOOK])).includes("user-owned"));
  } finally {
    await tmux.run(["kill-server"]);
    await rm(dir, { recursive: true, force: true });
  }
});
test("query jobs use portable quoting and target-specific aggregates, without npm bootstrap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pinet-plugin-jobs-"));
  const socket = join(dir, "socket ' $literal (space)");
  const tmux = new Tmux(socket);
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
    const second = await tmux.run([
      "new-session",
      "-d",
      "-s",
      "unrelated",
      "-P",
      "-F",
      "#{pane_id}",
      "sleep 120",
    ]);
    const record = {
      pid: process.pid,
      started: await processIdentity(process.pid),
      owner: "00000000-0000-4000-8000-000000000000",
      state: "working" as const,
      unread: false,
    };
    await tmux.claim(pane, record, { name: "ship it", attention: record.owner });
    await tmux.claim(
      second,
      { ...record, state: "error" },
      { name: "other", attention: record.owner },
    );
    const node = join(dir, "node ' $literal (space)");
    await symlink(process.execPath, node);
    const query = fileURLToPath(new URL("./status.ts", import.meta.url));
    const window = await tmux.run(["display-message", "-p", "-t", pane, "#{window_id}"]);
    const session = await tmux.run(["display-message", "-p", "-t", pane, "#{session_id}"]);
    for (const [placeholder, expected] of [
      ["pi_state", "working"],
      ["pi_name", "ship it"],
      ["pi_count", "1"],
      ["pi_unread", "0"],
      ["pi_session_summary", "ship it · working"],
    ]) {
      const job = expand(`#{${placeholder}}`, node, query)
        .slice(2, -1)
        .replace("#{q:socket_path}", shellQuote(socket))
        .replace("#{window_id}", window)
        .replace("#{session_id}", session);
      assert.equal((await exec("bash", ["-c", job])).stdout.trim(), expected);
    }
    // The actual TPM root entry runs native TS; neither node_modules nor dist is used by this path.
    await exec("bash", [fileURLToPath(new URL("../pinet.tmux", import.meta.url))], {
      env: { ...process.env, TMUX: `${socket},0,0`, TMUX_PANE: pane },
    });
    assert.ok((await tmux.run(["show-hooks", "-g", HOOK])).includes("@pi_rollup_ack"));
  } finally {
    await tmux.run(["kill-server"]);
    await rm(dir, { recursive: true, force: true });
  }
});
