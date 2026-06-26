#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";

const packageDir = process.cwd();
const packageName = path.basename(packageDir);
const repoRoot = path.resolve(packageDir, "..");
const distDir = path.join(packageDir, "dist");

const packageConfigs = {
  "transport-core": {
    declaration: true,
    excludeDirs: new Set(["dist", "node_modules", ".turbo"]),
    excludeFiles: new Set(),
    excludePrefixes: [],
    vendorDirs: [],
    importRewrites: [],
  },
  "broker-core": {
    declaration: true,
    excludeDirs: new Set(["dist", "node_modules", ".turbo"]),
    excludeFiles: new Set(),
    excludePrefixes: [],
    vendorDirs: [],
    importRewrites: [],
  },
  "pinet-core": {
    declaration: true,
    excludeDirs: new Set(["dist", "node_modules", ".turbo"]),
    excludeFiles: new Set(),
    excludePrefixes: [],
    vendorDirs: [],
    importRewrites: [],
  },
  "imessage-bridge": {
    declaration: true,
    excludeDirs: new Set(["dist", "node_modules", ".turbo"]),
    excludeFiles: new Set(),
    excludePrefixes: [],
    vendorDirs: [],
    importRewrites: [],
  },
  "slack-bridge": {
    declaration: true,
    excludeDirs: new Set(["dist", "node_modules", ".turbo"]),
    excludeFiles: new Set(["vitest.config.ts"]),
    excludePrefixes: [],
    vendorDirs: [],
    assetDirs: ["prompts", "skins"],
    importRewrites: [],
  },
  "nvim-bridge": {
    excludeDirs: new Set(["dist", "node_modules", ".turbo", "nvim"]),
    excludeFiles: new Set(["vitest.config.ts"]),
    excludePrefixes: [],
    vendorDirs: [],
    importRewrites: [],
  },
  "neon-psql": {
    excludeDirs: new Set(["dist", "node_modules", ".turbo", "python"]),
    excludeFiles: new Set(["vitest.config.ts"]),
    excludePrefixes: [],
    vendorDirs: [],
    importRewrites: [],
  },
  "slack-api": {
    excludeDirs: new Set(["dist", "node_modules", ".turbo"]),
    excludeFiles: new Set(),
    excludePrefixes: ["scripts/"],
    vendorDirs: [],
    importRewrites: [],
  },
  "openai-execution-shaping": {
    excludeDirs: new Set(["dist", "node_modules", ".turbo"]),
    excludeFiles: new Set(),
    excludePrefixes: [],
    vendorDirs: [],
    importRewrites: [],
  },
  "model-aware-compaction": {
    declaration: true,
    excludeDirs: new Set(["dist", "node_modules", ".turbo"]),
    excludeFiles: new Set(),
    excludePrefixes: [],
    vendorDirs: [],
    importRewrites: [],
  },
};

const config = packageConfigs[packageName];
if (!config) {
  throw new Error(`Unsupported package for build-package.mjs: ${packageName}`);
}

function shouldInclude(relativePath, localConfig = config) {
  if (!relativePath.endsWith(".ts")) return false;
  if (relativePath.endsWith(".d.ts")) return false;
  if (relativePath.endsWith(".test.ts")) return false;
  if (localConfig.excludeFiles.has(relativePath)) return false;
  if (localConfig.excludePrefixes.some((prefix) => relativePath.startsWith(prefix))) return false;

  const parts = relativePath.split(path.sep);
  return !parts.some((part) => localConfig.excludeDirs.has(part));
}

