#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertVersionsNotAlreadyPublished,
  getTargetPackages,
  loadWorkspaceManifests,
  parseArgs,
  parseNpmViewVersionExists,
  rewriteLocalDependencySpecs,
  validateBuildOutputs,
  validatePublishMetadata,
  writeJson,
} from "./npm-publish-helpers.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
    ...options,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function versionExists(packageName, version) {
  const result = spawnSync("npm", ["view", `${packageName}@${version}`, "version"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });

  return parseNpmViewVersionExists(result, packageName, version);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.target) {
    throw new Error("Missing required --target argument");
  }

  const targetDirectories = getTargetPackages(args.target);
  const manifests = await loadWorkspaceManifests(repoRoot);
  const entries = rewriteLocalDependencySpecs(targetDirectories, manifests);

  validatePublishMetadata(entries, { dryRun: args.dryRun });

  run("pnpm", ["run", "build"]);
  await validateBuildOutputs(repoRoot, entries);

  for (const entry of entries) {
    await writeJson(entry.packageJsonPath, entry.manifest);
    for (const rewrite of entry.rewrites) {
      console.log(`${entry.manifest.name}: ${rewrite}`);
    }
  }

  if (!args.dryRun) {
    if (!process.env.NPM_TOKEN) {
      throw new Error("NPM_TOKEN is required for real npm publishing");
    }
    assertVersionsNotAlreadyPublished(entries, versionExists);
  }

  for (const { directory, manifest } of entries) {
    const publishArgs = ["publish", "--access", "public"];
    if (args.dryRun) {
      publishArgs.push("--dry-run");
    } else {
      publishArgs.push("--provenance");
    }

    console.log(
      `${args.dryRun ? "Dry-run publishing" : "Publishing"} ${manifest.name}@${manifest.version}`,
    );
    run("npm", publishArgs, { cwd: path.join(repoRoot, directory) });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
