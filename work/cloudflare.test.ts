import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { Miniflare } from "miniflare";
import worker from "./cloudflare.js";
import type { WorkWorkerEnv } from "./cloudflare.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function createMiniflare(persist: string, legacy = false): Miniflare {
  const scriptPath = join(persist, "work-worker.mjs");
  buildSync({
    entryPoints: [
      new URL(legacy ? "./fixtures/legacy-worker.mjs" : "./cloudflare.ts", import.meta.url)
        .pathname,
    ],
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
  it("rejects authentication before Durable Object allocation and uses current token config", async () => {
    let allocations = 0;
    let forwarded = 0;
    const env: WorkWorkerEnv = {
      PINET_WORK_TOKENS: JSON.stringify(["first"]),
      PINET_WORKSPACE: "configured",
      WORK: {
        idFromName(name) {
          allocations += 1;
          expect(name).toBe("configured");
          return { name };
        },
        get() {
          return {
            fetch(request) {
              forwarded += 1;
              expect(request.headers.get("authorization")).toBeNull();
              expect(request.headers.get("x-pinet-workspace")).toBeNull();
              return Promise.resolve(Response.json({ status: "ok" }));
            },
          };
        },
      },
    };

    const rejected = await worker.fetch(
      new Request("https://work.example/v1/projects", {
        headers: { authorization: "Bearer wrong", "x-pinet-workspace": "attacker" },
      }),
      env,
    );
    expect(rejected.status).toBe(401);
    expect(allocations).toBe(0);
    expect(forwarded).toBe(0);

    for (const path of ["/v%31/projects", "/%76%31/projects", "/v1%2fprojects", "/other"]) {
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        expect(
          (await worker.fetch(new Request(`https://work.example${path}`, { method }), env)).status,
        ).toBe(401);
      }
    }
    expect((await worker.fetch(new Request("https://work.example/health"), env)).status).toBe(200);
    expect(allocations).toBe(0);
    expect(forwarded).toBe(0);

    env.PINET_WORK_TOKENS = JSON.stringify(["second"]);
    expect(
      (
        await worker.fetch(
          new Request("https://work.example/v1/projects", {
            headers: { authorization: "Bearer first" },
          }),
          env,
        )
      ).status,
    ).toBe(401);
    expect(allocations).toBe(0);

    expect(
      (
        await worker.fetch(
          new Request("https://work.example/v1/projects", {
            headers: { authorization: "Bearer second", "x-pinet-workspace": "attacker" },
          }),
          env,
        )
      ).status,
    ).toBe(200);
    expect(allocations).toBe(1);
    expect(forwarded).toBe(1);
  });

  it("preserves populated legacy Worker storage through migration and restart", async () => {
    const persist = mkdtempSync(join(tmpdir(), "pinet-work-legacy-do-"));
    directories.push(persist);
    let mf = createMiniflare(persist, true);
    try {
      expect((await mf.dispatchFetch("http://local/seed")).status).toBe(200);
    } finally {
      await mf.dispose();
    }
    const headers = { authorization: "Bearer secret" };
    for (let boot = 0; boot < 2; boot += 1) {
      mf = createMiniflare(persist);
      try {
        const project = await mf.dispatchFetch("http://local/v1/projects/legacy-project", {
          headers,
        });
        expect(project.status).toBe(200);
        expect(await project.json()).toEqual({
          data: {
            id: "legacy-project",
            markdown: "legacy project",
            externalChannel: "channel",
            createdAt: 1,
            updatedAt: 2,
          },
        });
        const task = await mf.dispatchFetch("http://local/v1/tasks/legacy-task", { headers });
        expect(task.status).toBe(200);
        expect(await task.json()).toEqual({
          data: {
            id: "legacy-task",
            projectId: "legacy-project",
            markdown: "legacy task",
            createdAt: 3,
            updatedAt: 4,
          },
        });
        if (boot === 1) {
          expect(
            (
              await mf.dispatchFetch("http://local/v1/projects/legacy-project", {
                method: "DELETE",
                headers,
              })
            ).status,
          ).toBe(204);
          expect(
            (await mf.dispatchFetch("http://local/v1/tasks/legacy-task", { headers })).status,
          ).toBe(404);
        }
      } finally {
        await mf.dispose();
      }
    }
  });

  it("rejects encoded unauthenticated routes in the bundled Worker", async () => {
    const persist = mkdtempSync(join(tmpdir(), "pinet-work-auth-do-"));
    directories.push(persist);
    const mf = createMiniflare(persist);
    try {
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        expect((await mf.dispatchFetch("http://local/v%31/projects", { method })).status).toBe(401);
      }
      const response = await mf.dispatchFetch("http://local/v%31/projects", {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({ markdown: "authenticated" }),
      });
      expect(response.status).toBe(201);
    } finally {
      await mf.dispose();
    }
  });

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
      headers: { ...headers, "x-pinet-workspace": "a-different-caller-value" },
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
