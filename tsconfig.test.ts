import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("typechecks source when a build removes discovered declarations", () => {
  const packageDir = path.resolve("slack-bridge");
  const dist = path.join(packageDir, "dist");
  mkdirSync(dist, { recursive: true });
  const fixture = mkdtempSync(path.join(dist, "typecheck-race-"));
  try {
    const generated = path.join(fixture, "index.d.ts");
    writeFileSync(generated, "export {};\n");
    const config = ts.readConfigFile(path.join(packageDir, "tsconfig.json"), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageDir);
    rmSync(generated);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const errors = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.category === ts.DiagnosticCategory.Error);
    expect(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 30_000);
