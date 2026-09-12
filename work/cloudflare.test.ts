import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { Miniflare } from "miniflare";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function createMiniflare(persist: string): Miniflare {
  const scriptPath = join(persist, "work-worker.mjs");
  buildSync({
    entryPoints: [new URL("./cloudflare.ts", import.meta.url).pathname],
    outfile: scriptPath,
    bundle: true,
    format: "esm",
    platform: "neutral",
    external: ["node:*"],
  });
  return new Miniflare({
    modules: true,
    script: readFileSync(scriptPath, "utf8"),
    compatibilityDate: "2025-04-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { WORK: { className: "WorkDurableObject", useSQLite: true } },
    durableObjectsPersist: persist,
    bindings: { PINET_WORK_TOKENS: JSON.stringify(["secret"]) },
  });
}

describe("Work Durable Object parity", () => {
  it("persists CRUD and cascading deletion across emulator restarts", async () => {
    const persist = mkdtempSync(join(tmpdir(), "pinet-work-do-"));
    directories.push(persist);
    let mf = createMiniflare(persist);
    const headers = {
      authorization: "Bearer secret",
      "content-type": "application/json",
      "x-pinet-workspace": "parity",
    };
    const projectResponse = await mf.dispatchFetch("http://local/v1/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ markdown: "project" }),
    });
    expect(projectResponse.status).toBe(201);
    const project = (await projectResponse.json()) as { data: { id: string } };
    const taskResponse = await mf.dispatchFetch("http://local/v1/tasks", {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId: project.data.id, markdown: "task" }),
    });
    const task = (await taskResponse.json()) as { data: { id: string } };
    expect(taskResponse.status).toBe(201);
    await mf.dispose();

    mf = createMiniflare(persist);
    expect(
      (
        await mf.dispatchFetch(`http://local/v1/projects/${project.data.id}`, {
          method: "DELETE",
          headers,
        })
      ).status,
    ).toBe(204);
    expect(
      (await mf.dispatchFetch(`http://local/v1/tasks/${task.data.id}`, { headers })).status,
    ).toBe(404);
    await mf.dispose();

    mf = createMiniflare(persist);
    expect(
      (await mf.dispatchFetch(`http://local/v1/tasks/${task.data.id}`, { headers })).status,
    ).toBe(404);
    await mf.dispose();
  });
});
