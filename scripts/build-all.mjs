#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Keep this in dependency order so package exports that point at dist/*.js are
// available before downstream packages are imported by pi from a Git checkout.
const packages = [
  "transport-core",
  "broker-core",
  "pinet-core",
  "imessage-bridge",
  "slack-api",
  "nvim-bridge",
  "neon-psql",
  "openai-execution-shaping",
  "slack-bridge",
];

for (const workspace of packages) {
  const result = spawnSync(process.execPath, ["../scripts/build-package.mjs"], {
    cwd: path.join(repoRoot, workspace),
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
