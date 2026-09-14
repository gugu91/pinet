import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSlack } from "./index.js";
import { MemoryMappingStore } from "./mapping.js";
import { SlackSocketModeClient } from "./socket.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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
  it.each([false, true])(
    "does not install stale polling after shutdown (restart=%s)",
    async (restart) => {
      vi.useFakeTimers();
      let finishStart!: () => void;
      const pending = new Promise<void>((resolve) => {
        finishStart = resolve;
      });
      const start = vi
        .spyOn(SlackSocketModeClient.prototype, "start")
        .mockReturnValueOnce(pending)
        .mockResolvedValue(undefined);
      const oldStore = new MemoryMappingStore();
      const newStore = new MemoryMappingStore();
      const oldList = vi.spyOn(oldStore, "listChannels");
      const newList = vi.spyOn(newStore, "listChannels");
      const close = vi.spyOn(oldStore, "close");
      const mappingStoreFactory = vi.fn().mockReturnValueOnce(oldStore).mockReturnValue(newStore);
      const { handlers } = register({
        enabled: true,
        chatUrl: "https://chat.test",
        chatToken: "chat",
        slackBotToken: "bot",
        slackAppToken: "app",
        slackUserId: "U",
        mappingStoreFactory,
      });
      const starting = handlers.get("session_start")!();
      await handlers.get("session_shutdown")!();
      expect(close).toHaveBeenCalledTimes(1);
      if (restart) {
        await handlers.get("session_start")!();
        await handlers.get("session_start")!();
      }
      finishStart();
      await starting;
      expect(start).toHaveBeenCalledTimes(restart ? 2 : 1);
      expect(vi.getTimerCount()).toBe(restart ? 1 : 0);
      await vi.advanceTimersByTimeAsync(4000);
      expect(oldList).not.toHaveBeenCalled();
      expect(newList).toHaveBeenCalledTimes(restart ? 2 : 0);
      await handlers.get("session_shutdown")!();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
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
