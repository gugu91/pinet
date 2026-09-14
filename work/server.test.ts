import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkApp, parseTokens } from "./server.js";
import { MemoryWorkStorage, SqliteWorkStorage } from "./storage.js";
const auth = { authorization: "Bearer secret", "content-type": "application/json" };
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
describe("independent work API", () => {
  it("supports authenticated project/task CRUD, full replacement updates, search, and malformed input", async () => {
    let id = 0,
      now = 0;
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
  it("rejects empty and duplicate token configuration", () => {
    expect(() => parseTokens("[]")).toThrow("non-empty");
    expect(() => parseTokens('["","valid"]')).toThrow("non-empty strings");
    expect(() => parseTokens('["same","same"]')).toThrow("unique");
  });
  it("persists without chat across SQLite restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "pinet-work-"));
    dirs.push(directory);
    const path = join(directory, "work.sqlite");
    const first = new SqliteWorkStorage(path);
    first.putProject({
      id: "p",
      markdown: "saved",
      externalChannel: null,
      createdAt: 1,
      updatedAt: 1,
    });
    first.close();
    const second = new SqliteWorkStorage(path);
    expect(second.getProject("p")?.markdown).toBe("saved");
    second.close();
  });
});
