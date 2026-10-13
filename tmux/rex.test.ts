import assert from "node:assert/strict";
import { test } from "vitest";
import { CLEAR, parseClients, report, relay, type RelayTransport } from "./rex.ts";
import type { PaneStatus, State } from "./helpers.ts";
function pane(state: State, unread = false, name = "cool beans"): PaneStatus {
  return {
    pane: "%1",
    window: "@1",
    name,
    record: {
      pid: 1,
      started: "YWJj",
      owner: "00000000-0000-4000-8000-000000000000",
      state,
      unread,
    },
  };
}
test("Rex protocol is namespaced, uses ST, encodes names, maps compaction to working", () => {
  assert.equal(report([], "test"), CLEAR);
  const frame = report([pane("compacting")], "test");
  assert.ok(frame.startsWith("\x1b]7501;state=working:id=pi-tmux:app=tmux:"));
  assert.ok(frame.endsWith("\x1b\\"));
  assert.equal(
    Buffer.from(frame.split(":msg=")[1].slice(0, -2), "base64").toString(),
    "cool beans: 1 compacting",
  );
  assert.ok(!frame.includes("\x07"));
});
test("unread results inform aggregate; ack clears attention but not blocked or busy", () => {
  for (const [state, unread, expected] of [
    ["done", true, "done"],
    ["done", false, "idle"],
    ["error", true, "error"],
    ["error", false, "idle"],
    ["blocked", false, "blocked"],
    ["working", false, "working"],
  ] as const) {
    assert.ok(report([pane(state, unread)], "test").includes(`state=${expected}:`));
  }
  assert.ok(
    report([pane("working"), { ...pane("blocked"), pane: "%2" }], "test").includes(
      "state=blocked:",
    ),
  );
});
test("client parser excludes controls, suspended clients and non-TTY paths", () => {
  assert.equal(parseClients("1\t/dev/ttys123\t456\t$1\t0\t\tmain").length, 1);
  assert.equal(parseClients("1\t/dev/pts/12\t456\t$1\t0\t\tmain").length, 1);
  for (const row of [
    "1\t/tmp/file\t456\t$1\t0\t\tmain",
    "1\t/dev/ttys123\t456\t$1\t1\t\tmain",
    "1\t/dev/ttys123\t456\t$1\t0\tsuspended\tmain",
  ])
    assert.equal(parseClients(row).length, 0);
});
test("relay requires per-client opt-in, deduplicates, switches session, clears only its own ID", async () => {
  const options = new Map<string, string>();
  let session = "$1";
  let panes = [pane("working")];
  const targets: string[] = [];
  const writes: string[] = [];
  const tmux: RelayTransport = {
    run: async (args) => {
      if (args[0] === "list-clients") return `123\t/dev/ttys123\t456\t${session}\t0\t\tmain`;
      if (args[0] === "show-options") return options.get(args[2]) ?? "";
      if (args[0] === "set-option") {
        if (args[1] === "-su") options.delete(args[2]);
        else options.set(args[2], args[3]);
        return "";
      }
      throw new Error(args.join(" "));
    },
    snapshot: async (target) => {
      targets.push(target);
      return panes;
    },
  };
  const write = async (_client: object, frame: string) => {
    writes.push(frame);
  };
  await relay(tmux, 123, "tick", write);
  assert.equal(writes.length, 0);
  await relay(tmux, 123, "on", write);
  assert.equal(writes.length, 1);
  await relay(tmux, 123, "tick", write);
  assert.equal(writes.length, 1);
  session = "$2";
  await relay(tmux, 123, "tick", write);
  assert.equal(writes.length, 2, "session switch updates even with identical records");
  assert.equal(targets.at(-1), "$2");
  panes = [];
  await relay(tmux, 123, "tick", write);
  assert.equal(writes.at(-1), CLEAR);
  await relay(tmux, 123, "off", write);
  assert.equal(writes.at(-1), CLEAR);
  const previous = writes.length;
  await relay(tmux, 123, "tick", write);
  assert.equal(writes.length, previous);
});
