import assert from "node:assert/strict";
import { test } from "vitest";
import {
  INITIAL,
  encode,
  parseRecord,
  reduce,
  step,
  type Activity,
  type Event,
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
/** Runs events through step(), as the publisher does, collecting alerts. */
function run(start: Activity, ...events: Event[]): { activity: Activity; alerts: boolean[] } {
  let activity = start;
  const alerts: boolean[] = [];
  for (const event of events) {
    const result = step(activity, event);
    activity = result.activity;
    alerts.push(result.alert);
  }
  return { activity, alerts };
}
test("attention generation changes on alerts, not repeats, acknowledgements or cancellation", () => {
  const working = reduce(INITIAL, { type: "start" });
  assert.deepEqual(run(working, { type: "prompt-start" }, { type: "prompt-start" }).alerts, [
    true,
    false,
  ]);
  const done = run(working, { type: "settled", aborted: false });
  assert.deepEqual(done.alerts, [true]);
  assert.deepEqual(run(done.activity, { type: "settled", aborted: false }).alerts, [false]);
  const acked = run(done.activity, { type: "ack" }, { type: "settled", aborted: false });
  assert.deepEqual(acked.alerts, [false, false]);
  // Real Pi cancellation: no agent_before_settle, only settlement's aborted flag.
  const aborted = run(working, { type: "settled", aborted: true });
  assert.equal(aborted.activity.base, "idle");
  assert.equal(aborted.activity.unread, false);
  assert.deepEqual(aborted.alerts, [false]);
});
test("completion hidden behind an overlay alerts once it becomes visible", () => {
  const working = reduce(INITIAL, { type: "start" });
  const compaction = run(
    working,
    { type: "compact-start" },
    { type: "settled", aborted: false },
    { type: "compact-end", failed: false, aborted: false },
  );
  assert.deepEqual(compaction.alerts, [false, false, true]);
  assert.equal(visibleState(compaction.activity), "done");
  const dialog = run(
    working,
    { type: "prompt-start" },
    { type: "settled", aborted: false },
    { type: "prompt-end" },
  );
  assert.deepEqual(dialog.alerts, [true, false, true]);
  assert.deepEqual(
    run(
      dialog.activity,
      { type: "compact-start" },
      { type: "compact-end", failed: false, aborted: false },
    ).alerts,
    [false, false],
  );
});
test("/unread provenance is discarded with the unread mark it explained", () => {
  const { activity } = run(
    INITIAL,
    { type: "unread" },
    { type: "prompt-start" },
    { type: "start" },
    { type: "prompt-end" },
  );
  assert.deepEqual([activity.unread, activity.explicit], [false, false]);
  const waiting = run(
    activity,
    { type: "background", count: 1 },
    { type: "settled", aborted: false },
  ).activity;
  assert.deepEqual([visibleState(waiting), visibleUnread(waiting)], ["working", false]);
});
test("a new run discards earlier /unread provenance, even when settlement restores unread", () => {
  const { activity } = run(
    INITIAL,
    { type: "unread" },
    { type: "prompt-start" },
    { type: "start" },
    { type: "background", count: 1 },
    { type: "settled", aborted: false },
    { type: "prompt-end" },
  );
  assert.deepEqual([visibleState(activity), visibleUnread(activity)], ["working", false]);
  // Cancellation drops the mark; a later failure must still wait for background work.
  const cancelled = run(
    reduce(INITIAL, { type: "start" }),
    { type: "unread" },
    { type: "settled", aborted: true },
    { type: "background", count: 1 },
    { type: "compact-start" },
    { type: "compact-end", failed: true, aborted: false },
  ).activity;
  assert.deepEqual([visibleState(cancelled), visibleUnread(cancelled)], ["working", false]);
  // /unread during the current run still shows immediately.
  const marked = run(activity, { type: "unread" }).activity;
  assert.deepEqual([visibleState(marked), visibleUnread(marked)], ["working", true]);
});
test("an idle parent waiting on background subagents stays working; attention follows them", () => {
  const settled = reduce(reduce(INITIAL, { type: "start" }), { type: "settled", aborted: false });
  const waiting = reduce(settled, { type: "background", count: 2 });
  assert.equal(visibleState(waiting), "working");
  assert.equal(visibleUnread(waiting), false);
  const { activity: finished, alerts } = run(waiting, { type: "background", count: 0 });
  assert.equal(visibleState(finished), "done");
  assert.equal(visibleUnread(finished), true);
  assert.deepEqual(alerts, [true]);
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
