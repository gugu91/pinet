import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Project, Task, WorkStorage } from "./domain.js";
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
export type WorkAppOptions = {
  storage: WorkStorage;
  tokens: string[];
  now?: () => number;
  id?: () => string;
};
function parse(source: string): JsonObject {
  const value = JSON.parse(source) as JsonValue;
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw new Error("body must be a JSON object");
  return value;
}
function required(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}
function optional(value: JsonValue | undefined, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}
function page(value: string | undefined, fallback: number, max: number) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 0)
    throw new Error("pagination must be a non-negative integer");
  return Math.min(number, max);
}
// agent-standards-ignore prefer-inline-single-use-helper: authentication comparison must remain visibly constant-time.
function equal(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function missing(c: Context, message: string) {
  return c.json({ error: { code: "not_found", message } }, 404);
}
export function createWorkApp(options: WorkAppOptions) {
  const app = new Hono();
  const now = options.now ?? Date.now,
    id = options.id ?? (() => crypto.randomUUID());
  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("authorization");
    if (
      !header?.startsWith("Bearer ") ||
      !options.tokens.some((token) => equal(token, header.slice(7)))
    )
      return c.json(
        { error: { code: "unauthorized", message: "Valid Bearer credential required" } },
        401,
      );
    await next();
  });
  app.onError((cause, c) => {
    const message = cause instanceof Error ? cause.message : "invalid request";
    return c.json(
      { error: { code: message.includes("not found") ? "not_found" : "invalid_request", message } },
      message.includes("not found") ? 404 : 400,
    );
  });
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.post("/v1/projects", async (c) => {
    const body = parse(await c.req.text()),
      timestamp = now();
    const value: Project = {
      id: id(),
      markdown: required(body.markdown, "markdown"),
      externalChannel: optional(body.externalChannel, "externalChannel"),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return c.json({ data: options.storage.putProject(value) }, 201);
  });
  app.get("/v1/projects", (c) =>
    c.json({
      data: options.storage.listProjects(
        page(c.req.query("limit"), 50, 100),
        page(c.req.query("offset"), 0, 100000),
      ),
    }),
  );
  app.get("/v1/projects/:id", (c) => {
    const value = options.storage.getProject(c.req.param("id"));
    return value ? c.json({ data: value }) : missing(c, "Project not found");
  });
  app.put("/v1/projects/:id", async (c) => {
    const current = options.storage.getProject(c.req.param("id"));
    if (!current) return missing(c, "Project not found");
    const body = parse(await c.req.text());
    return c.json({
      data: options.storage.putProject({
        ...current,
        markdown: required(body.markdown, "markdown"),
        externalChannel:
          body.externalChannel === undefined
            ? current.externalChannel
            : optional(body.externalChannel, "externalChannel"),
        updatedAt: now(),
      }),
    });
  });
  app.delete("/v1/projects/:id", (c) =>
    options.storage.deleteProject(c.req.param("id"))
      ? c.body(null, 204)
      : missing(c, "Project not found"),
  );
  app.post("/v1/tasks", async (c) => {
    const body = parse(await c.req.text()),
      timestamp = now();
    const value: Task = {
      id: id(),
      projectId: required(body.projectId, "projectId"),
      markdown: required(body.markdown, "markdown"),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return c.json({ data: options.storage.putTask(value) }, 201);
  });
  app.get("/v1/tasks", (c) =>
    c.json({
      data: options.storage.listTasks(
        c.req.query("projectId"),
        page(c.req.query("limit"), 50, 100),
        page(c.req.query("offset"), 0, 100000),
      ),
    }),
  );
  app.get("/v1/tasks/:id", (c) => {
    const value = options.storage.getTask(c.req.param("id"));
    return value ? c.json({ data: value }) : missing(c, "Task not found");
  });
  app.put("/v1/tasks/:id", async (c) => {
    const current = options.storage.getTask(c.req.param("id"));
    if (!current) return missing(c, "Task not found");
    const body = parse(await c.req.text());
    return c.json({
      data: options.storage.putTask({
        ...current,
        projectId:
          body.projectId === undefined ? current.projectId : required(body.projectId, "projectId"),
        markdown: required(body.markdown, "markdown"),
        updatedAt: now(),
      }),
    });
  });
  app.delete("/v1/tasks/:id", (c) =>
    options.storage.deleteTask(c.req.param("id"))
      ? c.body(null, 204)
      : missing(c, "Task not found"),
  );
  app.get("/v1/search", (c) => {
    const query = c.req.query("q")?.trim();
    if (!query)
      return c.json({ error: { code: "invalid_request", message: "q is required" } }, 400);
    return c.json({
      data: options.storage.search(
        query,
        page(c.req.query("limit"), 25, 100),
        page(c.req.query("offset"), 0, 100000),
      ),
    });
  });
  return app;
}
