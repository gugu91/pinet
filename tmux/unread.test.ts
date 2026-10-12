import assert from "node:assert/strict";
import { test } from "vitest";
import { INITIAL, reduce, visibleState, type Activity } from "./helpers.ts";

test("manual unread preserves every execution state and survives temporary dialogs", () => {
  const activities: Activity[] = [
    INITIAL,
    { ...INITIAL, base: "working" },
    { ...INITIAL, compacting: true },
    { ...INITIAL, base: "done" },
    { ...INITIAL, base: "error" },
    { ...INITIAL, prompts: 1 },
  ];
  for (const activity of activities) {
    const marked = reduce(activity, { type: "unread" });
    assert.equal(visibleState(marked), visibleState(activity));
    assert.equal(marked.unread, true);
    assert.equal(marked.resumeUnread, true);
    const acknowledged = reduce(marked, { type: "ack" });
    assert.equal(acknowledged.unread, false);
    assert.equal(acknowledged.resumeUnread, false);
    assert.equal(visibleState(acknowledged), visibleState(activity));
  }
  const blocked = reduce({ ...INITIAL, prompts: 1 }, { type: "unread" });
  assert.equal(reduce(blocked, { type: "prompt-end" }).unread, true);
});
