import { existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = process.cwd();
const siteDir = path.join(repoRoot, "docs", "_site");

test("build-docs-site creates the static Pinet documentation site", () => {
  rmSync(siteDir, { recursive: true, force: true });

  execFileSync("node", ["scripts/build-docs-site.mjs"], {
    cwd: repoRoot,
    stdio: "pipe",
  });

  for (const page of [
    "index.html",
    "setup.html",
    "configuration.html",
    "usage.html",
    "architecture.html",
    "troubleshooting.html",
    "reference.html",
  ]) {
    assert.equal(existsSync(path.join(siteDir, page)), true, `${page} should exist`);
  }
});
