import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerSlack } from "./index.js";
import { MemoryMappingStore } from "./mapping.js";

type Tool = {
  execute: (
    id: string,
    params: { action: string; slackChannelId?: string; chatChannelId?: string },
  ) => Promise<{ isError?: boolean }>;
};

function register(options: Parameters<typeof registerSlack>[1] = {}) {
  let tool: Tool | undefined;
  const handlers = new Map<string, () => Promise<void> | void>();
  registerSlack(
    {
      on(name: string, handler: () => Promise<void> | void) {
        handlers.set(name, handler);
      },
      registerTool(value: Tool) {
        tool = value;
      },
      registerCommand() {},
    } as object as ExtensionAPI,
    options,
  );
  if (!tool) throw new Error("Slack tool was not registered");
  return { tool, handlers };
}

describe("Slack extension activation", () => {
  it("does not acquire a mapping lease when default-off or unconfigured", async () => {
    const mappingStoreFactory = vi.fn(() => new MemoryMappingStore());
    const first = register({ mappingStoreFactory });
    const second = register({ mappingStoreFactory });

    await first.handlers.get("session_start")?.();
    await second.handlers.get("session_start")?.();
    await first.tool.execute("status", { action: "status" });
    await second.tool.execute("status", { action: "status" });
    expect(mappingStoreFactory).not.toHaveBeenCalled();
  });

  it("opens the mapping store lazily only after explicit activation and a stateful action", async () => {
    const mappingStoreFactory = vi.fn(() => new MemoryMappingStore());
    const { tool } = register({ enabled: true, mappingStoreFactory });
    await tool.execute("status", { action: "status" });
    expect(mappingStoreFactory).not.toHaveBeenCalled();

    await tool.execute("bind", {
      action: "bind_channel",
      slackChannelId: "C",
      chatChannelId: "chat",
    });
    expect(mappingStoreFactory).toHaveBeenCalledTimes(1);
  });
});
