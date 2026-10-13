import assert from "node:assert/strict";
import { test } from "vitest";
import { safeName, isInteraction, type PaneStatus } from "./helpers.ts";
import { summarize } from "./query.ts";
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
test("one/zero Pi: plain data, no prescribed icons or formatting", () => {
  assert.equal(summarize([pane]).text, "cool beans · working");
  assert.deepEqual(summarize([]), {
    count: 0,
    unread: 0,
    state: "",
    name: "",
    states: { blocked: 0, error: 0, compacting: 0, working: 0, done: 0, idle: 0 },
    text: "",
  });
});
test("multiple panes: active name, priority, state counts and unread are separate", () => {
  const active: PaneStatus = {
    ...pane,
    pane: "%2",
    name: "ship it",
    active: true,
    record: { ...pane.record, state: "blocked", unread: true },
  };
  const summary = summarize([pane, active, { ...pane, pane: "%3" }]);
  assert.equal(summary.text, "ship it + 2 others · blocked 1 · working 2 · unread 1");
  assert.equal(summary.state, "blocked");
  assert.equal(summary.name, "ship it");
  assert.equal(summary.count, 3);
  assert.equal(summary.unread, 1);
  assert.equal(summary.states.working, 2);
});
test("shell-active window selects first Pi; linked panes count only once", () => {
  assert.equal(summarize([pane, pane]).count, 1);
  assert.equal(
    summarize([pane, { ...pane, pane: "%3", name: "another" }]).text,
    "cool beans + 1 other · working 2",
  );
});
test("names cannot inject tmux formatting or terminal controls", () => {
  assert.equal(safeName("a\n#[fg=red]\x1bb\u202e"), "a ＃[fg=red] b");
  assert.equal(safeName("🚀".repeat(34)), "🚀".repeat(32) + "…");
  assert.equal(summarize([{ ...pane, name: "" }]).name, "Pi");
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
