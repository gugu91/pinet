import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { afterEach, expect, it } from "vitest";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("atomically grants a process lease to exactly one concurrent Slack bridge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pinet-slack-concurrent-"));
  directories.push(directory);
  const modulePath = join(directory, "mapping.mjs");
  const databasePath = join(directory, "mapping.sqlite");
  buildSync({
    entryPoints: [new URL("./mapping.ts", import.meta.url).pathname],
    outfile: modulePath,
    bundle: true,
    format: "esm",
    platform: "node",
  });
  const childSource = `
    import(process.argv[1]).then(({ SqliteMappingStore }) => {
      try {
        const store = new SqliteMappingStore(process.argv[2]);
        console.log("acquired");
        setTimeout(() => store.close(), 300);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      }
    });
  `;
  const acquire = () =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ["-e", childSource, modulePath, databasePath]);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

  const results = await Promise.all([acquire(), acquire()]);
  expect(
    results.filter((result) => result.code === 0 && result.stdout.includes("acquired")),
  ).toHaveLength(1);
  expect(
    results.filter(
      (result) =>
        result.code === 2 && result.stderr.includes("already owned by another Slack bridge"),
    ),
  ).toHaveLength(1);
  expect(readFileSync(databasePath).byteLength).toBeGreaterThan(0);
});
