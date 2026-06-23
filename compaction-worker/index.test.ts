import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CompactOptions,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@mariozechner/pi-coding-agent";
import compactionWorkerExtension from "./index.js";

type RegisteredHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function createMockPi(): { pi: ExtensionAPI; handlers: Record<string, RegisteredHandler> } {
  const handlers: Record<string, RegisteredHandler> = {};
  const pi = {
    on(event: string, handler: RegisteredHandler): void {
      handlers[event] = handler;
    },
    registerCommand(): void {},
    registerTool(): void {},
    registerMessageRenderer(): void {},
    sendUserMessage(): void {},
    sendMessage(): void {},
    appendEntry(): void {},
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

function writeConfig(cwd: string): void {
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      "compaction-worker": {
        enabled: true,
        triggerAtTokens: 200,
        summaryModels: ["test/missing-summary-model"],
        cooldownMs: 1,
      },
    }),
  );
}

function createPreparation(): SessionBeforeCompactEvent["preparation"] {
  return {
    firstKeptEntryId: "entry-1",
    messagesToSummarize: [],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 150,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
  };
}

function createContext(cwd: string, compactCalls: CompactOptions[]): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    ui: {
      theme: {},
      notify(): void {},
      setStatus(): void {},
    },
    model: { provider: "test", id: "model", contextWindow: 1_000 },
    modelRegistry: {
      find(): unknown | undefined {
        return undefined;
      },
      async getApiKeyAndHeaders(): Promise<{ ok: boolean; error: string }> {
        return { ok: false, error: "unavailable" };
      },
    },
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      getLeafId: () => "entry-1",
      getSessionId: () => "session-1",
      getSessionFile: () => join(cwd, "session.jsonl"),
    },
    getContextUsage: () => ({ tokens: 250, contextWindow: 1_000 }),
    compact(options?: CompactOptions): void {
      compactCalls.push(options ?? {});
    },
  } as unknown as ExtensionContext;
}

describe("compaction-worker extension runtime lifecycle", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clears failed session_before_compact in-flight state before the next agent_end decision", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "compaction-worker-test-"));
    tempDirs.push(cwd);
    mkdirSync(join(cwd, ".pi"));
    writeConfig(cwd);

    const { pi, handlers } = createMockPi();
    const compactCalls: CompactOptions[] = [];
    const ctx = createContext(cwd, compactCalls);
    compactionWorkerExtension(pi);

    const beforeCompact = handlers.session_before_compact;
    const agentEnd = handlers.agent_end;
    expect(beforeCompact).toBeDefined();
    expect(agentEnd).toBeDefined();

    const event: SessionBeforeCompactEvent = {
      type: "session_before_compact",
      preparation: createPreparation(),
      branchEntries: [],
      signal: new AbortController().signal,
    };

    await beforeCompact(event, ctx);
    await agentEnd({}, ctx);

    expect(compactCalls).toHaveLength(1);
  });
});
