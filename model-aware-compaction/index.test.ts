import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type PickerModel = { provider: string; id: string };
type PickerArgs = [
  tui: { requestRender(): void },
  current: PickerModel | undefined,
  runtime: { getAvailableSnapshot(): readonly PickerModel[] },
  scopedModels: ReadonlyArray<{ model: PickerModel }>,
  onSelect: (model: PickerModel) => void,
  onCancel: () => void,
];
const { selectedCompact, modelSelector } = vi.hoisted(() => ({
  selectedCompact: vi.fn(),
  modelSelector: vi.fn<(...args: PickerArgs) => void>(),
}));
vi.mock("./selected-compaction.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runSelectedModelCompaction: selectedCompact,
}));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // Pi's real picker needs a live TUI; record the constructor contract instead.
  ModelSelectorComponent: class {
    constructor(...args: PickerArgs) {
      modelSelector(...args);
    }
  },
}));

import extension from "./index.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

beforeEach(() => {
  selectedCompact.mockReset();
  modelSelector.mockReset();
});

function harness() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void }
  >();
  const api = {
    on: (event: string, handler: Handler) => {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    registerCommand: vi.fn(
      (
        name: string,
        options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void },
      ) => commands.set(name, options),
    ),
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  extension(api);
  const emit = (event: string, ctx: ExtensionContext) => {
    for (const handler of handlers.get(event) ?? []) handler({}, ctx);
  };
  const emitAsync = (event: string, payload: object, ctx: ExtensionContext) =>
    Promise.all((handlers.get(event) ?? []).map((handler) => handler(payload, ctx)));
  return { handlers, commands, emit, emitAsync, api };
}

