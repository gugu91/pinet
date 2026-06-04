import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertLocalNpmOrgBootstrapEnvironment,
  assertVersionsNotAlreadyPublished,
  getPublishPackages,
  parseArgs,
  parseBootstrapArgs,
  parseNpmViewVersionExists,
  rewriteLocalDependencySpecs,
  validateBuildOutputs,
  validatePublicTypeResolution,
  validatePublishMetadata,
} from "./npm-publish-helpers.mjs";

function entry(directory, manifest) {
  return {
    directory,
    manifest,
    packageJsonPath: `${directory}/package.json`,
  };
}

test("getPublishPackages returns the full publish set in dependency order", () => {
  assert.deepEqual(getPublishPackages(), [
    "transport-core",
    "broker-core",
    "pinet-core",
    "imessage-bridge",
    "slack-bridge",
  ]);
});

test("parseArgs defaults to dry-run and accepts publish mode", () => {
  assert.deepEqual(parseArgs([]), { dryRun: true });
  assert.deepEqual(parseArgs(["--publish"]), { dryRun: false });
  assert.throws(() => parseArgs(["--target", "pinet"]), /Unknown argument: --target/);
});

test("parseBootstrapArgs defaults to dry-run and requires scary real-publish confirmation", () => {
  assert.deepEqual(parseBootstrapArgs([]), { dryRun: true });
  assert.deepEqual(parseBootstrapArgs(["--dry-run"]), { dryRun: true });
  assert.deepEqual(
    parseBootstrapArgs(["--bootstrap-publish", "--confirm", "bootstrap @pinet packages"]),
    { dryRun: false },
  );
  assert.throws(
    () => parseBootstrapArgs(["--bootstrap-publish"]),
    /requires --bootstrap-publish --confirm/,
  );
  assert.throws(
    () => parseBootstrapArgs(["--bootstrap-publish", "--confirm", "publish all"]),
    /requires --confirm "bootstrap @pinet packages"/,
  );
  assert.throws(() => parseBootstrapArgs(["--target", "pinet"]), /Unknown argument: --target/);
});

test("assertLocalNpmOrgBootstrapEnvironment blocks CI and token-authenticated live bootstrap contexts", () => {
  assert.doesNotThrow(() => assertLocalNpmOrgBootstrapEnvironment({ PATH: "/usr/bin" }));
  assert.throws(
    () => assertLocalNpmOrgBootstrapEnvironment({ CI: "true" }),
    /local-maintainer-only.*CI/,
  );
  assert.throws(
    () => assertLocalNpmOrgBootstrapEnvironment({ GITHUB_ACTIONS: "true" }),
    /local-maintainer-only.*GITHUB_ACTIONS/,
  );
  assert.throws(
    () => assertLocalNpmOrgBootstrapEnvironment({ NODE_AUTH_TOKEN: "token" }),
    /local-maintainer-only.*NODE_AUTH_TOKEN/,
  );
  assert.throws(
    () => assertLocalNpmOrgBootstrapEnvironment({ npm_config__authToken: "token" }),
    /local-maintainer-only.*npm_config__authToken/,
  );
  assert.throws(
    () => assertLocalNpmOrgBootstrapEnvironment({ npm_config__authtoken: "token" }),
    /local-maintainer-only.*npm_config__authtoken/,
  );
  assert.throws(
    () => assertLocalNpmOrgBootstrapEnvironment({ NPM_CONFIG__AUTHTOKEN: "token" }),
    /local-maintainer-only.*NPM_CONFIG__AUTHTOKEN/,
  );
  assert.throws(
    () => assertLocalNpmOrgBootstrapEnvironment({ npm_config_authToken: "token" }),
    /local-maintainer-only.*npm_config_authToken/,
  );
  assert.throws(
    () =>
      assertLocalNpmOrgBootstrapEnvironment({
        "npm_config_//registry.npmjs.org/:_authToken": "token",
      }),
    /local-maintainer-only.*npm_config_\/\/registry\.npmjs\.org\/:_authToken/,
  );
});

