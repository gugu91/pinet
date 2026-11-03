import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("typechecks source when a build removes discovered declarations", () => {
  const packageDir = path.resolve("slack-bridge");
  const dist = path.join(packageDir, "dist");
  const generated = path.join(dist, "typecheck-race-fixture.d.ts");
  mkdirSync(dist, { recursive: true });
  writeFileSync(generated, "export {};\n");
  try {
    const config = ts.readConfigFile(path.join(packageDir, "tsconfig.json"), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageDir);
    const host = ts.createCompilerHost(parsed.options);
    const readFile = host.readFile;
    // A concurrent package build removes dist after tsc has enumerated its inputs.
    host.readFile = (file) => (file.startsWith(`${dist}${path.sep}`) ? undefined : readFile(file));
    const program = ts.createProgram(parsed.fileNames, parsed.options, host);
    const errors = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.category === ts.DiagnosticCategory.Error);
    expect(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  } finally {
    rmSync(generated, { force: true });
  }
}, 30_000);
