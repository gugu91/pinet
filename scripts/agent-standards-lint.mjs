#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const IMPLEMENTATION_TS_PATTERN = /\.ts$/;
const DECLARATION_TS_PATTERN = /\.d\.ts$/;
const TEST_TS_PATTERN = /(?:^|[./])[^/]*\.test\.ts$/;
const GENERATED_PATH_SEGMENTS = new Set(["node_modules", "dist"]);

function runGit(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", options.allowFailure ? "ignore" : "pipe"],
  }).trim();
}

function tryGit(args) {
  try {
    return runGit(args, { allowFailure: true });
  } catch {
    return null;
  }
}

function splitLines(value) {
  return value.length === 0 ? [] : value.split("\n").filter(Boolean);
}

function isRelevantTypeScriptFile(filePath) {
  if (!IMPLEMENTATION_TS_PATTERN.test(filePath)) return false;
  if (DECLARATION_TS_PATTERN.test(filePath)) return false;
  return !filePath.split("/").some((segment) => GENERATED_PATH_SEGMENTS.has(segment));
}

function isRelevantSourceFile(filePath) {
  return isRelevantTypeScriptFile(filePath) && !TEST_TS_PATTERN.test(filePath);
}

function resolveBaseRef() {
  const explicit = process.env.AGENT_STANDARDS_BASE_REF;
  const candidates = explicit ? [explicit] : ["origin/main", "main", "HEAD~1"];

  for (const candidate of candidates) {
    const mergeBase = tryGit(["merge-base", "HEAD", candidate]);
    if (mergeBase) return mergeBase;
  }

  return null;
}

export function parseNameStatusEntries(nameStatusText) {
  const entries = [];

  for (const line of splitLines(nameStatusText)) {
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    if (status.startsWith("R")) {
      const [, oldPath, newPath] = parts;
      if (oldPath && newPath && isRelevantTypeScriptFile(newPath)) {
        entries.push({ path: newPath, basePath: oldPath });
      }
      continue;
    }

    if (status.startsWith("C")) {
      const [, , newPath] = parts;
      if (newPath && isRelevantTypeScriptFile(newPath)) {
        entries.push({ path: newPath, basePath: null });
      }
      continue;
    }

    const [, filePath] = parts;
    if (filePath && isRelevantTypeScriptFile(filePath)) {
      entries.push({ path: filePath, basePath: status === "A" ? null : filePath });
    }
  }

  return entries;
}

function listChangedFileEntries(baseRef) {
  const files = new Map();
  const diffSpecs = [
    ["diff", "--name-status", "-M", "--diff-filter=ACMR", `${baseRef}...HEAD`, "--", "*.ts"],
    ["diff", "--name-status", "-M", "--diff-filter=ACMR", baseRef, "--", "*.ts"],
    ["diff", "--cached", "--name-status", "-M", "--diff-filter=ACMR", "--", "*.ts"],
  ];

  for (const spec of diffSpecs) {
    for (const entry of parseNameStatusEntries(tryGit(spec) ?? "")) {
      files.set(entry.path, entry);
    }
  }

  for (const filePath of splitLines(
    tryGit(["ls-files", "--others", "--exclude-standard", "--", "*.ts"]) ?? "",
  )) {
    if (isRelevantTypeScriptFile(filePath)) files.set(filePath, { path: filePath, basePath: null });
  }

  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function readCurrentFile(filePath) {
  if (!existsSync(filePath)) return "";
  return readFileSync(filePath, "utf8");
}

function readBaseFile(baseRef, filePath) {
  if (!filePath) return "";
  return tryGit(["show", `${baseRef}:${filePath}`]) ?? "";
}

export function countTypeEscapeHatches(sourceText, fileName = "input.ts") {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const counts = { unknown: 0, any: 0 };

  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.UnknownKeyword) counts.unknown += 1;
    if (node.kind === ts.SyntaxKind.AnyKeyword) counts.any += 1;
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return counts;
}

export function buildDiffArgsForEntry(baseRef, entry) {
  const paths =
    entry.basePath && entry.basePath !== entry.path ? [entry.basePath, entry.path] : [entry.path];
  return ["diff", "--unified=0", "-M", baseRef, "--", ...paths];
}

function parseAddedLineRanges(diffText, filePath, currentSourceText) {
  if (diffText.trim().length === 0) {
    const isUntracked = splitLines(
      tryGit(["ls-files", "--others", "--exclude-standard", "--", filePath]) ?? "",
    ).includes(filePath);
    if (!isUntracked) return [];
    const lineCount = currentSourceText.length === 0 ? 0 : currentSourceText.split("\n").length;
    return lineCount > 0 ? [{ start: 1, end: lineCount }] : [];
  }

  const ranges = [];
  for (const line of diffText.split("\n")) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const length = match[2] == null ? 1 : Number(match[2]);
    if (length > 0) ranges.push({ start, end: start + length - 1 });
  }
  return ranges;
}

function lineIsAdded(lineNumber, addedLineRanges) {
  return addedLineRanges.some((range) => lineNumber >= range.start && lineNumber <= range.end);
}