test("rewriteLocalDependencySpecs replaces in-set file dependencies with exact versions", () => {
  const manifests = new Map([
    [
      "transport-core",
      entry("transport-core", {
        name: "@pinet/transport-core",
        version: "0.1.0",
      }),
    ],
    [
      "broker-core",
      entry("broker-core", {
        name: "@pinet/broker-core",
        version: "0.1.0",
        dependencies: {
          "@pinet/transport-core": "file:../transport-core",
        },
      }),
    ],
  ]);

  const rewritten = rewriteLocalDependencySpecs(["transport-core", "broker-core"], manifests);

  assert.equal(rewritten[1].manifest.dependencies["@pinet/transport-core"], "0.1.0");
  assert.deepEqual(rewritten[1].rewrites, [
    "@pinet/transport-core: file:../transport-core -> 0.1.0",
  ]);
});

test("rewriteLocalDependencySpecs rejects local dependencies outside the publish set", () => {
  const manifests = new Map([
    [
      "transport-core",
      entry("transport-core", {
        name: "@pinet/transport-core",
        version: "0.1.0",
      }),
    ],
    [
      "broker-core",
      entry("broker-core", {
        name: "@pinet/broker-core",
        version: "0.1.0",
        dependencies: {
          "@pinet/transport-core": "file:../transport-core",
        },
      }),
    ],
  ]);

  assert.throws(
    () => rewriteLocalDependencySpecs(["broker-core"], manifests),
    /transport-core is not in the broker-core publish package set/,
  );
});

test("validatePublishMetadata blocks placeholder versions for real publish only", () => {
  const entries = [
    entry("pinet-core", {
      name: "@pinet/pinet-core",
      version: "0.0.0",
      license: "MIT",
      publishConfig: { access: "public" },
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      files: ["README.md", "LICENSE", "dist/"],
    }),
  ];

  assert.doesNotThrow(() => validatePublishMetadata(entries, { dryRun: true }));
  assert.throws(
    () => validatePublishMetadata(entries, { dryRun: false }),
    /placeholder version 0.0.0/,
  );
});

test("validatePublishMetadata requires declaration metadata", () => {
  const entries = [
    entry("pinet-core", {
      name: "@pinet/pinet-core",
      version: "0.0.0",
      license: "MIT",
      publishConfig: { access: "public" },
      main: "./dist/index.js",
      files: ["README.md", "LICENSE", "dist/"],
    }),
  ];

  assert.throws(() => validatePublishMetadata(entries, { dryRun: true }), /must include types/);
});

test("validatePublishMetadata requires npm org pinet package names", () => {
  const entries = [
    entry("pinet-core", {
      name: "@gugu910/pi-pinet-core",
      version: "0.0.0",
      license: "MIT",
      publishConfig: { access: "public" },
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      files: ["README.md", "LICENSE", "dist/"],
    }),
  ];

  assert.throws(
    () => validatePublishMetadata(entries, { dryRun: true }),
    /package name must be @pinet\/pinet-core/,
  );
});

test("validateBuildOutputs checks package files", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "npm-publish-package-files-"));
  await mkdir(path.join(repoRoot, "pinet-core", "dist"), { recursive: true });
  await writeFile(path.join(repoRoot, "pinet-core", "README.md"), "# pinet-core\n");
  await writeFile(path.join(repoRoot, "pinet-core", "dist", "index.js"), "export {};\n");
  await writeFile(path.join(repoRoot, "pinet-core", "dist", "index.d.ts"), "export {};\n");

  await assert.rejects(
    () =>
      validateBuildOutputs(repoRoot, [
        entry("pinet-core", {
          name: "@pinet/pinet-core",
          main: "./dist/index.js",
          types: "./dist/index.d.ts",
        }),
      ]),
    /LICENSE/,
  );
});

