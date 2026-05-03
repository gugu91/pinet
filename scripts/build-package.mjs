#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";

const packageDir = process.cwd();
const packageName = path.basename(packageDir);
const distDir = path.join(packageDir, "dist");

const packageConfigs = {
  "transport-core": {
    excludeDirs: new Set(["dist", "node_modules", ".turbo"]),
    excludeFiles: new Set(),
    excludePrefixes: [],
    vendorDirs: [],
    importRewrites: [],
  },
  "broker-core": {
    excludeDirs: new Set(["dist", "node_modules", ".turbo"]),
    excludeFiles: new Set(),
    excludePrefixes: [],
    vendorDirs: [],
    importRewrites: [],
  },
  "pinet-core": {
    excludeDirs: new Set(["dist", "node_modules", ".turbo"]),
    excludeFiles: new Set(),
    excludePrefixes: [],
    vendorDirs: [],
    importRewrites: [],
  },
  "imessage-bridge": {
    excludeDirs: new Set(["dist", "node_modules", ".turbo"]),
    excludeFiles: new Set(),
    excludePrefixes: [],
    vendorDirs: [],
    importRewrites: [],
  },
  "slack-bridge": {
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
  "compaction-worker": {
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

  for (const assetDir of config.assetDirs ?? []) {
    await copyDirectory(path.join(packageDir, assetDir), path.join(distDir, assetDir));
  }
}

await build();
