#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertReleaseTagVersionMatchesManifests,
  getPublishPackages,
  loadWorkspaceManifests,
  rewriteLocalDependencySpecs,
} from "./npm-publish-helpers.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const ref = process.argv[2] ?? process.env.GITHUB_REF;
  if (!ref) {
    throw new Error("Tag version validation requires a Git ref argument or GITHUB_REF");
  }

  const packageDirectories = getPublishPackages();
  const manifests = await loadWorkspaceManifests(repoRoot);
  const entries = rewriteLocalDependencySpecs(packageDirectories, manifests);
  const version = assertReleaseTagVersionMatchesManifests(ref, entries);
  console.log(`Validated ${entries.length} @pinet/* package versions match ${ref} (${version})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
