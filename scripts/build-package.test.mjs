import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a Pi Git install builds JavaScript without host packages such as pi-ai", async (t) => {
  // Outside the repo, so no node_modules supplies the host packages that Pi does not install.
  const root = await mkdtemp(path.join(os.tmpdir(), "pinet-pi-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDir = path.join(root, "model-aware-compaction");
  await cp(path.join(repoRoot, "model-aware-compaction"), packageDir, {
    recursive: true,
    filter: (source) => !/[/\\](node_modules|dist|\.turbo)$/.test(source),
  });
  await cp(path.join(repoRoot, "types"), path.join(root, "types"), { recursive: true });

  await promisify(execFile)(process.execPath, [path.join(repoRoot, "scripts/build-package.mjs")], {
    cwd: packageDir,
    env: { ...process.env, npm_config_omit: "dev" },
  });

  const dist = await readdir(path.join(packageDir, "dist"));
  assert.ok(dist.includes("index.js"));
  assert.ok(!dist.some((file) => file.endsWith(".d.ts")));
});
