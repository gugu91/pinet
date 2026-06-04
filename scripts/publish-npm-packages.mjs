#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertVersionsNotAlreadyPublished,
  getPublishPackages,
  loadWorkspaceManifests,
  parseArgs,
  parseNpmViewVersionExists,
  rewriteLocalDependencySpecs,
  validateBuildOutputs,
  validatePublicTypeResolution,
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
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status ?? 1}`);
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

function assertTrustedPublishingRuntime() {
  if (process.env.GITHUB_ACTIONS !== "true") {
    throw new Error(
      "Real npm publishing requires the GitHub Actions Trusted Publishing/OIDC workflow context; run the Publish npm packages workflow from main instead of local token publishing.",
    );
  }
  if (!process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || !process.env.ACTIONS_ID_TOKEN_REQUEST_URL) {
    throw new Error(
      "Real npm publishing requires GitHub OIDC id-token access for npm Trusted Publishing; check id-token: write and the npm-publish environment.",
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageDirectories = getPublishPackages();
  const manifests = await loadWorkspaceManifests(repoRoot);
  const entries = rewriteLocalDependencySpecs(packageDirectories, manifests);

  validatePublishMetadata(entries, { dryRun: args.dryRun });

  run("pnpm", ["run", "build:packages"]);
  await validateBuildOutputs(repoRoot, entries);
  await validatePublicTypeResolution(repoRoot, entries);

  const originalManifests = entries.map(({ directory, packageJsonPath }) => ({
    packageJsonPath,
    manifest: manifests.get(directory).manifest,
  }));
  let wrotePatchedManifests = false;

  try {
    for (const entry of entries) {
      await writeJson(entry.packageJsonPath, entry.manifest);
      wrotePatchedManifests = true;
      for (const rewrite of entry.rewrites) {
        console.log(`${entry.manifest.name}: ${rewrite}`);
      }
    }

    if (!args.dryRun) {
      assertTrustedPublishingRuntime();
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
  } finally {
    if (wrotePatchedManifests) {
      for (const original of originalManifests) {
        await writeJson(original.packageJsonPath, original.manifest);
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