function rewriteRelativeTsSpecifiers(source, relativePath) {
  let rewritten = source.replace(/(["'])(\.\.?\/[^"']+)\.ts\1/g, "$1$2.js$1");
  for (const rewrite of config.importRewrites) {
    if (!rewrite.files.has(relativePath)) {
      continue;
    }
    rewritten = rewritten.replaceAll(rewrite.from, rewrite.to);
  }
  return rewritten;
}

async function collectTsFiles(baseDir, rootDir, localConfig = config) {
  const entries = await fs.readdir(baseDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(baseDir, entry.name);
    const relativePath = path.relative(rootDir, absolutePath);

    if (entry.isDirectory()) {
      if (localConfig.excludeDirs.has(entry.name)) {
        continue;
      }
      files.push(...(await collectTsFiles(absolutePath, rootDir, localConfig)));
      continue;
    }

    if (shouldInclude(relativePath, localConfig)) {
      files.push(relativePath);
    }
  }

  return files.sort();
}

async function copyDirectory(sourceDir, outputDir) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  await fs.mkdir(outputDir, { recursive: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const outputPath = path.join(outputDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, outputPath);
      continue;
    }

    if (entry.isFile()) {
      await fs.copyFile(sourcePath, outputPath);
    }
  }
}

async function collectAmbientDeclarations() {
  const typesDir = path.join(repoRoot, "types");
  try {
    const entries = await fs.readdir(typesDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".d.ts"))
      .map((entry) => path.join(typesDir, entry.name))
      .sort();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function emitDeclarations(sourceFiles) {
  if (!config.declaration) return;

  const rootNames = [
    ...sourceFiles.map((relativePath) => path.join(packageDir, relativePath)),
    ...(await collectAmbientDeclarations()),
  ];
  const compilerOptions = {
    allowImportingTsExtensions: true,
    declaration: true,
    declarationDir: distDir,
    emitDeclarationOnly: true,
    forceConsistentCasingInFileNames: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: false,
    outDir: distDir,
    rootDir: packageDir,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    types: ["node"],
    verbatimModuleSyntax: true,
  };
  const host = ts.createCompilerHost(compilerOptions);
  const program = ts.createProgram(rootNames, compilerOptions, host);
  const emitResult = program.emit(undefined, undefined, undefined, true);
  const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emitResult.diagnostics].filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );

  if (diagnostics.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => packageDir,
        getNewLine: () => "\n",
      }),
    );
  }
}

async function build() {
  await fs.rm(distDir, { recursive: true, force: true });

  const workItems = [];
  const sourceFiles = await collectTsFiles(packageDir, packageDir);
  for (const relativePath of sourceFiles) {
    workItems.push({
      inputPath: path.join(packageDir, relativePath),
      outputPath: path.join(distDir, relativePath.replace(/\.ts$/, ".js")),
      relativePath,
      rewriteKey: relativePath,
    });
  }

  for (const vendor of config.vendorDirs) {
    const vendorSourceDir = path.resolve(packageDir, vendor.source);
    const vendorConfig = {
      excludeDirs: new Set(["dist", "node_modules", ".turbo"]),
      excludeFiles: new Set(),
      excludePrefixes: [],
    };
    const vendorFiles = await collectTsFiles(vendorSourceDir, vendorSourceDir, vendorConfig);
    for (const relativePath of vendorFiles) {
      workItems.push({
        inputPath: path.join(vendorSourceDir, relativePath),
        outputPath: path.join(distDir, vendor.output, relativePath.replace(/\.ts$/, ".js")),
        relativePath,
        rewriteKey: relativePath,
      });
    }
  }

  for (const item of workItems) {
    const sourceText = await fs.readFile(item.inputPath, "utf8");
    const rewritten = rewriteRelativeTsSpecifiers(sourceText, item.rewriteKey);
    const transpiled = ts.transpileModule(rewritten, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        verbatimModuleSyntax: true,
      },
      fileName: item.inputPath,
      reportDiagnostics: true,
    });

    const diagnostics = transpiled.diagnostics ?? [];
    const blocking = diagnostics.filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    if (blocking.length > 0) {
      throw new Error(
        ts.formatDiagnosticsWithColorAndContext(blocking, {
          getCanonicalFileName: (fileName) => fileName,
          getCurrentDirectory: () => packageDir,
          getNewLine: () => "\n",
        }),
      );
    }

    await fs.mkdir(path.dirname(item.outputPath), { recursive: true });
    await fs.writeFile(item.outputPath, transpiled.outputText, "utf8");
  }

  await emitDeclarations(sourceFiles);

  for (const assetDir of config.assetDirs ?? []) {
    await copyDirectory(path.join(packageDir, assetDir), path.join(distDir, assetDir));
  }
}

await build();
