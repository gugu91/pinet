import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerWork } from "./index.js";

type ToolParams = {
  action: string;
  id?: string;
  projectId?: string;
  markdown?: string;
  externalChannel?: string | null;
  query?: string;
  limit?: number;
  offset?: number;
};
type ToolResult = { isError?: boolean; details: object };
type RegisteredTool = {
  execute: (callId: string, params: ToolParams) => Promise<ToolResult>;
};

function setup() {
  let tool: RegisteredTool | undefined;
  const requests: Array<{ input: URL | RequestInfo; init?: RequestInit }> = [];
  const transport: typeof fetch = vi.fn(async (input, init) => {
    requests.push({ input, init });
    return Response.json({ data: [] });
  });
  const pi = {
    registerTool(value: RegisteredTool) {
      tool = value;
    },
    registerCommand() {},
  } as object as ExtensionAPI;
  registerWork(pi, { baseUrl: "http://work.test", token: "secret", fetch: transport });
  if (!tool) throw new Error("tool was not registered");
  return { tool, requests };
}

describe("pinet_work dispatcher", () => {
  it("forwards bounded pagination for projects, tasks, and search", async () => {
    const { tool, requests } = setup();
    await tool.execute("1", { action: "projects", limit: 10, offset: 20 });
    await tool.execute("2", {
      action: "tasks",
      projectId: "project one",
      limit: 30,
      offset: 40,
    });
    await tool.execute("3", { action: "search", query: "needle", limit: 50, offset: 60 });

    expect(requests.map(({ input }) => String(input))).toEqual([
      "http://work.test/v1/projects?limit=10&offset=20",
      "http://work.test/v1/tasks?limit=30&offset=40&projectId=project+one",
      "http://work.test/v1/search?limit=50&offset=60&q=needle",
    ]);

    const invalid = await tool.execute("4", { action: "projects", limit: 101 });
    expect(invalid.isError).toBe(true);
    expect(requests).toHaveLength(3);
  });

  it("forwards explicit null when clearing a project's external channel", async () => {
    const { tool, requests } = setup();
    await tool.execute("1", {
      action: "project_update",
      id: "project",
      markdown: "body",
      externalChannel: null,
    });

    expect(requests[0]?.init?.body).toBe(
      JSON.stringify({ markdown: "body", externalChannel: null }),
    );
  });
});
