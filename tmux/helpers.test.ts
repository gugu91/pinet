import assert from "node:assert/strict";
import { test } from "vitest";
import {
  INITIAL,
  encode,
  parseRecord,
  reduce,
  attentionChanged,
  visibleState,
  visibleUnread,
  backgroundRun,
  type PaneRecord,
} from "./helpers.ts";
const record: PaneRecord = {
  pid: 123,
  started: "YWJj",
  owner: "00000000-0000-4000-8000-000000000000",
  state: "working",
  unread: false,
};
test("completion waits for settlement, error and cancellation stay distinct", () => {
  const working = reduce(INITIAL, { type: "start" });
  assert.equal(visibleState(working), "working");
  for (const [outcome, state] of [
    ["completed", "done"],
    ["aborted", "idle"],
    ["error", "error"],
  ] as const) {
    const pending = reduce(working, { type: "outcome", outcome });
    assert.equal(visibleState(pending), "working");
    const settled = reduce(pending, { type: "settled", aborted: false });
    assert.equal(visibleState(settled), state);
    assert.equal(settled.unread, outcome !== "aborted");
  }
});
test("retry success supersedes a transient error", () => {
  let activity = reduce(INITIAL, { type: "start" });
  activity = reduce(activity, { type: "outcome", outcome: "error" });
  activity = reduce(activity, { type: "outcome", outcome: "completed" });
  assert.equal(reduce(activity, { type: "settled", aborted: false }).base, "done");
});
test("nested dialogs stay blocked until all close; ack does not unblock", () => {
  let activity = reduce(INITIAL, { type: "start" });
  activity = reduce(activity, { type: "prompt-start" });
  activity = reduce(activity, { type: "prompt-start" });
  activity = reduce(activity, { type: "ack" });
  assert.equal(visibleState(activity), "blocked");
  assert.equal(activity.unread, false);
  activity = reduce(activity, { type: "prompt-end" });
  assert.equal(visibleState(activity), "blocked");
  activity = reduce(activity, { type: "prompt-end" });
  assert.equal(visibleState(activity), "working");
  assert.equal(activity.unread, false);
  assert.deepEqual(reduce(activity, { type: "prompt-end" }), activity);
});
test("dialogs restore idle or acknowledged completion without inventing an alert", () => {
  const done = reduce(reduce(INITIAL, { type: "start" }), { type: "settled", aborted: false });
  for (const initial of [INITIAL, reduce(done, { type: "ack" })]) {
    const result = reduce(reduce(initial, { type: "prompt-start" }), {
      type: "prompt-end",
    });
    assert.equal(result.base, initial.base);
    assert.equal(result.unread, false);
  }
});
test("settlement behind a dialog preserves blocked state then reveals completion", () => {
  let activity = reduce(reduce(INITIAL, { type: "start" }), {
    type: "prompt-start",
  });
  activity = reduce(activity, { type: "settled", aborted: false });
  assert.equal(visibleState(activity), "blocked");
  activity = reduce(activity, { type: "prompt-end" });
  assert.equal(visibleState(activity), "done");
  assert.equal(activity.unread, true);
});
test("attention generation changes on alerts, not repeats, acknowledgements or cancellation", () => {
  const working = reduce(INITIAL, { type: "start" });
  const blocked = reduce(working, { type: "prompt-start" });
  const done = reduce(working, { type: "settled", aborted: false });
  assert.equal(attentionChanged(working, blocked), true);
  assert.equal(attentionChanged(working, done), true);
  assert.equal(attentionChanged(blocked, reduce(blocked, { type: "prompt-start" })), false);
  assert.equal(attentionChanged(done, reduce(done, { type: "settled", aborted: false })), false);
  const acked = reduce(done, { type: "ack" });
  assert.equal(attentionChanged(done, acked), false);
  assert.deepEqual(reduce(acked, { type: "settled", aborted: false }), acked);
  // Real Pi cancellation: no agent_before_settle, only settlement's aborted flag.
  const aborted = reduce(working, { type: "settled", aborted: true });
  assert.equal(aborted.base, "idle");
  assert.equal(aborted.unread, false);
  assert.equal(attentionChanged(working, aborted), false);
});
test("an idle parent waiting on background subagents stays working; attention follows them", () => {
  const settled = reduce(reduce(INITIAL, { type: "start" }), { type: "settled", aborted: false });
  const waiting = reduce(settled, { type: "background", count: 2 });
  assert.equal(visibleState(waiting), "working");
  assert.equal(visibleUnread(waiting), false);
  assert.equal(attentionChanged(settled, waiting), false);
  const finished = reduce(waiting, { type: "background", count: 0 });
  assert.equal(visibleState(finished), "done");
  assert.equal(visibleUnread(finished), true);
  assert.equal(attentionChanged(waiting, finished), true);
  // Questions still outrank background work, and their attention shows immediately.
  const asking = reduce(waiting, { type: "prompt-start" });
  assert.deepEqual([visibleState(asking), visibleUnread(asking)], ["blocked", true]);
  assert.equal(visibleUnread(reduce(asking, { type: "prompt-end" })), false);
  // Compaction does not expose completion attention still waiting on background runs.
  assert.equal(visibleUnread(reduce(waiting, { type: "compact-start" })), false);
});
test("/unread shows during foreground and background work until acknowledged", () => {
  const working = reduce(INITIAL, { type: "start" });
  const marked = reduce(working, { type: "unread" });
  assert.deepEqual([visibleState(marked), visibleUnread(marked)], ["working", true]);
  const background = reduce(marked, { type: "background", count: 1 });
  assert.equal(visibleUnread(background), true);
  assert.equal(visibleUnread(reduce(background, { type: "ack" })), false);
});
test("background run notices accept start ids and completion runIds", () => {
  assert.deepEqual(backgroundRun({ id: "run-1", pid: 42 }), { id: "run-1", pid: 42 });
  assert.deepEqual(backgroundRun({ id: "child", runId: "run-2" }), { id: "run-2" });
  assert.equal(backgroundRun({ id: "" }), undefined);
  assert.deepEqual(backgroundRun({ id: "run-3", pid: -1 }), { id: "run-3" });
});
test("records roundtrip and invalid/untrusted option values are discarded", () => {
  assert.deepEqual(parseRecord(encode(record)), record);
  for (const value of [
    "",
    "v2|123|YWJj|bad|done|1",
    encode(record) + "|extra",
    encode(record).replace("working", "broken"),
    encode(record).replace("123", "-1"),
    encode(record).replace("YWJj", "#{run-shell}"),
  ]) {
    assert.equal(parseRecord(value), null);
  }
});
