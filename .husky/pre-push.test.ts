import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("skips checks only for deletion-only pushes", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pinet-pre-push-"));
  try {
    const trace = path.join(dir, "trace");
    writeFileSync(path.join(dir, "pnpm"), '#!/bin/sh\necho "$*" >> "$TRACE"\nexit 17\n', {
      mode: 0o755,
    });
    const deletion = `(delete) ${"0".repeat(40)} refs/heads/old ${"1".repeat(40)}\n`;
    const update = `refs/heads/new ${"2".repeat(40)} refs/heads/new ${"0".repeat(40)}\n`;
    for (const [input, expected] of [
      [deletion + deletion, 0],
      [deletion + update, 17],
      [update, 17],
      ["", 17],
    ] as const) {
      writeFileSync(trace, "");
      const result = spawnSync("sh", [".husky/pre-push"], {
        input,
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TRACE: trace },
      });
      expect(result.status).toBe(expected);
      expect(readFileSync(trace, "utf8")).toBe(expected === 0 ? "" : "prepush\n");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
