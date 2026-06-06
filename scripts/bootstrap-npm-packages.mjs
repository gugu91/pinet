#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertVersionsNotAlreadyPublished,
  getPublishPackages,
  loadWorkspaceManifests,
  parseBootstrapArgs,
  parseNpmViewVersionExists,
  publishPackages,
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

function assertNpmOrgBootstrapLogin() {
  const result = spawnSync("npm", ["whoami", "--registry", "https://registry.npmjs.org"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });

  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(
      `One-time @pinet package bootstrap requires an existing npm CLI login as a pinet org owner/admin. Run npm login with the appropriate npm account first; this repo does not configure token auth. npm whoami failed${output ? `:\n${output}` : "."}`,
    );
  }

  console.log(`npm CLI account for bootstrap: ${result.stdout.trim()}`);
}

function printBootstrapPlan({ dryRun }) {
  console.log("npm org pinet first-publish bootstrap plan");
  console.log(`Mode: ${dryRun ? "dry-run/readiness only" : "REAL one-time bootstrap publish"}`);
  console.log("Package set, in dependency order:");
  for (const { packageName, directory } of publishPackages) {
    console.log(`- ${packageName} from ${directory}/`);
  }
  console.log(
    dryRun
      ? "No packages will be published. The script will build, validate, patch local file: dependencies to exact versions in a temporary checkout state, and run npm publish --dry-run for every package."
      : "Packages WILL be published with npm publish --access public from the local npm CLI login. Use this only for first package creation in the npm pinet org; configure npm Trusted Publishing immediately afterward for normal future CI publishes.",
  );
}

async function main() {
  const args = parseBootstrapArgs(process.argv.slice(2));
  const packageDirectories = getPublishPackages();
  const manifests = await loadWorkspaceManifests(repoRoot);
  const entries = rewriteLocalDependencySpecs(packageDirectories, manifests);

  printBootstrapPlan(args);
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
      assertVersionsNotAlreadyPublished(entries, versionExists);
      assertNpmOrgBootstrapLogin();
    }

    for (const { directory, manifest } of entries) {
      const publishArgs = ["publish", "--access", "public"];
      if (args.dryRun) {
        publishArgs.push("--dry-run");
      }

      console.log(
        `${args.dryRun ? "Dry-run bootstrap publishing" : "Bootstrap publishing"} ${manifest.name}@${manifest.version}`,
      );
      run("npm", publishArgs, { cwd: path.join(repoRoot, directory) });
    }

    if (!args.dryRun) {
      console.log(
        "Bootstrap publish complete. Configure npm Trusted Publishing for every @pinet/* package before using the GitHub Actions publish workflow.",
      );
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
