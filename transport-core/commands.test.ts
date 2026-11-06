import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { resolveCommand } from "./commands.ts";

test("resolveCommand uses the first executable file on PATH and falls back to the name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "transport-core-path-"));
  const original = process.env.PATH;
  const name = `transport-core-${randomUUID()}`;
  try {
    await mkdir(join(dir, "directory", name), { recursive: true });
    await mkdir(join(dir, "plain"));
    await writeFile(join(dir, "plain", name), "");
    await mkdir(join(dir, "executable"));
    await writeFile(join(dir, "executable", name), "", { mode: 0o755 });
    process.env.PATH = ["directory", "plain", "executable"]
      .map((entry) => join(dir, entry))
      .join(delimiter);
    assert.equal(resolveCommand(name), join(dir, "executable", name));
    const missing = `transport-core-missing-${randomUUID()}`;
    assert.equal(resolveCommand(missing), missing);
  } finally {
    process.env.PATH = original;
    await rm(dir, { recursive: true, force: true });
  }
});
