import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const publishPackages = Object.freeze([
  { directory: "transport-core", packageName: "@pinet/transport-core" },
  { directory: "broker-core", packageName: "@pinet/broker-core" },
  { directory: "pinet-core", packageName: "@pinet/pinet-core" },
  { directory: "imessage-bridge", packageName: "@pinet/imessage-bridge" },
  { directory: "slack-bridge", packageName: "@pinet/slack-bridge" },
]);

export const publishPackageDirectories = Object.freeze(
  publishPackages.map(({ directory }) => directory),
);

const publishPackageNamesByDirectory = new Map(
  publishPackages.map(({ directory, packageName }) => [directory, packageName]),
);

const dependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"];
const publicDependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"];
const requiredPackageFiles = ["README.md", "LICENSE", "dist/"];

export function parseArgs(argv) {
  const args = {
    dryRun: true,
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
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

const bootstrapConfirmationPhrase = "bootstrap @pinet packages";

export function parseBootstrapArgs(argv) {
  const args = {
    dryRun: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--bootstrap-publish") {
      args.dryRun = false;
      continue;
    }
    if (arg === "--confirm") {
      index += 1;
      const confirmation = argv[index];
      if (!confirmation) {
        throw new Error("--confirm requires a confirmation phrase");
      }
      if (confirmation !== bootstrapConfirmationPhrase) {
        throw new Error(
          `Real npm org pinet bootstrap requires --confirm ${JSON.stringify(bootstrapConfirmationPhrase)}`,
        );
      }
      args.confirmed = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.dryRun && !args.confirmed) {
    throw new Error(
      `Real npm org pinet bootstrap requires --bootstrap-publish --confirm ${JSON.stringify(bootstrapConfirmationPhrase)}`,
    );
  }

  return { dryRun: args.dryRun };
}

export function getPublishPackages() {
  return [...publishPackageDirectories];
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

export function rewriteLocalDependencySpecs(packageDirectories, manifests) {
  const packageSet = new Set(packageDirectories);
  const patched = [];
  const byDirectory = new Map(manifests);

  for (const directory of packageDirectories) {
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
        if (!packageSet.has(dependencyDirectory)) {
          throw new Error(
            `${manifest.name} depends on ${dependencyEntry.manifest.name}, but ${dependencyDirectory} is not in the ${packageDirectories.join(", ")} publish package set`,
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
    const expectedName = publishPackageNamesByDirectory.get(directory);
    if (!manifest.name) errors.push(`${directory}: package.json must include name`);
    if (expectedName && manifest.name !== expectedName) {
      errors.push(`${directory}: package name must be ${expectedName} for npm org pinet publish`);
    }
    if (!manifest.version) errors.push(`${directory}: package.json must include version`);
    if (manifest.private === true) errors.push(`${manifest.name}: package must not be private`);
    if (manifest.publishConfig?.access !== "public") {
      errors.push(`${manifest.name}: publishConfig.access must be public`);
    }
    if (!manifest.license) errors.push(`${manifest.name}: package.json must include license`);
    if (!manifest.main) errors.push(`${manifest.name}: package.json must include main`);
    if (!manifest.types) errors.push(`${manifest.name}: package.json must include types`);
    for (const requiredFile of requiredPackageFiles) {
      if (!manifest.files?.includes(requiredFile)) {
        errors.push(`${manifest.name}: package files must include ${requiredFile}`);
      }
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

function declarationPathForJavaScript(exportedPath) {
  return exportedPath.endsWith(".js") ? exportedPath.replace(/\.js$/, ".d.ts") : undefined;
}

export async function validateBuildOutputs(repoRoot, entries) {
  const missing = [];
  const missingPackageFiles = [];

  for (const { directory, manifest } of entries) {
    const packageRoot = path.join(repoRoot, directory);

    for (const requiredFile of requiredPackageFiles) {
      const requiredPath = path.join(packageRoot, requiredFile.replace(/\/$/, ""));
      if (!(await pathExists(requiredPath))) {
        missingPackageFiles.push(`${manifest.name}: ${requiredFile}`);
      }
    }

    const exportedPaths = new Set([manifest.main, manifest.types]);

    for (const value of Object.values(manifest.exports ?? {})) {
      if (typeof value === "string" && value !== "./package.json") {
        exportedPaths.add(value);
        const declarationPath = declarationPathForJavaScript(value);
        if (declarationPath) exportedPaths.add(declarationPath);
      } else if (value && typeof value === "object") {
        for (const conditionalValue of Object.values(value)) {
          if (typeof conditionalValue === "string" && conditionalValue !== "./package.json") {
            exportedPaths.add(conditionalValue);
          }
        }
      }
    }

    const mainDeclarationPath = declarationPathForJavaScript(manifest.main ?? "");
    if (mainDeclarationPath) exportedPaths.add(mainDeclarationPath);

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

  if (missingPackageFiles.length > 0) {
    throw new Error(
      `Missing package files for npm publish:\n- ${missingPackageFiles.join("\n- ")}`,
    );
  }

  if (missing.length > 0) {
    throw new Error(`Missing build outputs for npm publish:\n- ${missing.join("\n- ")}`);
  }
}

function packagePath(parentDirectory, packageName) {
  return path.join(parentDirectory, ...packageName.split("/"));
}

function packageBaseName(specifier) {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope && name ? `${scope}/${name}` : specifier;
  }
  return specifier.split("/")[0];
}

function isBareTypeSpecifier(specifier) {
  return !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("node:");
}

function declaredPublicDependencies(manifest) {
  const dependencies = new Set();
  for (const field of publicDependencyFields) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      dependencies.add(name);
    }
  }
  return dependencies;
}

function declarationImports(source) {
  const specifiers = new Set();
  const importExportPattern =
    /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
  const dynamicImportPattern = /import\(["']([^"']+)["']\)/g;

  for (const pattern of [importExportPattern, dynamicImportPattern]) {
    for (const match of source.matchAll(pattern)) {
      specifiers.add(match[1]);
    }
  }

  return specifiers;
}

async function collectDeclarationFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectDeclarationFiles(absolutePath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".d.ts")) {
      files.push(absolutePath);
    }
  }

  return files;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findInstalledPackageRoot(repoRoot, packageRoot, packageName) {
  const candidates = [
    packagePath(path.join(packageRoot, "node_modules"), packageName),
    packagePath(path.join(repoRoot, "node_modules"), packageName),
    packagePath(path.join(repoRoot, "node_modules", ".pnpm", "node_modules"), packageName),
  ];

  for (const candidate of candidates) {
    if (await pathExists(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }

  return undefined;
}

async function linkPackage(nodeModulesDir, packageName, targetPath) {
  const linkPath = packagePath(nodeModulesDir, packageName);
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.rm(linkPath, { recursive: true, force: true });
  await fs.symlink(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function typeScriptCliPath(repoRoot) {
  return path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
}

export async function validatePublicTypeResolution(repoRoot, entries) {
  const targetNames = new Set(entries.map(({ manifest }) => manifest.name));
  const importedExternalDependencies = new Map();
  const publicTypeSpecifiers = new Set();
  const declarationErrors = [];

  for (const { directory, manifest } of entries) {
    const packageRoot = path.join(repoRoot, directory);
    const declaredDependencies = declaredPublicDependencies(manifest);
    const declarationFiles = await collectDeclarationFiles(path.join(packageRoot, "dist"));

    for (const declarationFile of declarationFiles) {
      const source = await fs.readFile(declarationFile, "utf8");
      for (const specifier of declarationImports(source)) {
        if (!isBareTypeSpecifier(specifier)) continue;

        publicTypeSpecifiers.add(specifier);

        const packageName = packageBaseName(specifier);
        if (packageName === manifest.name) continue;

        if (!declaredDependencies.has(packageName)) {
          declarationErrors.push(
            `${manifest.name}: ${path.relative(packageRoot, declarationFile)} imports ${packageName}, but package.json does not declare it in dependencies, optionalDependencies, or peerDependencies`,
          );
          continue;
        }

        if (!targetNames.has(packageName)) {
          const installedRoot = await findInstalledPackageRoot(repoRoot, packageRoot, packageName);
          if (!installedRoot) {
            declarationErrors.push(
              `${manifest.name}: ${packageName} is declared for public types but is not installed for the isolated type-resolution smoke test`,
            );
            continue;
          }
          importedExternalDependencies.set(packageName, installedRoot);
        }
      }
    }
  }

  if (declarationErrors.length > 0) {
    throw new Error(
      `Public declaration dependency validation failed:\n- ${declarationErrors.join("\n- ")}`,
    );
  }

  const tempRoot = await fs.mkdtemp(path.join(tmpdir(), "npm-publish-types-"));
  try {
    const nodeModulesDir = path.join(tempRoot, "node_modules");
    await fs.mkdir(nodeModulesDir, { recursive: true });

    for (const { directory, manifest } of entries) {
      await linkPackage(nodeModulesDir, manifest.name, path.join(repoRoot, directory));
    }
    for (const [packageName, installedRoot] of importedExternalDependencies) {
      await linkPackage(nodeModulesDir, packageName, installedRoot);
    }

    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`,
      "utf8",
    );
    const smokeImports = [
      ...entries.map(({ manifest }) => `import ${JSON.stringify(manifest.name)};`),
      ...[...publicTypeSpecifiers]
        .sort()
        .map(
          (specifier, index) =>
            `import type * as PublicType${index} from ${JSON.stringify(specifier)};`,
        ),
    ];
    await fs.writeFile(path.join(tempRoot, "index.ts"), `${smokeImports.join("\n")}\n`, "utf8");
    await fs.writeFile(
      path.join(tempRoot, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
            preserveSymlinks: true,
            skipLibCheck: true,
            types: [],
          },
          include: ["index.ts"],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const repoTypeScriptCliPath = typeScriptCliPath(repoRoot);
    const tscPath = (await pathExists(repoTypeScriptCliPath))
      ? repoTypeScriptCliPath
      : typeScriptCliPath(process.cwd());
    const result = spawnSync(process.execPath, [tscPath, "-p", "tsconfig.json"], {
      cwd: tempRoot,
      encoding: "utf8",
    });

    if (result.status !== 0) {
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
      throw new Error(
        `Public type-resolution smoke test failed with status ${result.status ?? 1}:\n${output}`,
      );
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}
