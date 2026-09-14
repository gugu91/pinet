import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "./domain.js";
import { MemoryWorkStorage } from "./memory-storage.js";
import { createWorkApp, parseTokens } from "./server.js";
import { SqliteWorkStorage } from "./storage.js";

const auth = { authorization: "Bearer secret", "content-type": "application/json" };
const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("independent work API", () => {
  it("supports authenticated project/task CRUD, full replacement updates, search, and malformed input", async () => {
    let id = 0;
    let now = 0;
    const app = createWorkApp({
      storage: new MemoryWorkStorage(),
      tokens: ["secret"],
      id: () => String(++id),
      now: () => ++now,
    });

    expect((await app.request("/v1/projects")).status).toBe(401);
    expect(
      (await app.request("/v1/projects", { method: "POST", headers: auth, body: "[]" })).status,
    ).toBe(400);

    const projectResponse = await app.request("/v1/projects", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ markdown: "# Alpha" }),
    });
    const project = ((await projectResponse.json()) as { data: { id: string } }).data;
    const taskResponse = await app.request("/v1/tasks", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ projectId: project.id, markdown: "old" }),
    });
    const task = ((await taskResponse.json()) as { data: { id: string } }).data;
    const updated = await app.request(`/v1/tasks/${task.id}`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ markdown: "new body" }),
    });
    expect(((await updated.json()) as { data: { markdown: string } }).data.markdown).toBe(
      "new body",
    );

    const search = await app.request("/v1/search?q=new", { headers: auth });
    expect(((await search.json()) as { data: { tasks: object[] } }).data.tasks).toHaveLength(1);
    const bounded = await app.request("/v1/search?q=a&limit=1", { headers: auth });
    const boundedData = (await bounded.json()) as {
      data: { projects: object[]; tasks: object[] };
    };
    expect(boundedData.data.projects.length + boundedData.data.tasks.length).toBeLessThanOrEqual(1);

    expect(
      (await app.request(`/v1/projects/${project.id}`, { method: "DELETE", headers: auth })).status,
    ).toBe(204);
    expect((await app.request(`/v1/tasks/${task.id}`, { headers: auth })).status).toBe(404);
  });

  it("authenticates before storage access and enforces request field and streaming body limits", async () => {
    let storageReads = 0;
    class ObservedStorage extends MemoryWorkStorage {
      override listProjects(limit: number, offset: number): Project[] {
        storageReads += 1;
        return super.listProjects(limit, offset);
      }
    }
    const app = createWorkApp({ storage: new ObservedStorage(), tokens: ["secret"] });

    expect((await app.request("/v1/projects")).status).toBe(401);
    expect(storageReads).toBe(0);
    expect((await app.request(`/v1/search?q=${"x".repeat(257)}`, { headers: auth })).status).toBe(
      400,
    );
    expect(
      (
        await app.request("/v1/projects", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ markdown: "valid", ignored: "x".repeat(70_000) }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/v1/projects", {
          method: "POST",
          headers: { authorization: "Bearer secret" },
          body: JSON.stringify({ markdown: "valid" }),
        })
      ).status,
    ).toBe(400);
  });

  it("bounds Markdown independently of the byte limit", async () => {
    const app = createWorkApp({ storage: new MemoryWorkStorage(), tokens: ["secret"] });
    for (const [length, status] of [
      [32_768, 201],
      [32_769, 400],
    ]) {
      const response = await app.request("/v1/projects", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ markdown: "x".repeat(length) }),
      });
      expect(response.status).toBe(status);
    }
  });

  it("does not disclose storage failures", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    class FailingStorage extends MemoryWorkStorage {
      override listProjects(): Project[] {
        throw new Error("sqlite failed with secret=do-not-disclose");
      }
    }
    const app = createWorkApp({ storage: new FailingStorage(), tokens: ["secret"] });
    const response = await app.request("/v1/projects", { headers: auth });
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain("The request could not be completed");
    expect(body).not.toContain("sqlite");
    expect(body).not.toContain("do-not-disclose");
    expect(log).toHaveBeenCalledWith("Work request failed", {
      code: "internal_error",
      method: "GET",
    });
  });

  it("rejects empty, duplicate, and malformed token configuration", () => {
    expect(() => parseTokens("[]")).toThrow("non-empty");
    expect(() => parseTokens('["","valid"]')).toThrow("non-empty strings");
    expect(() => parseTokens('["same","same"]')).toThrow("unique");
    expect(() => parseTokens("not-json")).toThrow("valid JSON");
  });

  it("migrates an existing SQLite database and persists data across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "pinet-work-"));
    directories.push(directory);
    const path = join(directory, "work.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE pinet_projects (
        id TEXT PRIMARY KEY,
        markdown TEXT NOT NULL,
        external_channel TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE pinet_tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES pinet_projects(id) ON DELETE CASCADE,
        markdown TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    legacy
      .prepare("INSERT INTO pinet_projects VALUES (?, ?, ?, ?, ?)")
      .run("p", "saved", "channel", 1, 2);
    legacy
      .prepare("INSERT INTO pinet_tasks VALUES (?, ?, ?, ?, ?)")
      .run("t", "p", "legacy task", 3, 4);
    legacy.close();

    const first = new SqliteWorkStorage(path);
    expect(first.getProject("p")).toEqual({
      id: "p",
      markdown: "saved",
      externalChannel: "channel",
      createdAt: 1,
      updatedAt: 2,
    });
    expect(first.getTask("t")).toEqual({
      id: "t",
      projectId: "p",
      markdown: "legacy task",
      createdAt: 3,
      updatedAt: 4,
    });
    first.close();

    const migrated = new DatabaseSync(path);
    expect(
      (migrated.prepare("SELECT version FROM pinet_work_migrations").get() as { version: number })
        .version,
    ).toBe(1);
    migrated.close();

    const second = new SqliteWorkStorage(path);
    expect(second.getProject("p")?.markdown).toBe("saved");
    expect(second.getTask("t")?.markdown).toBe("legacy task");
    expect(second.deleteProject("p")).toBe(true);
    expect(second.getTask("t")).toBeUndefined();
    second.close();
  });
});