function isExportedNode(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function hasSingleUseHelperIgnore(sourceText, position) {
  const precedingText = sourceText.slice(Math.max(0, position - 300), position);
  return /agent-standards-ignore\s+prefer-inline-single-use-helper/.test(precedingText);
}

function collectTopLevelHelperNames(sourceFile) {
  const helperNames = new Set();

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && !isExportedNode(statement)) {
      helperNames.add(statement.name.text);
      continue;
    }

    if (!ts.isVariableStatement(statement) || isExportedNode(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const initializer = declaration.initializer;
      if (
        initializer &&
        (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
      ) {
        helperNames.add(declaration.name.text);
      }
    }
  }

  return helperNames;
}

function collectTopLevelHelperDeclarations(
  sourceFile,
  sourceText,
  addedLineRanges,
  existingHelperNames,
) {
  const helpers = [];

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && !isExportedNode(statement)) {
      const start = statement.name.getStart(sourceFile);
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
      const lineNumber = line + 1;
      if (
        lineIsAdded(lineNumber, addedLineRanges) &&
        !existingHelperNames.has(statement.name.text) &&
        !hasSingleUseHelperIgnore(sourceText, start)
      ) {
        helpers.push({ name: statement.name.text, line: lineNumber, column: character + 1 });
      }
      continue;
    }

    if (!ts.isVariableStatement(statement) || isExportedNode(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const initializer = declaration.initializer;
      if (
        !initializer ||
        (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer))
      ) {
        continue;
      }
      const start = declaration.name.getStart(sourceFile);
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
      const lineNumber = line + 1;
      if (
        lineIsAdded(lineNumber, addedLineRanges) &&
        !existingHelperNames.has(declaration.name.text) &&
        !hasSingleUseHelperIgnore(sourceText, start)
      ) {
        helpers.push({ name: declaration.name.text, line: lineNumber, column: character + 1 });
      }
    }
  }

  return helpers;
}

function countIdentifierReferences(sourceFile, name) {
  let count = 0;

  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === name) count += 1;
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return count;
}

export function findSingleUseAddedHelpers(
  sourceText,
  fileName,
  addedLineRanges,
  baseSourceText = "",
) {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const baseSourceFile = ts.createSourceFile(
    fileName,
    baseSourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const helpers = collectTopLevelHelperDeclarations(
    sourceFile,
    sourceText,
    addedLineRanges,
    collectTopLevelHelperNames(baseSourceFile),
  );

  return helpers.filter((helper) => countIdentifierReferences(sourceFile, helper.name) === 2);
}

function formatCountDelta(ruleName, current, base) {
  const delta = current - base;
  return `${ruleName} increased from ${base} to ${current} (+${delta})`;
}

function main() {
  const baseRef = resolveBaseRef();
  if (!baseRef) {
    console.log("agent-standards-lint: skipped because no git base ref was available.");
    return;
  }

  const changedFiles = listChangedFileEntries(baseRef);
  if (changedFiles.length === 0) return;

  const errors = [];
  let currentUnknown = 0;
  let baseUnknown = 0;
  let currentAny = 0;
  let baseAny = 0;

  for (const entry of changedFiles) {
    const currentSource = readCurrentFile(entry.path);
    const baseSource = readBaseFile(baseRef, entry.basePath);
    const currentCounts = countTypeEscapeHatches(currentSource, entry.path);
    const baseCounts = countTypeEscapeHatches(baseSource, entry.basePath ?? entry.path);
    currentUnknown += currentCounts.unknown;
    baseUnknown += baseCounts.unknown;
    currentAny += currentCounts.any;
    baseAny += baseCounts.any;

    if (!isRelevantSourceFile(entry.path)) continue;
    const diffText = tryGit(buildDiffArgsForEntry(baseRef, entry)) ?? "";
    const addedLineRanges = parseAddedLineRanges(diffText, entry.path, currentSource);
    for (const helper of findSingleUseAddedHelpers(
      currentSource,
      entry.path,
      addedLineRanges,
      baseSource,
    )) {
      errors.push(
        `${entry.path}:${helper.line}:${helper.column} prefer-inline-single-use-helper: "${helper.name}" is a newly added helper with one call site. Inline it. If it is a real semantic seam, keep it and add "agent-standards-ignore prefer-inline-single-use-helper: <reason>" immediately above it.`,
      );
    }
  }

  if (currentUnknown > baseUnknown) {
    errors.push(
      `no-new-unknown: ${formatCountDelta("explicit unknown type count", currentUnknown, baseUnknown)} across changed TypeScript implementation files. Do not introduce unknown in internal code; parse external/serialized inputs at the boundary into named DTO/domain types first. If you were about to add a generic isRecord guard, stop and fix the boundary model before continuing.`,
    );
  }

  if (currentAny > baseAny) {
    errors.push(
      `no-new-any: ${formatCountDelta("explicit any type count", currentAny, baseAny)} across changed TypeScript implementation files. Avoid any; use precise types or a tiny documented escape hatch with tests when TypeScript cannot express a generic constraint.`,
    );
  }

  if (errors.length > 0) {
    console.error("agent-standards-lint failed:\n");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  }
}

const currentModulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentModulePath) {
  main();
}
