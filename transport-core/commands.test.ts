import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { resolveCommand } from "./commands.ts";

async function withPath(
  run: (dir: string, name: string, setPath: (...entries: string[]) => void) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "transport-core-path-"));
  const original = process.env.PATH;
  try {
    await run(dir, `transport-core-${randomUUID()}`, (...entries) => {
      process.env.PATH = entries.join(delimiter);
    });
  } finally {
    process.env.PATH = original;
    await rm(dir, { recursive: true, force: true });
  }
}

async function executable(path: string): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "", { mode: 0o755 });
  return path;
}

test(
  "resolveCommand uses the first executable file on PATH and falls back to the name",
  { skip: process.platform === "win32" },
  async () => {
    await withPath(async (dir, name, setPath) => {
      await mkdir(join(dir, "directory", name), { recursive: true });
      await mkdir(join(dir, "plain"));
      await writeFile(join(dir, "plain", name), "");
      const expected = await executable(join(dir, "executable", name));
      setPath(join(dir, "directory"), join(dir, "plain"), join(dir, "executable"));
      assert.equal(resolveCommand(name), expected);
      assert.equal(resolveCommand(`${name}-missing`), `${name}-missing`);
    });
  },
);

test("resolveCommand follows PATH changes", { skip: process.platform === "win32" }, async () => {
  await withPath(async (dir, name, setPath) => {
    const first = await executable(join(dir, "a", name));
    const second = await executable(join(dir, "b", name));
    setPath(join(dir, "a"));
    assert.equal(resolveCommand(name), first);
    setPath(join(dir, "b"));
    assert.equal(resolveCommand(name), second);
  });
});

test(
  "resolveCommand resolves relative PATH entries against the child's cwd",
  { skip: process.platform === "win32" },
  async () => {
    await withPath(async (dir, name, setPath) => {
      const local = await executable(join(dir, "child", "bin", name));
      const fallback = await executable(join(dir, "abs", name));
      setPath("bin", join(dir, "abs"));
      assert.equal(resolveCommand(name, join(dir, "child")), local);
      assert.equal(resolveCommand(name, dir), fallback);
      setPath("", join(dir, "abs"));
      assert.equal(resolveCommand(name, join(dir, "child", "bin")), local);
      assert.equal(resolveCommand(`./${name}`), `./${name}`);
    });
  },
);
