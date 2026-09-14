import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildTiers, flattenBuildTiers, testDependencyTiers } from "./build-all.mjs";

const workspaceConfig = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const expectedBuildPackages = [];
for (const workspace of workspaceConfig.workspaces) {
  const manifest = JSON.parse(
    await readFile(new URL(`../${workspace}/package.json`, import.meta.url), "utf8"),
  );
  if (manifest.scripts?.build) expectedBuildPackages.push(workspace);
}

const distExportDependencies = {
  "broker-core": ["transport-core"],
  "imessage-bridge": ["transport-core"],
  "pinet-core": ["broker-core", "transport-core"],
  "slack-bridge": ["broker-core", "imessage-bridge", "pinet-core", "transport-core"],
};

test("build tiers cover every dist-building package exactly once", () => {
  const flattened = flattenBuildTiers();

  assert.deepEqual([...flattened].sort(), [...expectedBuildPackages].sort());
  assert.equal(new Set(flattened).size, flattened.length);
});

test("build tiers keep dist-export dependencies in earlier tiers", () => {
  assertTierDependencies(buildTiers, distExportDependencies);
});

test("test dependency tiers cover only the dist exports needed before tests", () => {
  assert.deepEqual(flattenBuildTiers(testDependencyTiers), [
    "transport-core",
    "broker-core",
    "imessage-bridge",
    "pinet-core",
  ]);
  assertTierDependencies(testDependencyTiers, {
    "broker-core": ["transport-core"],
    "imessage-bridge": ["transport-core"],
    "pinet-core": ["broker-core", "transport-core"],
  });
});

test("the root Pi manifest loads only the built Slack bridge", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const slackBridgeEntries = manifest.pi.extensions.filter((entry) =>
    entry.includes("slack-bridge"),
  );

  assert.deepEqual(slackBridgeEntries, ["./slack-bridge/dist/index.js"]);
});

function assertTierDependencies(tiers, dependenciesByPackage) {
  const tierByPackage = new Map();
  tiers.forEach((tier, tierIndex) => {
    tier.forEach((workspace) => tierByPackage.set(workspace, tierIndex));
  });

  for (const [workspace, dependencies] of Object.entries(dependenciesByPackage)) {
    const workspaceTier = tierByPackage.get(workspace);
    assert.notEqual(workspaceTier, undefined, `${workspace} is missing from build tiers`);

    for (const dependency of dependencies) {
      const dependencyTier = tierByPackage.get(dependency);
      assert.notEqual(dependencyTier, undefined, `${dependency} is missing from build tiers`);
      assert.ok(
        dependencyTier < workspaceTier,
        `${dependency} must build before ${workspace} because package exports resolve to dist`,
      );
    }
  }
}
