import { splitJsonRpcLines } from "./broker-client.js";
import type { WorkerConfig } from "./config.js";
import { FollowerBridge, formatPendingMessages } from "./follower-bridge.js";

/**
 * Minimal MCP stdio server exposing the follower bridge to an interactive
 * Claude Code session. Newline-delimited JSON-RPC 2.0 — the same framing as
 * the broker protocol — so no SDK dependency is needed for six tools.
 */

const SERVER_INFO = { name: "pinet", version: "0.1.0" };
const FALLBACK_PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "pinet_follow",
    description:
      "Join the local Pinet mesh as a follower agent (idempotent). Returns the assigned " +
      "identity and the exact background waiter command that wakes this session when mesh " +
      "messages arrive.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Explicit agent name (default: broker assigns)" },
        emoji: { type: "string", description: "Agent emoji (only with name)" },
      },
    },
  },
  {
    name: "pinet_unfollow",
    description: "Leave the Pinet mesh and stop the waiter socket (idempotent).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pinet_read",
    description:
      "Drain pending mesh messages (acks them on the broker). Call after the waiter exits.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pinet_send",
    description:
      "Send a reply to a mesh thread. Agent-to-agent threads route back to the sending " +
      "agent; regular threads are claimed automatically on first send.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "threadId from pinet_read" },
        body: { type: "string", description: "Reply text (Slack-friendly)" },
      },
      required: ["threadId", "body"],
    },
  },
  {
    name: "pinet_agents",
    description: "List agents currently registered on the mesh.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pinet_status",
    description:
      "Manually override this agent's mesh status. Rarely needed — the bridge tracks " +
      "working/idle from waiter arming and reads.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["working", "idle"] },
      },
      required: ["status"],
    },
  },
];

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required string argument "${key}"`);
  }
  return value;
}

/** Execute one pinet tool against the bridge; returns the text for the model. */
export async function callPinetTool(
  bridge: FollowerBridge,
  cliPath: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "pinet_follow": {
      const result = await bridge.follow({
        name: typeof args.name === "string" ? args.name : undefined,
        emoji: typeof args.emoji === "string" ? args.emoji : undefined,
      });
      const waitCommand = `node ${cliPath} wait --socket ${result.waiterSocketPath}`;
      return [
        `Following the Pinet mesh as "${result.name}" ${result.emoji} (agentId ${result.agentId}).`,
        ``,
        `To receive mesh messages while idle, run this in the background (Bash run_in_background)`,
        `and re-arm it after every wake:`,
        ``,
        `  ${waitCommand}`,
        ``,
        `When it exits reporting pending messages: call pinet_read, handle each message,`,
        `reply with pinet_send, then re-arm the waiter. If it exits with EXIT, do not re-arm.`,
      ].join("\n");
    }
    case "pinet_unfollow": {
      await bridge.unfollow("pinet_unfollow tool call");
      return "Unfollowed the Pinet mesh.";
    }
    case "pinet_read": {
      const messages = await bridge.read();
      const exitNote = bridge.wasExitRequested()
        ? "\n\nNote: an exit control command was received — the bridge has unfollowed; do not re-arm the waiter."
        : "";
      return formatPendingMessages(messages) + exitNote;
    }
    case "pinet_send": {
      const threadId = requireString(args, "threadId");
      const body = requireString(args, "body");
      return bridge.send(threadId, body);
    }
    case "pinet_agents": {
      const agents = await bridge.listAgents();
      return JSON.stringify(agents, null, 2);
    }
    case "pinet_status": {
      const status = requireString(args, "status");
      if (status !== "working" && status !== "idle") {
        throw new Error(`Invalid status "${status}" (expected "working" or "idle")`);
      }
      await bridge.setStatus(status);
      return `Status set to ${status}.`;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Handle one MCP JSON-RPC message. Returns the response object to write, or
 * null for notifications. Tool execution is delegated so this stays testable.
 */
export async function handleMcpMessage(
  request: JsonRpcRequest,
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>,
): Promise<Record<string, unknown> | null> {
  const { id, method, params } = request;
  const respond = (result: unknown) => ({ jsonrpc: "2.0", id: id!, result });
  const fail = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id: id!,
    error: { code, message },
  });

  // Notifications (no id) get no response.
  if (id === undefined) return null;

  switch (method) {
    case "initialize": {
      const requested = (params as { protocolVersion?: string } | undefined)?.protocolVersion;
      return respond({
        protocolVersion: requested ?? FALLBACK_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case "ping":
      return respond({});
    case "tools/list":
      return respond({ tools: TOOL_DEFINITIONS });
    case "tools/call": {
      const name = (params as { name?: string } | undefined)?.name;
      const args = ((params as { arguments?: Record<string, unknown> } | undefined)?.arguments ??
        {}) as Record<string, unknown>;
      if (!name) return fail(-32602, "tools/call requires a tool name");
      try {
        const text = await executeTool(name, args);
        return respond({ content: [{ type: "text", text }] });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return respond({ content: [{ type: "text", text: `Error: ${message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

export async function runMcpServer(config: WorkerConfig): Promise<void> {
  const bridge = new FollowerBridge(config);
  const cliPath = process.argv[1] ?? "pinet-claude-worker";
  let buffer = "";
  let processingChain: Promise<void> = Promise.resolve();

  const write = (message: Record<string, unknown>) => {
    process.stdout.write(JSON.stringify(message) + "\n");
  };

  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    const { lines, rest } = splitJsonRpcLines(buffer + chunk);
    buffer = rest;
    for (const line of lines) {
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch {
        continue;
      }
      // Serialize handling so tool calls cannot interleave.
      processingChain = processingChain.then(async () => {
        const response = await handleMcpMessage(request, (name, args) =>
          callPinetTool(bridge, cliPath, name, args),
        );
        if (response) write(response);
      });
    }
  });

  // The session died with us: leave the mesh so no ghost agent lingers.
  const shutdown = () => {
    void bridge.unfollow("mcp stdin closed (session ended)").finally(() => process.exit(0));
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the process alive on stdin.
  process.stdin.resume();
  return new Promise<void>(() => {});
}
