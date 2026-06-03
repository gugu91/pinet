import { promises as fs } from "node:fs";
import path from "node:path";

export const publishTargets = Object.freeze({
  pinet: ["transport-core", "broker-core", "pinet-core"],
  "slack-bridge": [
    "transport-core",
    "broker-core",
    "pinet-core",
    "imessage-bridge",
    "slack-bridge",
  ],
});

const dependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"];

export function parseArgs(argv) {
  const args = {
    dryRun: true,
    target: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--publish") {
      args.dryRun = false;
      continue;
    }
    if (arg === "--target") {
      args.target = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--target=")) {
      args.target = arg.slice("--target=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

export function getTargetPackages(target) {
  const packages = publishTargets[target];
  if (!packages) {
    throw new Error(
      `Unknown npm publish target "${target}". Expected one of: ${Object.keys(publishTargets).join(", ")}`,
    );
  }
  return packages;
}

export async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

export async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function loadWorkspaceManifests(repoRoot) {
  const rootPackageJson = await readJson(path.join(repoRoot, "package.json"));
  const workspaceDirs = rootPackageJson.workspaces ?? [];
  const manifests = new Map();

  for (const directory of workspaceDirs) {
    const packageJsonPath = path.join(repoRoot, directory, "package.json");
    const manifest = await readJson(packageJsonPath);
    manifests.set(directory, {
      directory,
      manifest,
      packageJsonPath,
    });
  }

  return manifests;
}

export function rewriteLocalDependencySpecs(targetDirectories, manifests) {
  const targetSet = new Set(targetDirectories);
  const patched = [];
  const byDirectory = new Map(manifests);

  for (const directory of targetDirectories) {
    const entry = byDirectory.get(directory);
    if (!entry) {
      throw new Error(`Target package directory is not a workspace: ${directory}`);
    }

    const manifest = structuredClone(entry.manifest);
    const rewrites = [];

    for (const field of dependencyFields) {
      const dependencies = manifest[field];
      if (!dependencies) continue;

      for (const [dependencyName, specifier] of Object.entries(dependencies)) {
        if (typeof specifier !== "string" || !specifier.startsWith("file:")) {
          continue;
        }

        const dependencyDirectory = path.normalize(
          path.join(directory, specifier.slice("file:".length)),
        );
        const dependencyEntry = byDirectory.get(dependencyDirectory);
        if (!dependencyEntry) {
          throw new Error(
            `${manifest.name} has unsupported local dependency ${dependencyName}@${specifier}`,
          );
        }
        if (!targetSet.has(dependencyDirectory)) {
          throw new Error(
            `${manifest.name} depends on ${dependencyEntry.manifest.name}, but ${dependencyDirectory} is not in the ${targetDirectories.join(", ")} publish target`,
          );
        }
        if (dependencyName !== dependencyEntry.manifest.name) {
          throw new Error(
            `${manifest.name} declares ${dependencyName}@${specifier}, but ${dependencyDirectory} is named ${dependencyEntry.manifest.name}`,
          );
        }

        dependencies[dependencyName] = dependencyEntry.manifest.version;
        rewrites.push(`${dependencyName}: ${specifier} -> ${dependencyEntry.manifest.version}`);
      }
    }

    patched.push({
      ...entry,
      manifest,
      rewrites,
    });
  }

  return patched;
}

export function validatePublishMetadata(entries, { dryRun }) {
  const errors = [];

  for (const { directory, manifest } of entries) {
    if (!manifest.name) errors.push(`${directory}: package.json must include name`);
    if (!manifest.version) errors.push(`${directory}: package.json must include version`);
    if (manifest.private === true) errors.push(`${manifest.name}: package must not be private`);
    if (manifest.publishConfig?.access !== "public") {
      errors.push(`${manifest.name}: publishConfig.access must be public`);
    }
    if (!manifest.main) errors.push(`${manifest.name}: package.json must include main`);
    if (!manifest.files?.includes("dist/")) {
      errors.push(`${manifest.name}: package files must include dist/`);
    }
    if (!dryRun && manifest.version === "0.0.0") {
      errors.push(`${manifest.name}: refusing a real npm publish at placeholder version 0.0.0`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`npm publish metadata validation failed:\n- ${errors.join("\n- ")}`);
  }
}

export function parseNpmViewVersionExists(result, packageName, version) {
  if (result.error) {
    throw new Error(`Unable to verify ${packageName}@${version} on npm: ${result.error.message}`);
  }

  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  const output = `${stdout}\n${stderr}`;

  if (result.status === 0) {
    if (stdout.trim() === version) {
      return true;
    }
    throw new Error(
      `Unable to verify ${packageName}@${version} on npm: unexpected npm view output ${JSON.stringify(stdout.trim())}`,
    );
  }

  if (/\bE404\b|404 Not Found|No match found/i.test(output)) {
    return false;
  }

  throw new Error(
    `Unable to verify ${packageName}@${version} on npm before publishing. npm view exited with status ${result.status}.`,
  );
}

export function assertVersionsNotAlreadyPublished(entries, versionExists) {
  const existing = [];

  for (const { manifest } of entries) {
    if (versionExists(manifest.name, manifest.version)) {
      existing.push(`${manifest.name}@${manifest.version}`);
    }
  }

  if (existing.length > 0) {
    throw new Error(
      `Refusing real npm publish because these versions already exist. Bump versions or start a new release.\n- ${existing.join("\n- ")}`,
    );
  }
}

export async function validateBuildOutputs(repoRoot, entries) {
  const missing = [];

  for (const { directory, manifest } of entries) {
    const packageRoot = path.join(repoRoot, directory);
    const exportedPaths = new Set([manifest.main]);

    for (const value of Object.values(manifest.exports ?? {})) {
      if (typeof value === "string" && value !== "./package.json") {
        exportedPaths.add(value);
      }
    }

    for (const exportedPath of exportedPaths) {
      if (typeof exportedPath !== "string") continue;
      const absolutePath = path.join(packageRoot, exportedPath);
      try {
        await fs.access(absolutePath);
      } catch {
        missing.push(`${manifest.name}: ${exportedPath}`);
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing build outputs for npm publish:\n- ${missing.join("\n- ")}`);
  }
}