function context(tokens: number, compact = vi.fn()): ExtensionContext {
  return {
    cwd: process.cwd(),
    hasUI: false,
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      select: vi.fn(),
    } as unknown as ExtensionContext["ui"],
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

  it("applies an exact model id passed straight to the command and rejects a bare id outside the shortlist", async () => {
    const { commands } = harness();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({ "model-aware-compaction": { enabled: true } }),
    );
    const modelShape = {
      api: "openai-completions",
      baseUrl: "https://example.test",
      reasoning: true,
      contextWindow: 20_000,
      maxTokens: 2_000,
    };
    const scoped = { ...modelShape, provider: "anthropic", id: "claude-haiku-4-5" };
    const offScope = { ...modelShape, provider: "openai", id: "gpt-5-mini" };
    const ctx = {
      ...context(1_000),
      cwd: temp,
      hasUI: true,
      scopedModels: [{ model: scoped }],
      modelRegistry: {
        find: () => undefined,
        getAvailable: () => [scoped, offScope],
        getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "secret" }),
        complete: vi.fn(),
      },
    } as ExtensionContext;
    try {
      const command = commands.get("model-aware-compaction-model");
      await command?.handler("anthropic/claude-haiku-4-5", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Compaction model: anthropic/claude-haiku-4-5 (session override, replaces the configured chain)",
        "info",
      );
      expect(ctx.ui.select).not.toHaveBeenCalled();

      await command?.handler("openai/gpt-5-mini", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Compaction model: openai/gpt-5-mini (session override, replaces the configured chain)",
        "info",
      );

      await command?.handler("gpt-5-mini", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("not an authenticated provider/model id"),
        "error",
      );

      await command?.handler("default", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith("Using Pi's default compaction model", "info");
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("hosts Pi's /model picker over the session shortlist and applies the pick", async () => {
    const { commands } = harness();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({
        "model-aware-compaction": { enabled: true, compactionModel: "anthropic/claude-haiku-4-5" },
      }),
    );
    const modelShape = { api: "anthropic-messages", contextWindow: 200_000, maxTokens: 8_000 };
    const haiku = { ...modelShape, provider: "anthropic", id: "claude-haiku-4-5" };
    const sonnet = { ...modelShape, provider: "anthropic", id: "claude-sonnet-4-5" };
    const scopedModels = [{ model: haiku }, { model: sonnet, thinkingLevel: "high" as const }];
    const tui = { requestRender: vi.fn() };
    const custom = vi.fn(
      (factory: (t: object, theme: object, kb: object, done: (v: PickerModel) => void) => void) =>
        new Promise<PickerModel>((resolve) => {
          factory(tui, {}, {}, resolve);
          // Simulate the user choosing an entry inside Pi's picker.
          modelSelector.mock.lastCall?.[4](sonnet);
        }),
    );
    const ctx = {
      ...context(1_000),
      cwd: temp,
      hasUI: true,
      mode: "tui",
      scopedModels,
      modelRegistry: {
        find: (provider: string, id: string) =>
          [haiku, sonnet].find((m) => m.provider === provider && m.id === id),
        getAvailable: () => [haiku, sonnet],
        getError: () => undefined,
        refresh: vi.fn(),
        getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "secret" }),
        complete: vi.fn(),
      },
    } as ExtensionContext;
    ctx.ui = { ...ctx.ui, custom } as ExtensionContext["ui"];
    try {
      await commands.get("model-aware-compaction-model")?.handler("", ctx);

      expect(ctx.ui.select).not.toHaveBeenCalled();
      const [passedTui, current, runtime, passedScope] = modelSelector.mock.lastCall ?? [];
      expect(passedTui).toBe(tui);
      expect(current).toBe(haiku); // configured selector is pre-highlighted
      expect(passedScope).toEqual(scopedModels); // exact /model shortlist
      expect(runtime?.getAvailableSnapshot()).toEqual([haiku, sonnet]);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Compaction model: anthropic/claude-sonnet-4-5 (session override, replaces the configured chain)",
        "info",
      );
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("falls back to the flat select list outside the TUI, where ui.custom is unavailable", async () => {
    const { commands } = harness();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({ "model-aware-compaction": { enabled: true } }),
    );
    const haiku = { provider: "anthropic", id: "claude-haiku-4-5", contextWindow: 1, maxTokens: 1 };
    const custom = vi.fn(async () => undefined); // what Pi's RPC host does
    const select = vi.fn(async () => "anthropic/claude-haiku-4-5");
    const ctx = {
      ...context(1_000),
      cwd: temp,
      hasUI: true,
      mode: "rpc",
      scopedModels: [{ model: haiku }],
      modelRegistry: {
        find: () => haiku,
        getAvailable: () => [haiku],
        getError: () => undefined,
        refresh: vi.fn(),
        getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "secret" }),
        complete: vi.fn(),
      },
    } as ExtensionContext;
    ctx.ui = { ...ctx.ui, custom, select } as ExtensionContext["ui"];
    try {
      await commands.get("model-aware-compaction-model")?.handler("", ctx);
      expect(custom).not.toHaveBeenCalled();
      expect(modelSelector).not.toHaveBeenCalled();
      expect(select).toHaveBeenCalledWith(
        "Compaction model (session only)",
        expect.arrayContaining(["anthropic/claude-haiku-4-5"]),
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Compaction model: anthropic/claude-haiku-4-5 (session override, replaces the configured chain)",
        "info",
      );
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("never writes a footer status entry for the configured selector", () => {
    const { emit } = harness();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({
        "model-aware-compaction": {
          enabled: true,
          compactionModel: "openai/gpt-5-mini",
        },
      }),
    );
    try {
      const ctx = { ...context(20_000), cwd: temp, hasUI: true };
      emit("session_start", ctx);
      emit("model_select", ctx);
      expect(ctx.ui.setStatus).not.toHaveBeenCalled();
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
      expect(selectedCompact).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("reports provider-default thinking and credential readiness in status", async () => {
    const { commands, api } = harness();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({ "model-aware-compaction": { compactionModel: "test/summary" } }),
    );
    const model = {
      api: "openai-completions",
      provider: "test",
      id: "summary",
      baseUrl: "https://example.test",
      reasoning: true,
      contextWindow: 20_000,
      maxTokens: 2_000,
    };
    const ctx = {
      ...context(1_000),
      cwd: temp,
      modelRegistry: {
        find: (_provider: string, id: string) => (id === "summary" ? model : undefined),
        getAvailable: () => [model],
        getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "secret" }),
        complete: vi.fn(),
      },
    } as ExtensionContext;
    try {
      await commands.get("model-aware-compaction-status")?.handler("", ctx);
      expect(api.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("ready; thinking: provider default"),
        }),
        { triggerTurn: false },
      );
      expect(api.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining(": ready") }),
        { triggerTurn: false },
      );
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("honours a selector thinking suffix for compaction and reports it in status", async () => {
    const { emitAsync, commands, api } = harness();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({
        "model-aware-compaction": { compactionModel: "anthropic/summary-model:low" },
      }),
    );
    const selectedModel = {
      api: "anthropic-messages",
      provider: "anthropic",
      id: "summary-model",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      contextWindow: 200_000,
      maxTokens: 8_192,
    };
    const modelRegistry = {
      find: (_provider: string, id: string) => (id === "summary-model" ? selectedModel : undefined),
      getAvailable: () => [selectedModel],
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "secret" })),
      complete: vi.fn(),
    };
    const ctx = { ...context(20_000), cwd: temp, modelRegistry } as ExtensionContext;
    const preparation = {
      firstKeptEntryId: "kept",
      messagesToSummarize: [{ role: "user", content: "history" }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 20_000,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 4_096, keepRecentTokens: 1_000 },
    };
    selectedCompact.mockResolvedValue({
      summary: "summary",
      firstKeptEntryId: "kept",
      tokensBefore: 20_000,
    });
    try {
      const [hookResult] = await emitAsync(
        "session_before_compact",
        { preparation, branchEntries: [], signal: new AbortController().signal },
        ctx,
      );
      expect(hookResult).toMatchObject({ compaction: { summary: "summary" } });
      // A level rides Pi's simple-stream transport with registry credentials,
      // not the registry's raw complete(), which ignores `reasoning`.
      expect(modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledWith(selectedModel);
      expect(modelRegistry.complete).not.toHaveBeenCalled();

      await commands.get("model-aware-compaction-status")?.handler("", ctx);
      expect(api.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("anthropic/summary-model:low: ready; thinking: low"),
        }),
        { triggerTurn: false },
      );
      expect(api.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining(": ready") }),
        { triggerTurn: false },
      );

      // The level transport needs resolved credentials; without them it fails closed.
      selectedCompact.mockClear();
      const denied = {
        ...ctx,
        modelRegistry: {
          ...modelRegistry,
          getApiKeyAndHeaders: vi.fn(async () => ({ ok: false, error: "no key" })),
        },
      } as ExtensionContext;
      const [deniedResult] = await emitAsync(
        "session_before_compact",
        { preparation, branchEntries: [], signal: new AbortController().signal },
        denied,
      );
      expect(deniedResult).toEqual({ cancel: true });
      expect(selectedCompact).not.toHaveBeenCalled();
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
            compactionModel: "anthropic/summary-model",
            customInstructions: "Keep validation evidence.",
          },
        }),
      );
      const sessionModel = { provider: "openai", id: "gpt-5-mini" };
      const selectedModel = {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "summary-model",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        contextWindow: 200_000,
        maxTokens: 8_192,
      };
      const complete = vi.fn();
      const ctx = {
        ...context(20_000),
        cwd: temp,
        model: sessionModel,
        modelRegistry: {
          find: (_provider: string, id: string) =>
            id === "summary-model" ? selectedModel : undefined,
          getAvailable: () => [selectedModel],
          getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "secret" })),
          complete,
        },
      } as ExtensionContext;
      const preparation = {
        firstKeptEntryId: "kept",
        messagesToSummarize: [{ role: "user", content: "history" }],
        turnPrefixMessages: [{ role: "user", content: "prefix" }],
        isSplitTurn: true,
        tokensBefore: 20_000,
        previousSummary: "prior summary",
        fileOps: {
          read: new Set(["read.ts"]),
          written: new Set<string>(),
          edited: new Set(["edit.ts"]),
        },
        settings: { enabled: true, reserveTokens: 4_096, keepRecentTokens: 1_000 },
      };
      const result = { summary: "summary", firstKeptEntryId: "kept", tokensBefore: 20_000 };
      selectedCompact.mockResolvedValue(result);
      try {
        const [hookResult] = await emitAsync(
          "session_before_compact",
          {
            preparation,
            branchEntries: [],
            customInstructions: "Manual focus.",
            reason,
            signal: new AbortController().signal,
          },
          ctx,
        );
        expect(selectedCompact).toHaveBeenCalledWith(
          expect.objectContaining({
            preparation,
            model: selectedModel,
            complete: expect.any(Function),
            customInstructions: "Manual focus.\n\nKeep validation evidence.",
          }),
        );
        expect(hookResult).toEqual({ compaction: result });
        expect(ctx.model).toBe(sessionModel);
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it("acquires compaction ownership before asynchronous registry completion", async () => {
    const { emitAsync } = harness();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({ "model-aware-compaction": { compactionModel: "test/summary" } }),
    );
    const model = {
      api: "openai-completions",
      provider: "test",
      id: "summary",
      baseUrl: "https://example.test",
      reasoning: false,
      contextWindow: 20_000,
      maxTokens: 2_000,
    };
    const ctx = {
      ...context(1_000),
      cwd: temp,
      modelRegistry: {
        find: () => model,
        getAvailable: () => [model],
        getApiKeyAndHeaders: vi.fn(),
        complete: vi.fn(),
      },
    } as ExtensionContext;
    const preparation = {
      firstKeptEntryId: "kept",
      messagesToSummarize: [{ role: "user", content: "history" }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1_000,
      fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
      settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 },
    };
    let resolveRequest!: (value: object) => void;
    selectedCompact.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const first = emitAsync(
        "session_before_compact",
        { preparation, branchEntries: [], signal: new AbortController().signal },
        ctx,
      );
      await vi.waitFor(() => expect(resolveRequest).toBeTypeOf("function"));
      const [overlap] = await emitAsync(
        "session_before_compact",
        { preparation, branchEntries: [], signal: new AbortController().signal },
        ctx,
      );
      expect(overlap).toEqual({ cancel: true });
      expect(selectedCompact).toHaveBeenCalledTimes(1);
      resolveRequest({ summary: "done", firstKeptEntryId: "kept", tokensBefore: 1_000 });
      await first;
      expect(error).toHaveBeenCalledWith(expect.stringContaining("already in progress"));
    } finally {
      error.mockRestore();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("reports invalid selectors, unavailable models, and provider failures without UI", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const preparation = {
      firstKeptEntryId: "kept",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1_000,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 },
    };
    try {
      for (const selector of ["invalid", "test/missing"]) {
        const { emitAsync } = harness();
        const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
        fs.mkdirSync(path.join(temp, ".pi"));
        fs.writeFileSync(
          path.join(temp, ".pi", "settings.json"),
          JSON.stringify({ "model-aware-compaction": { compactionModel: selector } }),
        );
        const model = {
          api: "openai-completions",
          provider: "test",
          id: "plain",
          baseUrl: "https://example.test",
          reasoning: false,
          contextWindow: 20_000,
          maxTokens: 2_000,
        };
        const ctx = {
          ...context(1_000),
          cwd: temp,
          modelRegistry: {
            find: (_provider: string, id: string) => (id === "plain" ? model : undefined),
            getAvailable: () => [model],
            getApiKeyAndHeaders: vi.fn(),
            complete: vi.fn(),
          },
        } as ExtensionContext;
        const [result] = await emitAsync(
          "session_before_compact",
          { preparation, branchEntries: [], signal: new AbortController().signal },
          ctx,
        );
        expect(result).toEqual({ cancel: true });
        fs.rmSync(temp, { recursive: true, force: true });
      }
      selectedCompact.mockRejectedValueOnce(new Error("provider unavailable"));
      const { emitAsync } = harness();
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
      fs.mkdirSync(path.join(temp, ".pi"));
      fs.writeFileSync(
        path.join(temp, ".pi", "settings.json"),
        JSON.stringify({ "model-aware-compaction": { compactionModel: "test/plain" } }),
      );
      const model = {
        api: "openai-completions",
        provider: "test",
        id: "plain",
        baseUrl: "https://example.test",
        reasoning: false,
        contextWindow: 20_000,
        maxTokens: 2_000,
      };
      const ctx = {
        ...context(1_000),
        cwd: temp,
        modelRegistry: {
          find: () => model,
          getAvailable: () => [model],
          getApiKeyAndHeaders: vi.fn(),
          complete: vi.fn(),
        },
      } as ExtensionContext;
      expect(
        (
          await emitAsync(
            "session_before_compact",
            { preparation, branchEntries: [], signal: new AbortController().signal },
            ctx,
          )
        )[0],
      ).toEqual({ cancel: true });
      fs.rmSync(temp, { recursive: true, force: true });
      const messages = error.mock.calls.map(([message]) => message).join("\n");
      expect(messages).toContain("invalid compactionModel selector");
      expect(messages).toContain("is unavailable");
      expect(messages).toContain("provider unavailable");
    } finally {
      error.mockRestore();
    }
  });

  it("merges the latest owned compaction file metadata into a cloned SDK preparation", async () => {
    const { emitAsync } = harness();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({ "model-aware-compaction": { compactionModel: "test/summary" } }),
    );
    const model = {
      api: "openai-completions",
      provider: "test",
      id: "summary",
      baseUrl: "https://example.test",
      reasoning: false,
      contextWindow: 20_000,
      maxTokens: 2_000,
    };
    const ctx = {
      ...context(1_000),
      cwd: temp,
      modelRegistry: {
        find: () => model,
        getAvailable: () => [model],
        getApiKeyAndHeaders: vi.fn(),
        complete: vi.fn(),
      },
    } as ExtensionContext;
    const preparation = {
      firstKeptEntryId: "current-boundary",
      messagesToSummarize: [{ role: "user", content: "new history" }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1_000,
      previousSummary: "owned prior summary",
      fileOps: {
        read: new Set(["new-read.ts"]),
        written: new Set(["old-read.ts"]),
        edited: new Set<string>(),
      },
      settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 },
    };
    const branchEntries = [
      { type: "message", id: "prior-boundary" },
      {
        type: "compaction",
        id: "prior-compaction",
        fromHook: true,
        summary: "owned prior summary",
        firstKeptEntryId: "prior-boundary",
        details: {
          owner: "@pinet/model-aware-compaction",
          version: 1,
          readFiles: ["old-read.ts"],
          modifiedFiles: ["old-modified.ts"],
        },
      },
      { type: "message", id: "current-boundary" },
    ];
    selectedCompact.mockResolvedValue({
      summary: "next summary",
      firstKeptEntryId: "current-boundary",
      tokensBefore: 1_000,
    });
    try {
      await emitAsync(
        "session_before_compact",
        { preparation, branchEntries, signal: new AbortController().signal },
        ctx,
      );
      const merged = selectedCompact.mock.calls[0][0].preparation;
      expect([...merged.fileOps.read].sort()).toEqual(["new-read.ts", "old-read.ts"]);
      expect([...merged.fileOps.edited]).toEqual(["old-modified.ts"]);
      expect([...merged.fileOps.written]).toEqual(["old-read.ts"]);
      expect([...preparation.fileOps.read]).toEqual(["new-read.ts"]);
      expect([...preparation.fileOps.edited]).toEqual([]);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("fails closed for oversized input and honors cancellation without provider work", async () => {
    const { emitAsync } = harness();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({ "model-aware-compaction": { compactionModel: "test/tiny" } }),
    );
    const model = {
      api: "openai-completions",
      provider: "test",
      id: "tiny",
      baseUrl: "https://example.test",
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
        { preparation, branchEntries: [], signal: new AbortController().signal },
        ctx,
      );
      const [oversizedPriorSummary] = await emitAsync(
        "session_before_compact",
        {
          preparation: {
            ...preparation,
            messagesToSummarize: [],
            turnPrefixMessages: [{ role: "user", content: "retained turn prefix" }],
            isSplitTurn: true,
            previousSummary: "p".repeat(40_000),
          },
          branchEntries: [],
          customInstructions: "Preserve owner decisions.",
          signal: new AbortController().signal,
        },
        ctx,
      );
      const controller = new AbortController();
      controller.abort();
      const [cancelled] = await emitAsync(
        "session_before_compact",
        {
          preparation: { ...preparation, messagesToSummarize: [] },
          branchEntries: [],
          signal: controller.signal,
        },
        ctx,
      );
      expect(oversized).toEqual({ cancel: true });
      expect(oversizedPriorSummary).toEqual({ cancel: true });
      expect(cancelled).toEqual({ cancel: true });
      expect(selectedCompact).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});

describe("fallback chain", () => {
  const modelFor = (id: string, contextWindow = 200_000) => ({
    api: "anthropic-messages",
    provider: "test",
    id,
    baseUrl: "https://example.test",
    reasoning: false,
    contextWindow,
    maxTokens: 8_192,
  });
  const preparation = {
    firstKeptEntryId: "kept",
    messagesToSummarize: [{ role: "user", content: "history" }],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 20_000,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens: 4_096, keepRecentTokens: 1_000 },
  };
  const result = { summary: "summary", firstKeptEntryId: "kept", tokensBefore: 20_000 };

  function chainHarness(chain: string[], models: ReturnType<typeof modelFor>[]) {
    const { emitAsync, commands, api } = harness();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({ "model-aware-compaction": { compactionModel: chain } }),
    );
    const modelRegistry = {
      find: (_provider: string, id: string) => models.find((model) => model.id === id),
      getAvailable: () => models,
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "secret" })),
      complete: vi.fn(),
    };
    const ctx = { ...context(20_000), cwd: temp, modelRegistry } as ExtensionContext;
    const compact = (signal = new AbortController().signal) =>
      emitAsync("session_before_compact", { preparation, branchEntries: [], signal }, ctx).then(
        ([hookResult]) => hookResult,
      );
    const cleanup = () => fs.rmSync(temp, { recursive: true, force: true });
    return { ctx, compact, commands, api, modelRegistry, cleanup };
  }

  it("advances past a failing provider and records which entry produced the summary", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { compact, cleanup } = chainHarness(
      ["test/primary", "test/secondary"],
      [modelFor("primary"), modelFor("secondary")],
    );
    selectedCompact
      .mockRejectedValueOnce(new Error("429 rate limited"))
      .mockResolvedValueOnce(result);
    try {
      expect(await compact()).toEqual({ compaction: result });
      expect(selectedCompact).toHaveBeenCalledTimes(2);
      expect(selectedCompact.mock.calls[0][0]).toMatchObject({
        model: modelFor("primary"),
        selector: "test/primary",
      });
      expect(selectedCompact.mock.calls[1][0]).toMatchObject({
        model: modelFor("secondary"),
        selector: "test/secondary",
      });
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("fell back to test/secondary after test/primary: 429 rate limited"),
      );
    } finally {
      error.mockRestore();
      cleanup();
    }
  });

  it("skips entries whose window cannot hold the history or that are unavailable, without a request", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { compact, cleanup } = chainHarness(
      ["test/missing", "test/tiny", "test/large"],
      // 4_096 reserve alone exceeds a 4_000-token window; nothing should be sent there.
      [modelFor("tiny", 4_000), modelFor("large")],
    );
    selectedCompact.mockResolvedValueOnce(result);
    try {
      expect(await compact()).toEqual({ compaction: result });
      expect(selectedCompact).toHaveBeenCalledTimes(1);
      expect(selectedCompact.mock.calls[0][0]).toMatchObject({ model: modelFor("large") });
    } finally {
      vi.mocked(console.error).mockRestore();
      cleanup();
    }
  });

  it("fails closed naming every entry when the whole chain fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { compact, cleanup } = chainHarness(
      ["test/primary", "test/secondary"],
      [modelFor("primary"), modelFor("secondary")],
    );
    selectedCompact
      .mockRejectedValueOnce(new Error("primary down"))
      .mockRejectedValueOnce(new Error("secondary down"));
    try {
      expect(await compact()).toEqual({ cancel: true });
      const messages = error.mock.calls.map(([message]) => String(message)).join("\n");
      expect(messages).toContain("every compaction model failed");
      expect(messages).toContain("test/primary: primary down");
      expect(messages).toContain("test/secondary: secondary down");
    } finally {
      error.mockRestore();
      cleanup();
    }
  });

  it("never advances on cancellation or on an unparseable entry", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const cancelled = chainHarness(
        ["test/primary", "test/secondary"],
        [modelFor("primary"), modelFor("secondary")],
      );
      const controller = new AbortController();
      selectedCompact.mockImplementationOnce(async () => {
        controller.abort();
        throw new Error("Compaction cancelled");
      });
      expect(await cancelled.compact(controller.signal)).toEqual({ cancel: true });
      expect(selectedCompact).toHaveBeenCalledTimes(1);
      cancelled.cleanup();

      selectedCompact.mockReset();
      const typo = chainHarness(["not-a-selector", "test/secondary"], [modelFor("secondary")]);
      expect(await typo.compact()).toEqual({ cancel: true });
      expect(selectedCompact).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('invalid compactionModel selector "not-a-selector"'),
      );
      typo.cleanup();
    } finally {
      error.mockRestore();
    }
  });

  it("fails closed on a malformed rule chain instead of skipping to its fallback or the global chain", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { emitAsync } = harness();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({
        "model-aware-compaction": {
          compactionModel: "test/global",
          rules: [
            {
              model: "openai/*",
              activeContextTokens: 100_000,
              // An object whose text contains "/" would otherwise parse as a selector
              // and advance as "unavailable" instead of failing closed.
              compactionModel: [{ "test/rule": 1 }, "test/rule"],
            },
          ],
        },
      }),
    );
    const models = [modelFor("global"), modelFor("rule")];
    const ctx = {
      ...context(20_000),
      cwd: temp,
      modelRegistry: {
        find: (_provider: string, id: string) => models.find((model) => model.id === id),
        getAvailable: () => models,
        getApiKeyAndHeaders: vi.fn(async () => ({ ok: true })),
        complete: vi.fn(),
      },
    } as ExtensionContext;
    try {
      const [hookResult] = await emitAsync(
        "session_before_compact",
        { preparation, branchEntries: [], signal: new AbortController().signal },
        ctx,
      );
      expect(hookResult).toEqual({ cancel: true });
      expect(selectedCompact).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('invalid compactionModel selector "<invalid {"test/rule":1}>"'),
      );
      const { commands, api } = harness();
      await commands.get("model-aware-compaction-status")?.handler("", ctx);
      expect(vi.mocked(api.sendMessage).mock.calls[0][0].content).toContain(
        '  - <invalid {"test/rule":1}>: invalid selector',
      );
    } finally {
      error.mockRestore();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("lets a session override replace the whole chain and default restore it", async () => {
    const { compact, commands, ctx, cleanup } = chainHarness(
      ["test/primary", "test/secondary"],
      [modelFor("primary"), modelFor("secondary"), modelFor("override")],
    );
    selectedCompact.mockResolvedValue(result);
    try {
      await commands.get("model-aware-compaction-model")?.handler("test/override", ctx);
      expect(await compact()).toEqual({ compaction: result });
      expect(selectedCompact).toHaveBeenCalledTimes(1);
      expect(selectedCompact.mock.calls[0][0]).toMatchObject({ selector: "test/override" });

      await commands.get("model-aware-compaction-model")?.handler("default", ctx);
      selectedCompact.mockReset();
      selectedCompact.mockResolvedValue(result);
      await compact();
      expect(selectedCompact.mock.calls[0][0]).toMatchObject({ selector: "test/primary" });
    } finally {
      cleanup();
    }
  });

  it("reports each chain entry's readiness in status", async () => {
    const { commands, ctx, api, cleanup } = chainHarness(
      ["test/primary", "test/missing", "test/small:low"],
      [modelFor("primary"), modelFor("small", 10_000)],
    );
    try {
      await commands.get("model-aware-compaction-status")?.handler("", ctx);
      const content = vi.mocked(api.sendMessage).mock.calls[0][0].content;
      expect(content).toContain("- compaction model chain:");
      expect(content).toContain("  - test/primary: ready; thinking: provider default");
      expect(content).toContain("  - test/missing: unavailable");
      expect(content).toContain(
        "  - test/small:low: ready, but window 10000 is below current context (heuristic); thinking: low (effective: off)",
      );
    } finally {
      cleanup();
    }
  });
});

