import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import { Tmux, OPTION, FOCUS_HOOK, processIdentity } from "./transport.ts";
import type { PaneRecord } from "./helpers.ts";

test("isolated tmux: ownership, scopes, hidden panes, liveness, cleanup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tmux-test-"));
  const tmux = new Tmux(join(dir, "socket"));
  try {
    const pane1 = await tmux.run([
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "one",
      "-P",
      "-F",
      "#{pane_id}",
      "sleep 120",
    ]);
    const pane2 = await tmux.run([
      "new-window",
      "-d",
      "-t",
      "one",
      "-P",
      "-F",
      "#{pane_id}",
      "sleep 120",
    ]);
    const pane3 = await tmux.run([
      "new-session",
      "-d",
      "-s",
      "two",
      "-P",
      "-F",
      "#{pane_id}",
      "sleep 120",
    ]);
    const record: PaneRecord = {
      pid: process.pid,
      started: await processIdentity(process.pid),
      owner: randomUUID(),
      state: "working",
      unread: false,
    };
    await tmux.claim(pane1, record);
    await tmux.claim(pane2, {
      ...record,
      owner: randomUUID(),
      state: "blocked",
      unread: true,
    });
    await tmux.claim(pane3, {
      ...record,
      owner: randomUUID(),
      state: "done",
      unread: true,
    });
    assert.equal(
      (await tmux.snapshot(pane1)).length,
      2,
      "include hidden windows but not other sessions",
    );
    assert.equal((await tmux.snapshot(pane1, "window")).length, 1);
    assert.equal((await tmux.snapshot(pane3)).length, 1);
    const cli = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("./status.ts", import.meta.url)),
      join(dir, "socket"),
      "session",
      pane1,
    ]);
    assert.equal(cli.stdout.trim(), "Pi + 1 other · blocked 1 · working 1 · unread 1");
    assert.equal(cli.stderr, "");
    assert.equal(await tmux.publish(pane1, { ...record, state: "error", unread: true }), true);
    assert.equal((await tmux.snapshot(pane1, "window"))[0].record.state, "error");
    await tmux.run(["set-hook", "-g", "pane-focus-in[9147]", FOCUS_HOOK]);
    await tmux.run(["set-hook", "-R", "-t", pane1, "pane-focus-in"]);
    const acknowledged = (await tmux.snapshot(pane1, "window"))[0].record;
    assert.equal(acknowledged.unread, false, "focus auto acknowledges");
    assert.equal(acknowledged.state, "error", "ack does not change state");
    assert.equal(await tmux.run(["show-options", "-pqv", "-t", pane1, "@pi_unread"]), "0");
    await tmux.publish(pane1, { ...record, state: "working", unread: true });
    assert.equal(
      await tmux.run(["show-options", "-pqv", "-t", pane1, "@pi_unread"]),
      "0",
      "a state refresh must not resurrect externally acknowledged attention",
    );
    await tmux.publish(
      pane1,
      { ...record, state: "blocked", unread: true },
      { name: "renamed Pi", attention: randomUUID() },
    );
    assert.equal(
      (await tmux.snapshot(pane1, "window"))[0].record.unread,
      true,
      "new attention survives old acknowledgement",
    );
    assert.equal((await tmux.snapshot(pane1, "window"))[0].name, "renamed Pi");
    const replacement = {
      ...record,
      owner: randomUUID(),
      state: "idle" as const,
    };
    await tmux.claim(pane1, replacement);
    assert.equal(
      await tmux.publish(pane1, record),
      false,
      "old owner cannot overwrite replacement",
    );
    await tmux.release(pane1, record.owner);
    assert.equal((await tmux.snapshot(pane1, "window"))[0].record.owner, replacement.owner);
    await tmux.release(pane1, replacement.owner);
    assert.equal((await tmux.snapshot(pane1, "window")).length, 0);
    for (const option of ["@pi_state", "@pi_name", "@pi_unread"])
      assert.equal(await tmux.run(["show-options", "-pqv", "-t", pane1, option]), "");
    await tmux.run(["set-hook", "-R", "-t", pane1, "pane-focus-in"]);
    assert.equal(
      await tmux.run(["show-options", "-pqv", "-t", pane1, "@pi_unread"]),
      "",
      "the focus hook must not create data on shell-only panes",
    );
    await tmux.claim(pane1, { ...record, started: "ZmFrZQ==" });
    assert.equal((await tmux.snapshot(pane1, "window")).length, 0, "reject recycled PID");
    await tmux.claim(pane1, { ...record, pid: 2147483647 });
    assert.equal((await tmux.snapshot(pane1, "window")).length, 0, "ignore dead process");
    await tmux.run(["set-option", "-p", "-t", pane1, OPTION, "malformed"]);
    assert.equal((await tmux.snapshot(pane1, "window")).length, 0);
    await tmux.run(["kill-pane", "-t", pane2]);
    assert.equal((await tmux.snapshot(pane1)).length, 0, "destroyed panes disappear");
  } finally {
    await tmux.run(["kill-server"]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
