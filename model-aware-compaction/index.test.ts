import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const { sdkCompact } = vi.hoisted(() => ({ sdkCompact: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  compact: sdkCompact,
}));

import extension from "./index.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

beforeEach(() => {
  sdkCompact.mockReset();
});

function harness() {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on: (event: string, handler: Handler) => {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    registerCommand: vi.fn(),
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  extension(api);
  const emit = (event: string, ctx: ExtensionContext) => {
    for (const handler of handlers.get(event) ?? []) handler({}, ctx);
  };
  const emitAsync = (event: string, payload: object, ctx: ExtensionContext) =>
    Promise.all((handlers.get(event) ?? []).map((handler) => handler(payload, ctx)));
  return { handlers, emit, emitAsync, api };
}

function context(tokens: number, compact = vi.fn()): ExtensionContext {
  return {
    cwd: process.cwd(),
    hasUI: false,
    ui: { notify: vi.fn(), setStatus: vi.fn() } as unknown as ExtensionContext["ui"],
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      getLeafId: () => undefined,
      getSessionFile: () => undefined,
    },
    model: { provider: "openai", id: "gpt-5-mini" },
    getContextUsage: () => ({ tokens, contextWindow: 400_000, percent: tokens / 4_000 }),
    compact,
  };
}

describe("extension wiring", () => {
  it("does nothing while disabled", () => {
    const { emit } = harness();
    const compact = vi.fn();
    // Explicit project settings keep the test hermetic — without them the
    // extension falls back to ~/.pi/agent/settings.json, coupling the result
    // to whatever the developer's machine has configured globally.
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({ "model-aware-compaction": { enabled: false } }),
    );
    try {
      emit("agent_settled", { ...context(120_000, compact), cwd: temp });
      expect(compact).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("waits for the full operation to settle before compacting", () => {
    const { emit } = harness();
    const compact = vi.fn();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({ "model-aware-compaction": { enabled: true } }),
    );
    try {
      const ctx = { ...context(120_000, compact), cwd: temp };

      // Pi can still auto-compact and retry after agent_end.
      emit("turn_end", ctx);
      emit("agent_end", ctx);
      expect(compact).not.toHaveBeenCalled();

      emit("agent_settled", ctx);
      expect(compact).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("triggers once above the configured threshold and re-arms after completion plus lower usage", () => {
    const { emit } = harness();
    const compact = vi.fn();
    // Project settings take precedence; the test creates only the minimal extension config.
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({
        "model-aware-compaction": { enabled: true },
      }),
    );
    try {
      const ctx = { ...context(120_000, compact), cwd: temp };
      emit("agent_settled", ctx);
      emit("agent_settled", ctx);
      expect(compact).toHaveBeenCalledTimes(1);

      const options = compact.mock.calls[0]?.[0] as { onComplete?: () => void };
      options.onComplete?.();
      emit("agent_settled", ctx);
      expect(compact).toHaveBeenCalledTimes(1);

      emit("agent_settled", {
        ...ctx,
        getContextUsage: () => ({ tokens: 90_000, contextWindow: 400_000, percent: 22.5 }),
      });
      emit("agent_settled", ctx);
      expect(compact).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("skips a settled branch whose latest entry is already a compaction", () => {
    const { emit } = harness();
    const compact = vi.fn();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({ "model-aware-compaction": { enabled: true } }),
    );
    try {
      const base = context(120_000, compact);
      const ctx = {
        ...base,
        cwd: temp,
        sessionManager: {
          ...base.sessionManager,
          getBranch: () => [{ type: "compaction" }],
        },
      };
      emit("agent_settled", ctx);
      emit("agent_settled", ctx);
      expect(compact).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("treats an already-compacted callback as an idempotent outcome", () => {
    const { emit } = harness();
    const compact = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({ "model-aware-compaction": { enabled: true, debug: true } }),
    );
    try {
      const ctx = { ...context(120_000, compact), cwd: temp, hasUI: true };
      emit("agent_settled", ctx);
      const options = compact.mock.calls[0]?.[0] as { onError?: (error: Error) => void };
      options.onError?.(new Error("Already compacted"));
      emit("agent_settled", ctx);

      expect(compact).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalledWith(expect.stringContaining("failed"));
      expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("failed"), "error");
    } finally {
      error.mockRestore();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("does not clear the in-flight guard when a model selection event re-arms the threshold", () => {
    const { emit } = harness();
    const compact = vi.fn();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({ "model-aware-compaction": { enabled: true } }),
    );
    try {
      const ctx = { ...context(120_000, compact), cwd: temp };
      emit("agent_settled", ctx);
      emit("model_select", ctx);
      emit("agent_settled", ctx);
      expect(compact).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("leaves Pi compaction unchanged when no selector is configured", async () => {
    const { emitAsync } = harness();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({ "model-aware-compaction": { enabled: false } }),
    );
    try {
      const [result] = await emitAsync(
        "session_before_compact",
        { signal: new AbortController().signal },
        { ...context(20_000), cwd: temp },
      );
      expect(result).toBeUndefined();
      expect(sdkCompact).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it.each(["manual", "threshold", "overflow"])(
    "uses the selected model for %s compaction without changing the session model",
    async (reason) => {
      const { emitAsync } = harness();
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
      fs.mkdirSync(path.join(temp, ".pi"));
      fs.writeFileSync(
        path.join(temp, ".pi", "settings.json"),
        JSON.stringify({
          "model-aware-compaction": {
            compactionModel: "anthropic/summary-model:high",
            customInstructions: "Keep validation evidence.",
          },
        }),
      );
      const sessionModel = { provider: "openai", id: "gpt-5-mini" };
      const selectedModel = {
        provider: "anthropic",
        id: "summary-model",
        reasoning: true,
        contextWindow: 200_000,
        maxTokens: 8_192,
      };
      const ctx = {
        ...context(20_000),
        cwd: temp,
        model: sessionModel,
        modelRegistry: {
          find: vi.fn(() => selectedModel),
          getAvailable: () => [selectedModel],
          getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "secret" })),
        },
      } as ExtensionContext;
      const preparation = {
        firstKeptEntryId: "kept",
        messagesToSummarize: [{ role: "user", content: "history" }],
        turnPrefixMessages: [{ role: "user", content: "prefix" }],
        isSplitTurn: true,
        tokensBefore: 20_000,
        previousSummary: "prior summary",
        fileOps: { read: new Set(["read.ts"]), edited: new Set(["edit.ts"]) },
        settings: { enabled: true, reserveTokens: 4_096, keepRecentTokens: 1_000 },
      };
      const result = {
        summary: "summary",
        firstKeptEntryId: "kept",
        tokensBefore: 20_000,
        usage: { input: 10, output: 5 },
        details: { readFiles: ["read.ts"], modifiedFiles: ["edit.ts"] },
      };
      sdkCompact.mockResolvedValue(result);
      try {
        const [hookResult] = await emitAsync(
          "session_before_compact",
          {
            type: "session_before_compact",
            preparation,
            customInstructions: "Manual focus.",
            reason,
            signal: new AbortController().signal,
          },
          ctx,
        );
        expect(sdkCompact).toHaveBeenCalledWith(
          preparation,
          selectedModel,
          "secret",
          undefined,
          "Manual focus.\n\nKeep validation evidence.",
          expect.any(AbortSignal),
          "high",
          undefined,
          undefined,
        );
        expect(hookResult).toEqual({ compaction: result });
        expect(ctx.model).toBe(sessionModel);
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it("fails closed for oversized input and honors cancellation without provider work", async () => {
    const { emitAsync } = harness();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({ "model-aware-compaction": { compactionModel: "test/tiny" } }),
    );
    const model = {
      provider: "test",
      id: "tiny",
      reasoning: false,
      contextWindow: 2_500,
      maxTokens: 1_000,
    };
    const ctx = {
      ...context(20_000),
      cwd: temp,
      modelRegistry: {
        find: () => model,
        getAvailable: () => [model],
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret" }),
      },
    } as ExtensionContext;
    const preparation = {
      firstKeptEntryId: "kept",
      messagesToSummarize: [{ role: "user", content: "x".repeat(4_000) }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 20_000,
      fileOps: { read: new Set<string>(), edited: new Set<string>() },
      settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 },
    };
    try {
      const [oversized] = await emitAsync(
        "session_before_compact",
        { preparation, signal: new AbortController().signal },
        ctx,
      );
      const controller = new AbortController();
      controller.abort();
      const [cancelled] = await emitAsync(
        "session_before_compact",
        { preparation: { ...preparation, messagesToSummarize: [] }, signal: controller.signal },
        ctx,
      );
      expect(oversized).toEqual({ cancel: true });
      expect(cancelled).toEqual({ cancel: true });
      expect(sdkCompact).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
