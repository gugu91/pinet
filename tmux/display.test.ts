import assert from "node:assert/strict";
import { test } from "vitest";
import { windowLabel, safeName, isInteraction, type PaneStatus } from "./helpers.ts";
const pane: PaneStatus = {
  pane: "%1",
  window: "@1",
  active: false,
  name: "cool beans",
  record: {
    pid: 1,
    started: "YWJj",
    owner: "00000000-0000-4000-8000-000000000000",
    state: "working",
    unread: false,
  },
};
test("one Pi: its session name and state, no count", () => {
  assert.equal(windowLabel([pane]), "⚙️ cool beans");
  assert.equal(windowLabel([]), "");
});
test("several Pi panes: active Pi name plus others, with state counts", () => {
  const active = {
    ...pane,
    pane: "%2",
    name: "ship it",
    active: true,
    record: { ...pane.record, state: "blocked" as const, unread: true },
  };
  assert.equal(windowLabel([pane, active]), "ship it + 1 other · 🙋 1 · ⚙️ 1 · 🔔 1");
  assert.equal(
    windowLabel([pane, active, { ...pane, pane: "%3" }]),
    "ship it + 2 others · 🙋 1 · ⚙️ 2 · 🔔 1",
  );
});
test("shell-active window falls back to first Pi; duplicate panes not counted", () => {
  assert.equal(windowLabel([pane, pane]), "⚙️ cool beans");
  assert.equal(
    windowLabel([pane, { ...pane, pane: "%3", name: "another" }]),
    "cool beans + 1 other · ⚙️ 2",
  );
});
test("names cannot inject tmux formatting or terminal controls", () => {
  assert.equal(safeName("a\n#[fg=red]\x1bb\u202e"), "a ＃[fg=red] b");
  assert.equal(safeName("🚀".repeat(34)), "🚀".repeat(32) + "…");
  assert.equal(windowLabel([{ ...pane, name: "" }]), "⚙️ Pi");
});
test("automatic ack recognizes keys/focus but ignores terminal replies", () => {
  for (const input of ["x", "\r", "\x1b[A", "\x1b[97;1u", "\x1b[I"])
    assert.equal(isInteraction(input), true);
  for (const input of [
    "",
    "\x1b[O",
    "\x1b[?1;2c",
    "\x1b[12;3R",
    "\x1b[8;32;120t",
    "\x1b]11;rgb:ffff/ffff/ffff\x07",
  ])
    assert.equal(isInteraction(input), false);
});
