import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import type { ChatStorage, Principal, RuntimeRequest } from "./domain.js";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type Variables = { principal: Principal };
export type Credential = { token: string; principal: Principal };
export type ChatAppOptions = {
  storage: ChatStorage;
  credentials: Credential[];
  now?: () => number;
  id?: () => string;
};

function text(value: JsonValue | undefined, field: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}
// agent-standards-ignore prefer-inline-single-use-helper: named boundary parser keeps mention-array validation explicit.
function list(value: JsonValue | undefined, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item))
    throw new Error(`${field} must be a string array`);
  return value as string[];
}
function bodyObject(source: string): JsonObject {
  const value = JSON.parse(source) as JsonValue;
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw new Error("body must be a JSON object");
  return value;
}
function boundedInt(raw: string | undefined, fallback: number, maximum: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 0)
    throw new Error("pagination value must be a non-negative integer");
  return Math.min(value, maximum);
}
// agent-standards-ignore prefer-inline-single-use-helper: authentication comparison must remain visibly constant-time.
function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function error(c: Context, status: 400 | 401 | 403 | 404 | 409, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

export function createChatApp(options: ChatAppOptions): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();
  const now = options.now ?? Date.now;
  const id = options.id ?? (() => crypto.randomUUID());
  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("authorization");
    if (!header?.startsWith("Bearer "))
      return error(c, 401, "unauthorized", "Bearer credential required");
    const supplied = header.slice(7);
    const credential = options.credentials.find((item) => secureEqual(item.token, supplied));
    if (!credential) return error(c, 401, "unauthorized", "Invalid credential");
    c.set("principal", credential.principal);
    await next();
  });
  app.onError((cause, c) => {
    const message = cause instanceof Error ? cause.message : "invalid request";
    const conflict = message.includes("already") || message.includes("reused");
    const missing = message.includes("not found");
    return error(
      c,
      conflict ? 409 : missing ? 404 : 400,
      conflict ? "conflict" : missing ? "not_found" : "invalid_request",
      message,
    );
  });
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.post("/v1/agents", async (c) => {
    const principal = c.get("principal");
    if (principal.kind !== "agent") return error(c, 403, "forbidden", "Agent credential required");
    const body = bodyObject(await c.req.text());
    const home = text(body.homeChannelId, "homeChannelId", false) ?? null;
    if (home && !options.storage.getChannel(home))
      return error(c, 404, "not_found", "Home channel not found");
    return c.json(
      {
        data: options.storage.putAgent({
          id: principal.id,
          name: text(body.name, "name")!,
          homeChannelId: home,
          lastSeen: now(),
        }),
      },
      201,
    );
  });
  app.get("/v1/agents", (c) => c.json({ data: options.storage.listAgents() }));
  app.put("/v1/agents/me/home", async (c) => {
    const principal = c.get("principal");
    if (principal.kind !== "agent") return error(c, 403, "forbidden", "Agent credential required");
    const current = options.storage.getAgent(principal.id);
    if (!current) return error(c, 404, "not_found", "Agent is not registered");
    const body = bodyObject(await c.req.text());
    const homeChannelId = text(body.channelId, "channelId")!;
    if (!options.storage.getChannel(homeChannelId))
      return error(c, 404, "not_found", "Channel not found");
    return c.json({
      data: options.storage.putAgent({ ...current, homeChannelId, lastSeen: now() }),
    });
  });
  app.post("/v1/channels", async (c) => {
    const body = bodyObject(await c.req.text());
    const channel = options.storage.createChannel({
      id: id(),
      name: text(body.name, "name")!,
      topic: text(body.topic, "topic", false) ?? "",
      createdAt: now(),
    });
    return c.json({ data: channel }, 201);
  });
  app.get("/v1/channels", (c) =>
    c.json({
      data: options.storage.listChannels(
        boundedInt(c.req.query("limit"), 50, 100),
        boundedInt(c.req.query("offset"), 0, 100000),
      ),
    }),
  );
  app.get("/v1/channels/:id", (c) => {
    const channel = options.storage.getChannel(c.req.param("id"));
    return channel
      ? c.json({ data: { ...channel, members: options.storage.members(channel.id) } })
      : error(c, 404, "not_found", "Channel not found");
  });
  app.put("/v1/channels/:id", async (c) => {
    const body = bodyObject(await c.req.text());
    const channel = options.storage.updateChannel(c.req.param("id"), {
      name: text(body.name, "name", false),
      topic: text(body.topic, "topic", false),
    });
    return channel ? c.json({ data: channel }) : error(c, 404, "not_found", "Channel not found");
  });
  app.delete("/v1/channels/:id", (c) =>
    options.storage.deleteChannel(c.req.param("id"))
      ? c.body(null, 204)
      : error(c, 404, "not_found", "Channel not found"),
  );
  app.post("/v1/channels/:id/join", (c) => {
    const principal = c.get("principal");
    if (principal.kind !== "agent") return error(c, 403, "forbidden", "Agent credential required");
    options.storage.join(c.req.param("id"), principal.id);
    return c.json({ data: { joined: true } });
  });
  app.delete("/v1/channels/:id/join", (c) => {
    const principal = c.get("principal");
    if (principal.kind !== "agent") return error(c, 403, "forbidden", "Agent credential required");
    options.storage.leave(c.req.param("id"), principal.id);
    return c.body(null, 204);
  });
  app.post("/v1/channels/:id/messages", async (c) => {
    const principal = c.get("principal");
    if (principal.kind !== "agent") return error(c, 403, "forbidden", "Agent credential required");
    const body = bodyObject(await c.req.text());
    const mentions = list(body.mentions, "mentions");
    if (mentions.some((agentId) => !options.storage.getAgent(agentId)))
      return error(c, 400, "invalid_mention", "Every mention must be a registered agent ID");
    const result = options.storage.insertMessage({
      id: id(),
      clientId: text(body.clientId, "clientId")!,
      channelId: c.req.param("id"),
      senderId: principal.id,
      markdown: text(body.markdown, "markdown")!,
      mentions,
      parentId: text(body.parentId, "parentId", false) ?? null,
      createdAt: now(),
    });
    return c.json(
      { data: result.message, duplicate: result.duplicate },
      result.duplicate ? 200 : 201,
    );
  });
  app.get("/v1/channels/:id/messages", (c) =>
    c.json({
      data: options.storage.messages(
        c.req.param("id"),
        boundedInt(c.req.query("after"), 0, Number.MAX_SAFE_INTEGER),
        boundedInt(c.req.query("limit"), 50, 100),
      ),
    }),
  );
  app.get("/v1/messages/search", (c) => {
    const query = c.req.query("q")?.trim();
    if (!query) return error(c, 400, "invalid_request", "q is required");
    return c.json({
      data: options.storage.searchMessages(
        query,
        boundedInt(c.req.query("limit"), 25, 100),
        boundedInt(c.req.query("after"), 0, Number.MAX_SAFE_INTEGER),
      ),
    });
  });
  app.post("/v1/runtime/requests", async (c) => {
    const principal = c.get("principal");
    if (principal.kind !== "agent") return error(c, 403, "forbidden", "Agent credential required");
    const body = bodyObject(await c.req.text());
    const adapter = text(body.adapter, "adapter", false) ?? "process";
    if (adapter !== "process" && adapter !== "tmux" && adapter !== "herdr")
      return error(c, 400, "invalid_request", "adapter must be process, tmux, or herdr");
    const timestamp = now();
    const request: RuntimeRequest = {
      id: id(),
      requestedBy: principal.id,
      hostId: text(body.hostId, "hostId")!,
      prompt: text(body.prompt, "prompt")!,
      channelId: text(body.channelId, "channelId", false) ?? null,
      worktree: text(body.worktree, "worktree", false) ?? null,
      adapter,
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
      sessionId: null,
      sessionPath: null,
      cwd: null,
      handle: null,
      identity: null,
      startedAt: null,
      lastSeen: null,
      stoppedAt: null,
    };
    options.storage.createRuntimeRequest(request);
    return c.json({ data: request }, 202);
  });
  app.get("/v1/runtime/requests/:id", (c) => {
    const request = options.storage.getRuntimeRequest(c.req.param("id"));
    const principal = c.get("principal");
    if (!request) return error(c, 404, "not_found", "Runtime request not found");
    if (principal.kind === "host" && principal.id !== request.hostId)
      return error(c, 403, "forbidden", "Host cannot access another host request");
    return c.json({ data: request });
  });
  app.get("/v1/runtime/requests", (c) => {
    const principal = c.get("principal");
    if (principal.kind !== "host") return error(c, 403, "forbidden", "Host credential required");
    return c.json({
      data: options.storage.listRuntimeRequests(
        principal.id,
        c.req.query("status") as RuntimeRequest["status"] | undefined,
      ),
    });
  });
  app.post("/v1/runtime/registrations", async (c) => {
    const principal = c.get("principal");
    if (principal.kind !== "host") return error(c, 403, "forbidden", "Host credential required");
    const body = bodyObject(await c.req.text());
    if (body.consent !== true)
      return error(
        c,
        400,
        "consent_required",
        "Manual sessions must explicitly consent to registration and cleanup",
      );
    const adapter = text(body.adapter, "adapter")!;
    if (adapter !== "process" && adapter !== "tmux" && adapter !== "herdr")
      return error(c, 400, "invalid_request", "adapter must be process, tmux, or herdr");
    const timestamp = now();
    const sessionId = text(body.sessionId, "sessionId")!;
    const request: RuntimeRequest = {
      id: id(),
      requestedBy: `manual:${sessionId}`,
      hostId: principal.id,
      prompt: "Manual session registration",
      channelId: null,
      worktree: null,
      adapter,
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp,
      sessionId,
      sessionPath: text(body.sessionPath, "sessionPath", false) ?? null,
      cwd: text(body.cwd, "cwd")!,
      handle: text(body.handle, "handle")!,
      identity: text(body.identity, "identity")!,
      startedAt: timestamp,
      lastSeen: timestamp,
      stoppedAt: null,
    };
    return c.json({ data: options.storage.createRuntimeRequest(request) }, 201);
  });
  app.post("/v1/runtime/requests/:id/claim", (c) =>
    updateHostRequest(c, options, { status: "claimed", updatedAt: now() }),
  );
  app.post("/v1/runtime/requests/:id/report", async (c) => {
    const body = bodyObject(await c.req.text());
    const status = text(body.status, "status") as RuntimeRequest["status"];
    if (!["running", "stopped", "failed", "unknown"].includes(status))
      return error(c, 400, "invalid_request", "Invalid runtime status");
    return updateHostRequest(c, options, {
      status,
      updatedAt: now(),
      sessionId: text(body.sessionId, "sessionId", false) ?? null,
      sessionPath: text(body.sessionPath, "sessionPath", false) ?? null,
      cwd: text(body.cwd, "cwd", false) ?? null,
      handle: text(body.handle, "handle", false) ?? null,
      identity: text(body.identity, "identity", false) ?? null,
      startedAt: typeof body.startedAt === "number" ? body.startedAt : null,
      lastSeen: now(),
      stoppedAt: status === "stopped" || status === "failed" ? now() : null,
    });
  });
  return app;
}

function updateHostRequest(
  c: Context<{ Variables: Variables }>,
  options: ChatAppOptions,
  patch: Partial<RuntimeRequest>,
) {
  const principal = c.get("principal");
  const requestId = c.req.param("id");
  if (!requestId) return error(c, 400, "invalid_request", "Runtime request ID required");
  const request = options.storage.getRuntimeRequest(requestId);
  if (principal.kind !== "host") return error(c, 403, "forbidden", "Host credential required");
  if (!request) return error(c, 404, "not_found", "Runtime request not found");
  if (request.hostId !== principal.id)
    return error(c, 403, "forbidden", "Host cannot update another host request");
  return c.json({ data: options.storage.updateRuntimeRequest(request.id, patch) });
}
