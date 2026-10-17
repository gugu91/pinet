import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

it("evaluates Pinet's natively imported modules again on each extension load", () => {
  // Mirror a Git install, <repo>/slack-bridge/dist, and a host that loads it like jiti does.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pinet-module-reload-")));
  roots.push(root);
  const repo = path.join(root, "repo");
  const dist = path.join(repo, "slack-bridge", "dist");
  const thirdParty = path.join(repo, "node_modules", "third-party");
  fs.mkdirSync(dist, { recursive: true });
  fs.mkdirSync(thirdParty, { recursive: true });
  fs.writeFileSync(path.join(repo, "slack-bridge", "package.json"), '{"type":"module"}');
  fs.writeFileSync(
    path.join(thirdParty, "package.json"),
    '{"name":"third-party","type":"module","exports":"./index.js"}',
  );
  fs.writeFileSync(
    path.join(thirdParty, "index.js"),
    "globalThis.thirdPartyLoads = (globalThis.thirdPartyLoads ?? 0) + 1;\n",
  );
  const hookSource = fs.readFileSync(path.join(import.meta.dirname, "module-reload.ts"), "utf8");
  fs.writeFileSync(
    path.join(dist, "module-reload.js"),
    `globalThis.hookModuleLoads = (globalThis.hookModuleLoads ?? 0) + 1;\n${
      ts.transpileModule(hookSource, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText
    }`,
  );
  fs.writeFileSync(
    path.join(dist, "index.js"),
    'import "./module-reload.js";\nimport "third-party";\nexport { VERSION } from "./version.js";\n',
  );
  const host = path.join(root, "host.mjs");
  fs.writeFileSync(
    host,
    `import { writeFileSync } from "node:fs";
const [entry, version] = process.argv.slice(2);
const versions = [];
for (const value of ["v1", "v2", "v3"]) {
  writeFileSync(
    version,
    \`globalThis.versionLoads = (globalThis.versionLoads ?? 0) + 1;\\nexport const VERSION = "\${value}";\\n\`,
  );
  versions.push((await import(entry)).VERSION);
  // jiti imports modules one at a time, so some arrive after the hook registers.
  if (value === "v1") await import(version);
}
const { hookModuleLoads, thirdPartyLoads, versionLoads } = globalThis;
console.log(JSON.stringify({ versions, hookModuleLoads, thirdPartyLoads, versionLoads }));
`,
  );

  const output = execFileSync(
    process.execPath,
    [host, path.join(dist, "index.js"), path.join(dist, "version.js")],
    { encoding: "utf8" },
  );

  expect(JSON.parse(output)).toEqual({
    versions: ["v1", "v2", "v3"],
    hookModuleLoads: 1,
    thirdPartyLoads: 1,
    versionLoads: 3,
  });
});
