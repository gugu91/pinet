#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Keep tiers in dependency order so package exports that point at dist/*.js are
// available before downstream packages emit declarations or are imported by pi
// from a Git checkout. Workspaces within a tier have no dist-export dependency
// on each other and can build in parallel.
export const buildTiers = [
  [
    "transport-core",
    "nvim-bridge",
    "neon-psql",
    "slack-api",
    "openai-execution-shaping",
    "model-aware-compaction",
  ],
  ["broker-core", "imessage-bridge"],
  ["pinet-core"],
  ["slack-bridge", "amp-worker"],
];

// The test suite imports most packages from TypeScript source via Vitest aliases,
// but slack-bridge has a publish-readiness test that builds its package. That
// declaration emit needs these upstream dist-export packages to exist first.
export const testDependencyTiers = [
  ["transport-core"],
  ["broker-core", "imessage-bridge"],
  ["pinet-core"],
];

export function flattenBuildTiers(tiers = buildTiers) {
  return tiers.flat();
}

function buildWorkspace(workspace) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["../scripts/build-package.mjs"], {
      cwd: path.join(repoRoot, workspace),
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const suffix = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      reject(new Error(`${workspace} build failed with ${suffix}`));
    });
  });
}

export async function buildAll(tiers = buildTiers) {
  for (const tier of tiers) {
    const results = await Promise.allSettled(tier.map((workspace) => buildWorkspace(workspace)));
    const failures = results.flatMap((result) => {
      if (result.status === "fulfilled") {
        return [];
      }

      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      return [reason];
    });

    if (failures.length > 0) {
      throw new Error(
        `Build tier failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
      );
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (import.meta.url === invokedPath) {
  try {
    const tiers = process.argv.includes("--test-deps") ? testDependencyTiers : buildTiers;
    await buildAll(tiers);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
