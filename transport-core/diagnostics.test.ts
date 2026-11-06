import assert from "node:assert/strict";
import test from "node:test";
import { reportDiagnostic, setDiagnosticSink, type DiagnosticLevel } from "./diagnostics.ts";
import type * as Diagnostics from "./diagnostics.ts";

test("every loaded copy of the module reports through the one installed sink", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  // A query string makes Node load a second, separate copy, as a host reloading extensions does.
  const specifier = "./diagnostics.ts?copy";
  const copy: typeof Diagnostics = await import(specifier);
  const seen: Array<[DiagnosticLevel, string]> = [];
  copy.setDiagnosticSink((level, message) => seen.push([level, message]));
  try {
    reportDiagnostic("error", "from the first copy");
  } finally {
    setDiagnosticSink(null);
  }
  copy.reportDiagnostic("warning", "after the sink is removed");

  assert.deepEqual(seen, [["error", "from the first copy"]]);
  assert.deepEqual(
    warn.mock.calls.map((call) => call.arguments),
    [["after the sink is removed"]],
  );
});