describe("session switch", () => {
  it("/model-aware-compaction-off stops proactive triggers and routing until -on", async () => {
    const { emit, emitAsync, commands } = harness();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({
        "model-aware-compaction": {
          enabled: true,
          compactionModel: "test/plain",
          rules: [{ model: "openai/*", activeContextTokens: 100_000 }],
        },
      }),
    );
    const model = {
      api: "anthropic-messages",
      provider: "test",
      id: "plain",
      baseUrl: "https://example.test",
      reasoning: false,
      contextWindow: 200_000,
      maxTokens: 8_192,
    };
    const compact = vi.fn();
    const ctx = {
      ...context(120_000, compact),
      cwd: temp,
      modelRegistry: {
        find: () => model,
        getAvailable: () => [model],
        getApiKeyAndHeaders: vi.fn(async () => ({ ok: true })),
        complete: vi.fn(),
      },
    } as ExtensionContext;
    const preparation = {
      firstKeptEntryId: "kept",
      messagesToSummarize: [{ role: "user", content: "history" }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 20_000,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 4_096, keepRecentTokens: 1_000 },
    };
    const hook = () =>
      emitAsync(
        "session_before_compact",
        { preparation, branchEntries: [], signal: new AbortController().signal },
        ctx,
      ).then(([hookResult]) => hookResult);
    try {
      await commands.get("model-aware-compaction-off")?.handler("", ctx);
      emit("agent_settled", ctx);
      expect(compact).not.toHaveBeenCalled();
      // Returning nothing lets Pi's stock compaction run on the active model.
      expect(await hook()).toBeUndefined();
      expect(selectedCompact).not.toHaveBeenCalled();

      await commands.get("model-aware-compaction-on")?.handler("", ctx);
      emit("agent_settled", ctx);
      expect(compact).toHaveBeenCalledTimes(1);
      selectedCompact.mockResolvedValue({
        summary: "s",
        firstKeptEntryId: "kept",
        tokensBefore: 1,
      });
      expect(await hook()).toMatchObject({ compaction: { summary: "s" } });
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
