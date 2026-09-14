import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Project, Task, WorkStorage } from "./domain.js";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_MARKDOWN_LENGTH = 32 * 1024;
const MAX_EXTERNAL_CHANNEL_LENGTH = 256;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_SEARCH_LENGTH = 256;

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };
type ProjectRequest = { markdown: string; externalChannel: string | null | undefined };
type TaskRequest = { projectId: string | undefined; markdown: string };

class RequestError extends Error {}

export function parseTokens(source: string): string[] {
  let value: JsonValue;
  try {
    value = JSON.parse(source) as JsonValue;
  } catch {
    throw new Error("tokens must be valid JSON");
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("tokens must be a non-empty string array");
  }
  if (value.some((token) => typeof token !== "string" || !token.trim())) {
    throw new Error("tokens must contain non-empty strings");
  }
  const tokens = value as string[];
  if (new Set(tokens).size !== tokens.length) throw new Error("tokens must be unique");
  return tokens;
}

export function hasValidBearerToken(header: string | null | undefined, tokens: string[]): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = header.slice(7);
  return tokens.some((token) => {
    const expectedBytes = Buffer.from(token);
    const suppliedBytes = Buffer.from(supplied);
    return (
      expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
    );
  });
}

export type WorkAppOptions = {
  storage: WorkStorage;
  tokens?: string[];
  trustAuthenticatedProxy?: true;
  now?: () => number;
  id?: () => string;
};

async function readJsonObject(c: Context): Promise<JsonObject> {
  const contentType = c.req.header("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json")
    throw new RequestError("content-type must be application/json");

  const contentLength = c.req.header("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    throw new RequestError(`body must not exceed ${MAX_BODY_BYTES} bytes`);
  }

  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new RequestError("body must be a JSON object");
  const decoder = new TextDecoder();
  let byteLength = 0;
  let source = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    byteLength += chunk.value.byteLength;
    if (byteLength > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new RequestError(`body must not exceed ${MAX_BODY_BYTES} bytes`);
    }
    source += decoder.decode(chunk.value, { stream: true });
  }
  source += decoder.decode();

  let value: JsonValue;
  try {
    value = JSON.parse(source) as JsonValue;
  } catch {
    throw new RequestError("body must contain valid JSON");
  }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new RequestError("body must be a JSON object");
  }
  return value;
}

