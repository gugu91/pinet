import assert from "node:assert/strict";
import { test } from "vitest";
import {
  INITIAL,
  encode,
  parseRecord,
  reduce,
  rollup,
  shouldBell,
  visibleState,
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
    const settled = reduce(pending, { type: "settled" });
    assert.equal(visibleState(settled), state);
    assert.equal(settled.unread, outcome !== "aborted");
  }
});
test("retry success supersedes a transient error", () => {
  let activity = reduce(INITIAL, { type: "start" });
  activity = reduce(activity, { type: "outcome", outcome: "error" });
  activity = reduce(activity, { type: "outcome", outcome: "completed" });
  assert.equal(reduce(activity, { type: "settled" }).base, "done");
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
  const done = reduce(reduce(INITIAL, { type: "start" }), { type: "settled" });
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
  activity = reduce(activity, { type: "settled" });
  assert.equal(visibleState(activity), "blocked");
  activity = reduce(activity, { type: "prompt-end" });
  assert.equal(visibleState(activity), "done");
  assert.equal(activity.unread, true);
});
test("bells fire on attention transitions, not repeats, acknowledgements or cancellation", () => {
  const working = reduce(INITIAL, { type: "start" });
  const blocked = reduce(working, { type: "prompt-start" });
  const done = reduce(working, { type: "settled" });
  assert.equal(shouldBell(working, blocked), true);
  assert.equal(shouldBell(working, done), true);
  assert.equal(shouldBell(blocked, reduce(blocked, { type: "prompt-start" })), false);
  assert.equal(shouldBell(done, reduce(done, { type: "settled" })), false);
  const acked = reduce(done, { type: "ack" });
  assert.equal(shouldBell(done, acked), false);
  assert.deepEqual(reduce(acked, { type: "settled" }), acked);
  const aborted = reduce(reduce(working, { type: "outcome", outcome: "aborted" }), {
    type: "settled",
  });
  assert.equal(shouldBell(working, aborted), false);
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
test("rollup counts panes, deduplicates linked windows, and separates unread", () => {
  const working = { pane: "%1", window: "@1", record };
  assert.equal(rollup([]), "");
  assert.equal(
    rollup([
      working,
      working,
      {
        pane: "%2",
        window: "@1",
        record: { ...record, state: "blocked", unread: false },
      },
      {
        pane: "%3",
        window: "@2",
        record: { ...record, state: "done", unread: true },
      },
    ]),
    "Pi 🙋 1 · ⚙️ 1 · ✅ 1 · 🔔 1",
  );
});
