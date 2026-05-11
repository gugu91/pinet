#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";

// pi installs Git packages with `npm install --omit=dev`, so dev-only tools like
// husky are intentionally unavailable there. Keep local developer installs
// convenient without making production/package installs fail.
if (process.env.NODE_ENV === "production" || process.env.npm_config_omit?.includes("dev")) {
  process.exit(0);
}

const huskyLookup = spawnSync("sh", ["-c", "command -v husky >/dev/null 2>&1"]);
if (huskyLookup.status !== 0) {
  process.exit(0);
}

const result = spawnSync("husky", { stdio: "inherit", shell: true });
process.exit(result.status ?? 0);
