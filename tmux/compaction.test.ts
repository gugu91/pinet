import assert from "node:assert/strict";
import { test } from "vitest";
import { INITIAL, reduce, step, visibleState } from "./helpers.ts";
test("compaction overlays an active run and returns to working, without completion bell", () => {
  const working = reduce(INITIAL, { type: "start" });
  const compacting = reduce(working, { type: "compact-start" });
  assert.equal(visibleState(compacting), "compacting");
  const complete = reduce(compacting, {
    type: "compact-end",
    failed: false,
    aborted: false,
  });
  assert.equal(visibleState(complete), "working");
  assert.equal(
    step(compacting, { type: "compact-end", failed: false, aborted: false }).alert,
    false,
  );
});
test("manual compaction restores idle/done; failure becomes error; abort is not failure", () => {
  // As published: the completion alert was already shown before compaction started.
  const done = step(reduce(INITIAL, { type: "start" }), {
    type: "settled",
    aborted: false,
  }).activity;
  for (const prior of [INITIAL, done]) {
    const compacting = reduce(prior, { type: "compact-start" });
    const complete = reduce(compacting, {
      type: "compact-end",
      failed: false,
      aborted: false,
    });
    assert.equal(visibleState(complete), prior.base);
    assert.equal(
      step(compacting, { type: "compact-end", failed: false, aborted: false }).alert,
      false,
      "restored completion must not notify again",
    );
    const cancelled = reduce(compacting, {
      type: "compact-end",
      failed: true,
      aborted: true,
    });
    assert.equal(visibleState(cancelled), prior.base);
    const failed = reduce(compacting, {
      type: "compact-end",
      failed: true,
      aborted: false,
    });
    assert.equal(visibleState(failed), "error");
  }
});
test("prompt temporarily covers compaction; failure during active run waits for final outcome", () => {
  let activity = reduce(reduce(INITIAL, { type: "start" }), {
    type: "compact-start",
  });
  activity = reduce(activity, { type: "prompt-start" });
  assert.equal(visibleState(activity), "blocked");
  activity = reduce(activity, { type: "prompt-end" });
  assert.equal(visibleState(activity), "compacting");
  activity = reduce(activity, {
    type: "compact-end",
    failed: true,
    aborted: false,
  });
  assert.equal(visibleState(activity), "working");
});
