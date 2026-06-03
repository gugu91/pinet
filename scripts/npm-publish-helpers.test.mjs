import test from "node:test";
import assert from "node:assert/strict";

import {
  assertVersionsNotAlreadyPublished,
  getTargetPackages,
  parseArgs,
  parseNpmViewVersionExists,
  rewriteLocalDependencySpecs,
  validatePublishMetadata,
} from "./npm-publish-helpers.mjs";

function entry(directory, manifest) {
  return {
    directory,
    manifest,
    packageJsonPath: `${directory}/package.json`,
  };
}

test("getTargetPackages keeps Pinet and Slack bridge targets separated", () => {
  assert.deepEqual(getTargetPackages("pinet"), ["transport-core", "broker-core", "pinet-core"]);
  assert.deepEqual(getTargetPackages("slack-bridge"), [
    "transport-core",
    "broker-core",
    "pinet-core",
    "imessage-bridge",
    "slack-bridge",
  ]);
});

test("parseArgs defaults to dry-run and accepts publish mode", () => {
  assert.deepEqual(parseArgs(["--target", "pinet"]), { target: "pinet", dryRun: true });
  assert.deepEqual(parseArgs(["--target=slack-bridge", "--publish"]), {
    target: "slack-bridge",
    dryRun: false,
  });
});

test("rewriteLocalDependencySpecs replaces in-target file dependencies with exact versions", () => {
  const manifests = new Map([
    [
      "transport-core",
      entry("transport-core", {
        name: "@gugu910/pi-transport-core",
        version: "0.1.0",
      }),
    ],
    [
      "broker-core",
      entry("broker-core", {
        name: "@gugu910/pi-broker-core",
        version: "0.1.0",
        dependencies: {
          "@gugu910/pi-transport-core": "file:../transport-core",
        },
      }),
    ],
  ]);

  const rewritten = rewriteLocalDependencySpecs(["transport-core", "broker-core"], manifests);

  assert.equal(rewritten[1].manifest.dependencies["@gugu910/pi-transport-core"], "0.1.0");
  assert.deepEqual(rewritten[1].rewrites, [
    "@gugu910/pi-transport-core: file:../transport-core -> 0.1.0",
  ]);
});

test("rewriteLocalDependencySpecs rejects local dependencies outside the target", () => {
  const manifests = new Map([
    [
      "transport-core",
      entry("transport-core", {
        name: "@gugu910/pi-transport-core",
        version: "0.1.0",
      }),
    ],
    [
      "broker-core",
      entry("broker-core", {
        name: "@gugu910/pi-broker-core",
        version: "0.1.0",
        dependencies: {
          "@gugu910/pi-transport-core": "file:../transport-core",
        },
      }),
    ],
  ]);

  assert.throws(
    () => rewriteLocalDependencySpecs(["broker-core"], manifests),
    /transport-core is not in the broker-core publish target/,
  );
});

test("validatePublishMetadata blocks placeholder versions for real publish only", () => {
  const entries = [
    entry("pinet-core", {
      name: "@gugu910/pi-pinet-core",
      version: "0.0.0",
      publishConfig: { access: "public" },
      main: "./dist/index.js",
      files: ["dist/"],
    }),
  ];

  assert.doesNotThrow(() => validatePublishMetadata(entries, { dryRun: true }));
  assert.throws(
    () => validatePublishMetadata(entries, { dryRun: false }),
    /placeholder version 0.0.0/,
  );
});

test("parseNpmViewVersionExists distinguishes found, not-found, and lookup errors", () => {
  assert.equal(
    parseNpmViewVersionExists(
      { status: 0, stdout: "0.1.0\n", stderr: "" },
      "@gugu910/pi-broker-core",
      "0.1.0",
    ),
    true,
  );
  assert.equal(
    parseNpmViewVersionExists(
      { status: 1, stdout: "", stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found" },
      "@gugu910/pi-broker-core",
      "0.1.0",
    ),
    false,
  );
  assert.throws(
    () =>
      parseNpmViewVersionExists(
        { status: 1, stdout: "", stderr: "npm ERR! network timeout" },
        "@gugu910/pi-broker-core",
        "0.1.0",
      ),
    /Unable to verify @gugu910\/pi-broker-core@0.1.0/,
  );
  assert.throws(
    () =>
      parseNpmViewVersionExists(
        { status: 1, stdout: "", stderr: "" },
        "@gugu910/pi-broker-core",
        "0.1.0",
      ),
    /Unable to verify @gugu910\/pi-broker-core@0.1.0/,
  );
});

test("assertVersionsNotAlreadyPublished fails closed for existing versions", () => {
  const entries = [
    entry("transport-core", {
      name: "@gugu910/pi-transport-core",
      version: "0.1.0",
    }),
    entry("broker-core", {
      name: "@gugu910/pi-broker-core",
      version: "0.1.0",
    }),
  ];

  assert.throws(
    () =>
      assertVersionsNotAlreadyPublished(
        entries,
        (packageName, version) => packageName === "@gugu910/pi-broker-core" && version === "0.1.0",
      ),
    /@gugu910\/pi-broker-core@0.1.0/,
  );
});