function requiredString(value: JsonValue | undefined, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RequestError(`${name} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new RequestError(`${name} must not exceed ${maxLength} characters`);
  }
  return normalized;
}

function requiredMarkdown(value: JsonValue | undefined): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RequestError("markdown must be a non-empty string");
  }
  if (value.length > MAX_MARKDOWN_LENGTH) {
    throw new RequestError(`markdown must not exceed ${MAX_MARKDOWN_LENGTH} characters`);
  }
  return value;
}

function parseProjectRequest(body: JsonObject): ProjectRequest {
  const externalChannel = body.externalChannel;
  if (externalChannel !== undefined && externalChannel !== null) {
    if (typeof externalChannel !== "string") {
      throw new RequestError("externalChannel must be a string");
    }
    if (externalChannel.length > MAX_EXTERNAL_CHANNEL_LENGTH) {
      throw new RequestError(
        `externalChannel must not exceed ${MAX_EXTERNAL_CHANNEL_LENGTH} characters`,
      );
    }
  }
  return {
    markdown: requiredMarkdown(body.markdown),
    externalChannel,
  };
}

function parseTaskRequest(body: JsonObject): TaskRequest {
  return {
    projectId:
      body.projectId === undefined
        ? undefined
        : requiredString(body.projectId, "projectId", MAX_IDENTIFIER_LENGTH),
    markdown: requiredMarkdown(body.markdown),
  };
}

function page(value: string | undefined, fallback: number, max: number): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new RequestError("pagination must be a non-negative integer");
  }
  return Math.min(number, max);
}

function missing(c: Context, message: string): Response {
  return c.json({ error: { code: "not_found", message } }, 404);
}

export function createWorkApp(options: WorkAppOptions) {
  if (options.trustAuthenticatedProxy) {
    if (options.tokens !== undefined) {
      throw new Error("trusted proxy mode does not accept tokens");
    }
  } else if (
    !options.tokens ||
    options.tokens.length === 0 ||
    options.tokens.some((token) => !token.trim()) ||
    new Set(options.tokens).size !== options.tokens.length
  ) {
    throw new Error("tokens must contain unique non-empty strings");
  }

  const app = new Hono();
  const now = options.now ?? Date.now;
  const id = options.id ?? (() => crypto.randomUUID());

  if (!options.trustAuthenticatedProxy) {
    const tokens = options.tokens!;
    app.use("/v1/*", async (c, next) => {
      if (!hasValidBearerToken(c.req.header("authorization"), tokens)) {
        return c.json(
          { error: { code: "unauthorized", message: "Valid Bearer credential required" } },
          401,
        );
      }
      await next();
    });
  }

  app.onError((cause, c) => {
    if (cause instanceof RequestError) {
      return c.json({ error: { code: "invalid_request", message: cause.message } }, 400);
    }
    // Signal failures without logging SQL, credentials or user-provided content.
    console.error("Work request failed", { code: "internal_error", method: c.req.method });
    return c.json(
      { error: { code: "internal_error", message: "The request could not be completed" } },
      500,
    );
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.post("/v1/projects", async (c) => {
    const body = parseProjectRequest(await readJsonObject(c));
    const timestamp = now();
    const value: Project = {
      id: id(),
      markdown: body.markdown,
      externalChannel: body.externalChannel ?? null,
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
    const value = options.storage.getProject(
      requiredString(c.req.param("id"), "id", MAX_IDENTIFIER_LENGTH),
    );
    return value ? c.json({ data: value }) : missing(c, "Project not found");
  });

  app.put("/v1/projects/:id", async (c) => {
    const projectId = requiredString(c.req.param("id"), "id", MAX_IDENTIFIER_LENGTH);
    const current = options.storage.getProject(projectId);
    if (!current) return missing(c, "Project not found");
    const body = parseProjectRequest(await readJsonObject(c));
    return c.json({
      data: options.storage.putProject({
        ...current,
        markdown: body.markdown,
        externalChannel:
          body.externalChannel === undefined ? current.externalChannel : body.externalChannel,
        updatedAt: now(),
      }),
    });
  });

  app.delete("/v1/projects/:id", (c) =>
    options.storage.deleteProject(requiredString(c.req.param("id"), "id", MAX_IDENTIFIER_LENGTH))
      ? c.body(null, 204)
      : missing(c, "Project not found"),
  );

  app.post("/v1/tasks", async (c) => {
    const body = parseTaskRequest(await readJsonObject(c));
    const projectId = requiredString(body.projectId, "projectId", MAX_IDENTIFIER_LENGTH);
    if (!options.storage.getProject(projectId)) return missing(c, "Project not found");
    const timestamp = now();
    const value: Task = {
      id: id(),
      projectId,
      markdown: body.markdown,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return c.json({ data: options.storage.putTask(value) }, 201);
  });

  app.get("/v1/tasks", (c) => {
    const projectId = c.req.query("projectId");
    return c.json({
      data: options.storage.listTasks(
        projectId === undefined
          ? undefined
          : requiredString(projectId, "projectId", MAX_IDENTIFIER_LENGTH),
        page(c.req.query("limit"), 50, 100),
        page(c.req.query("offset"), 0, 100000),
      ),
    });
  });

  app.get("/v1/tasks/:id", (c) => {
    const value = options.storage.getTask(
      requiredString(c.req.param("id"), "id", MAX_IDENTIFIER_LENGTH),
    );
    return value ? c.json({ data: value }) : missing(c, "Task not found");
  });

  app.put("/v1/tasks/:id", async (c) => {
    const taskId = requiredString(c.req.param("id"), "id", MAX_IDENTIFIER_LENGTH);
    const current = options.storage.getTask(taskId);
    if (!current) return missing(c, "Task not found");
    const body = parseTaskRequest(await readJsonObject(c));
    const projectId = body.projectId ?? current.projectId;
    if (!options.storage.getProject(projectId)) return missing(c, "Project not found");
    return c.json({
      data: options.storage.putTask({
        ...current,
        projectId,
        markdown: body.markdown,
        updatedAt: now(),
      }),
    });
  });

  app.delete("/v1/tasks/:id", (c) =>
    options.storage.deleteTask(requiredString(c.req.param("id"), "id", MAX_IDENTIFIER_LENGTH))
      ? c.body(null, 204)
      : missing(c, "Task not found"),
  );

  app.get("/v1/search", (c) => {
    const query = requiredString(c.req.query("q"), "q", MAX_SEARCH_LENGTH);
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
