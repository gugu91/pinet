import { describe, expect, it, vi } from "vitest";
import { handleMcpMessage, TOOL_DEFINITIONS } from "./mcp-server.js";

const noTool = vi.fn(async () => "unused");

describe("handleMcpMessage", () => {
  it("answers initialize with the client's protocol version", async () => {
    const response = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      },
      noTool,
    );
    expect(response).toMatchObject({
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "pinet" },
      },
    });
  });

  it("ignores notifications", async () => {
    const response = await handleMcpMessage(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      noTool,
    );
    expect(response).toBeNull();
  });

  it("lists all six pinet tools", async () => {
    const response = await handleMcpMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      noTool,
    );
    const tools = (response!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "pinet_follow",
      "pinet_unfollow",
      "pinet_read",
      "pinet_send",
      "pinet_agents",
      "pinet_status",
    ]);
    expect(tools).toBe(TOOL_DEFINITIONS);
  });

  it("dispatches tools/call and wraps the text result", async () => {
    const execute = vi.fn(async (name: string) => `ran ${name}`);
    const response = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "pinet_read", arguments: {} },
      },
      execute,
    );
    expect(execute).toHaveBeenCalledWith("pinet_read", {});
    expect(response).toMatchObject({
      id: 3,
      result: { content: [{ type: "text", text: "ran pinet_read" }] },
    });
  });

  it("converts tool errors into isError results, not protocol errors", async () => {
    const execute = vi.fn(async () => {
      throw new Error("not connected");
    });
    const response = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "pinet_send", arguments: {} },
      },
      execute,
    );
    expect(response).toMatchObject({
      id: 4,
      result: { isError: true, content: [{ type: "text", text: "Error: not connected" }] },
    });
  });

  it("rejects unknown methods with -32601", async () => {
    const response = await handleMcpMessage(
      { jsonrpc: "2.0", id: 5, method: "resources/list" },
      noTool,
    );
    expect(response).toMatchObject({ id: 5, error: { code: -32601 } });
  });
});