test("validateBuildOutputs checks JavaScript exports and declaration outputs", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "npm-publish-outputs-"));
  await mkdir(path.join(repoRoot, "pinet-core", "dist"), { recursive: true });
  await writeFile(path.join(repoRoot, "pinet-core", "README.md"), "# pinet-core\n");
  await writeFile(path.join(repoRoot, "pinet-core", "LICENSE"), "MIT\n");
  await writeFile(path.join(repoRoot, "pinet-core", "dist", "index.js"), "export {};\n");
  await writeFile(path.join(repoRoot, "pinet-core", "dist", "index.d.ts"), "export {};\n");
  await writeFile(path.join(repoRoot, "pinet-core", "dist", "helpers.js"), "export {};\n");

  await assert.rejects(
    () =>
      validateBuildOutputs(repoRoot, [
        entry("pinet-core", {
          name: "@pinet/pinet-core",
          main: "./dist/index.js",
          types: "./dist/index.d.ts",
          exports: {
            ".": "./dist/index.js",
            "./helpers": "./dist/helpers.js",
          },
        }),
      ]),
    /\.\/dist\/helpers\.d\.ts/,
  );

  await writeFile(path.join(repoRoot, "pinet-core", "dist", "helpers.d.ts"), "export {};\n");

  await assert.doesNotReject(() =>
    validateBuildOutputs(repoRoot, [
      entry("pinet-core", {
        name: "@pinet/pinet-core",
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
        exports: {
          ".": "./dist/index.js",
          "./helpers": "./dist/helpers.js",
        },
      }),
    ]),
  );
});

test("validatePublicTypeResolution catches undeclared declaration imports", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "npm-publish-types-"));
  const packageRoot = path.join(repoRoot, "example-package");
  await mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "example-package",
        type: "module",
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(path.join(packageRoot, "dist", "index.js"), "export {};\n");
  await writeFile(
    path.join(packageRoot, "dist", "index.d.ts"),
    'import type { MissingType } from "missing-public-types";\nexport type Example = MissingType;\n',
  );

  await assert.rejects(
    () =>
      validatePublicTypeResolution(repoRoot, [
        entry("example-package", {
          name: "example-package",
          main: "./dist/index.js",
          types: "./dist/index.d.ts",
        }),
      ]),
    /missing-public-types.*does not declare/s,
  );

  await mkdir(path.join(repoRoot, "node_modules", "missing-public-types"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "node_modules", "missing-public-types", "package.json"),
    `${JSON.stringify(
      {
        name: "missing-public-types",
        type: "module",
        main: "./index.js",
        types: "./index.d.ts",
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(path.join(repoRoot, "node_modules", "missing-public-types", "index.js"), "\n");
  await writeFile(
    path.join(repoRoot, "node_modules", "missing-public-types", "index.d.ts"),
    "export interface MissingType { value: string; }\n",
  );

  await assert.doesNotReject(() =>
    validatePublicTypeResolution(repoRoot, [
      entry("example-package", {
        name: "example-package",
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
        peerDependencies: {
          "missing-public-types": "*",
        },
      }),
    ]),
  );
});

test("validatePublicTypeResolution catches declared but unresolvable declaration subpaths", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "npm-publish-subpath-types-"));
  const packageRoot = path.join(repoRoot, "example-package");
  const dependencyRoot = path.join(repoRoot, "node_modules", "resolved-pkg");
  await mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await mkdir(dependencyRoot, { recursive: true });

  await writeFile(path.join(packageRoot, "dist", "index.js"), "export {};\n");
  await writeFile(
    path.join(packageRoot, "dist", "index.d.ts"),
    'import type { MissingSubpathType } from "resolved-pkg/missing-subpath";\nexport type Example = MissingSubpathType;\n',
  );
  await writeFile(
    path.join(dependencyRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "resolved-pkg",
        type: "module",
        main: "./index.js",
        types: "./index.d.ts",
        exports: {
          ".": {
            types: "./index.d.ts",
            default: "./index.js",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(path.join(dependencyRoot, "index.js"), "\n");
  await writeFile(path.join(dependencyRoot, "index.d.ts"), "export interface RootType {}\n");

  await assert.rejects(
    () =>
      validatePublicTypeResolution(repoRoot, [
        entry("example-package", {
          name: "example-package",
          main: "./dist/index.js",
          types: "./dist/index.d.ts",
          peerDependencies: {
            "resolved-pkg": "*",
          },
        }),
      ]),
    /resolved-pkg\/missing-subpath/s,
  );
});

test("validatePublicTypeResolution catches undeclared sibling publish-set declaration imports", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "npm-publish-sibling-types-"));
  const packageARoot = path.join(repoRoot, "package-a");
  const packageBRoot = path.join(repoRoot, "package-b");
  await mkdir(path.join(packageARoot, "dist"), { recursive: true });
  await mkdir(path.join(packageBRoot, "dist"), { recursive: true });

  await writeFile(path.join(packageARoot, "dist", "index.js"), "export {};\n");
  await writeFile(
    path.join(packageARoot, "dist", "index.d.ts"),
    'import type { SiblingType } from "package-b/subpath";\nexport type Example = SiblingType;\n',
  );
  await writeFile(path.join(packageBRoot, "dist", "index.js"), "export {};\n");
  await writeFile(path.join(packageBRoot, "dist", "index.d.ts"), "export {};\n");
  await writeFile(path.join(packageBRoot, "dist", "subpath.js"), "export {};\n");
  await writeFile(
    path.join(packageBRoot, "dist", "subpath.d.ts"),
    "export interface SiblingType { value: string; }\n",
  );
  await writeFile(
    path.join(packageARoot, "package.json"),
    `${JSON.stringify(
      {
        name: "package-a",
        type: "module",
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(packageBRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "package-b",
        type: "module",
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
        exports: {
          ".": {
            types: "./dist/index.d.ts",
            default: "./dist/index.js",
          },
          "./subpath": {
            types: "./dist/subpath.d.ts",
            default: "./dist/subpath.js",
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const packageBEntry = entry("package-b", {
    name: "package-b",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
  });

  await assert.rejects(
    () =>
      validatePublicTypeResolution(repoRoot, [
        entry("package-a", {
          name: "package-a",
          main: "./dist/index.js",
          types: "./dist/index.d.ts",
        }),
        packageBEntry,
      ]),
    /package-b.*does not declare/s,
  );

  await assert.doesNotReject(() =>
    validatePublicTypeResolution(repoRoot, [
      entry("package-a", {
        name: "package-a",
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
        dependencies: {
          "package-b": "0.1.0",
        },
      }),
      packageBEntry,
    ]),
  );
});

test("parseNpmViewVersionExists distinguishes found, not-found, and lookup errors", () => {
  assert.equal(
    parseNpmViewVersionExists(
      { status: 0, stdout: "0.1.0\n", stderr: "" },
      "@pinet/broker-core",
      "0.1.0",
    ),
    true,
  );
  assert.equal(
    parseNpmViewVersionExists(
      { status: 1, stdout: "", stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found" },
      "@pinet/broker-core",
      "0.1.0",
    ),
    false,
  );
  assert.throws(
    () =>
      parseNpmViewVersionExists(
        { status: 1, stdout: "", stderr: "npm ERR! network timeout" },
        "@pinet/broker-core",
        "0.1.0",
      ),
    /Unable to verify @pinet\/broker-core@0.1.0/,
  );
  assert.throws(
    () =>
      parseNpmViewVersionExists(
        { status: 1, stdout: "", stderr: "" },
        "@pinet/broker-core",
        "0.1.0",
      ),
    /Unable to verify @pinet\/broker-core@0.1.0/,
  );
});

test("assertVersionsNotAlreadyPublished fails closed for existing versions", () => {
  const entries = [
    entry("transport-core", {
      name: "@pinet/transport-core",
      version: "0.1.0",
    }),
    entry("broker-core", {
      name: "@pinet/broker-core",
      version: "0.1.0",
    }),
  ];

  assert.throws(
    () =>
      assertVersionsNotAlreadyPublished(
        entries,
        (packageName, version) => packageName === "@pinet/broker-core" && version === "0.1.0",
      ),
    /@pinet\/broker-core@0.1.0/,
  );
});
