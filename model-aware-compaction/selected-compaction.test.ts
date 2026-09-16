import { ModelRegistry, ModelRuntime, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import {
  mergePriorModelAwareFiles,
  runSelectedModelCompaction,
  type RegistryComplete,
} from "./selected-compaction.js";

const usage = (input: number, output: number) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const preparation = {
  firstKeptEntryId: "kept",
  messagesToSummarize: [{ role: "user" as const, content: "history", timestamp: 1 }],
  turnPrefixMessages: [{ role: "user" as const, content: "prefix", timestamp: 2 }],
  isSplitTurn: true,
  tokensBefore: 1_000,
  previousSummary: "previous checkpoint",
  fileOps: {
    read: new Set(["read.ts", "edited.ts"]),
    written: new Set(["written.ts"]),
    edited: new Set(["edited.ts"]),
  },
  settings: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 500 },
};

describe("selected-model compaction", () => {
  it("preserves split turns, previous summary, boundary, files, custom focus, and usage", async () => {
    const faux = fauxProvider({ provider: "summary-faux" });
    faux.setResponses([
      { ...fauxAssistantMessage("history summary"), usage: usage(10, 4) },
      { ...fauxAssistantMessage("prefix summary"), usage: usage(6, 3) },
    ]);
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
    const registry = new ModelRegistry(runtime);
    registry.registerProvider(faux.provider);
    const model = registry.find("summary-faux", faux.getModel().id);
    expect(model).toBeDefined();
    const complete = vi.spyOn(registry, "complete");

    const result = await runSelectedModelCompaction({
      preparation,
      model: model as Model<Api>,
      complete: registry.complete.bind(registry) as RegistryComplete,
      signal: new AbortController().signal,
      customInstructions: "Preserve validation evidence.",
    });

    expect(faux.state.callCount).toBe(2);
    expect(complete).toHaveBeenCalledTimes(2);
    const firstContext = complete.mock.calls[0][1];
    const firstPrompt = firstContext.messages[0].content;
    expect(JSON.stringify(firstPrompt)).toContain("previous checkpoint");
    expect(JSON.stringify(firstPrompt)).toContain("Preserve validation evidence.");
    expect(JSON.stringify(complete.mock.calls[1][1].messages[0].content)).toContain("prefix");
    expect(result).toMatchObject({
      firstKeptEntryId: "kept",
      tokensBefore: 1_000,
      details: { readFiles: ["read.ts"], modifiedFiles: ["edited.ts", "written.ts"] },
    });
    const responses = await Promise.all(complete.mock.results.map((call) => call.value));
    expect(result.usage.input).toBe(responses[0].usage.input + responses[1].usage.input);
    expect(result.usage.output).toBe(responses[0].usage.output + responses[1].usage.output);
    expect(result.summary).toContain("history summary");
    expect(result.summary).toContain("prefix summary");
    expect(result.summary).toContain("<read-files>\nread.ts\n</read-files>");
    expect(result.summary).toContain("<modified-files>\nedited.ts\nwritten.ts\n</modified-files>");
    expect(result.usage).not.toHaveProperty("cacheWrite1h");
    expect(result.usage).not.toHaveProperty("reasoning");

    const branchEntries = [
      {
        type: "message",
        id: "kept",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "retained", timestamp: 1 },
      },
      {
        type: "compaction",
        id: "owned-compaction",
        parentId: "kept",
        timestamp: "2026-01-01T00:00:01.000Z",
        summary: result.summary,
        firstKeptEntryId: result.firstKeptEntryId,
        tokensBefore: result.tokensBefore,
        details: result.details,
        fromHook: true,
      },
      {
        type: "message",
        id: "next-user",
        parentId: "owned-compaction",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "user", content: "next turn", timestamp: 2 },
      },
      {
        type: "message",
        id: "next-assistant",
        parentId: "next-user",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: fauxAssistantMessage("work after compaction"),
      },
    ] as SessionEntry[];
    // Pi 0.85.1 deliberately omits prior details when the previous compaction has fromHook=true.
    const sdkPreparation = {
      firstKeptEntryId: "next-assistant",
      messagesToSummarize: [{ role: "user", content: "next turn", timestamp: 2 }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1_200,
      previousSummary: result.summary,
      fileOps: {
        read: new Set(["new-read.ts"]),
        written: new Set(["read.ts"]),
        edited: new Set<string>(),
      },
      settings: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 1 },
    };
    const repeated = mergePriorModelAwareFiles(sdkPreparation, branchEntries);
    expect([...repeated.fileOps.read].sort()).toEqual(["new-read.ts", "read.ts"]);
    expect([...repeated.fileOps.edited].sort()).toEqual(["edited.ts", "written.ts"]);
    expect([...repeated.fileOps.written]).toEqual(["read.ts"]);
    const repeatedResult = await runSelectedModelCompaction({
      preparation: repeated,
      model: model as Model<Api>,
      complete: async () => fauxAssistantMessage("repeated summary"),
      signal: new AbortController().signal,
    });
    expect(repeatedResult.details).toEqual({
      owner: "@pinet/model-aware-compaction",
      version: 1,
      readFiles: ["new-read.ts"],
      modifiedFiles: ["edited.ts", "read.ts", "written.ts"],
    });
    expect(repeatedResult.summary).toContain("<read-files>\nnew-read.ts\n</read-files>");
    expect(repeatedResult.summary).toContain(
      "<modified-files>\nedited.ts\nread.ts\nwritten.ts\n</modified-files>",
    );

    const unrelatedBranch = [
      ...branchEntries,
      {
        type: "compaction",
        id: "other-extension",
        parentId: "next-assistant",
        timestamp: "2026-01-01T00:00:04.000Z",
        summary: "other checkpoint",
        firstKeptEntryId: "next-assistant",
        tokensBefore: 500,
        details: { readFiles: ["other.ts"], modifiedFiles: [] },
        fromHook: true,
      },
      {
        type: "message",
        id: "after-other",
        parentId: "other-extension",
        timestamp: "2026-01-01T00:00:05.000Z",
        message: { role: "user", content: "after other extension", timestamp: 3 },
      },
    ] as SessionEntry[];
    const isolated = mergePriorModelAwareFiles(
      {
        ...sdkPreparation,
        firstKeptEntryId: "after-other",
        previousSummary: "other checkpoint",
        fileOps: { read: new Set(["local.ts"]), written: new Set(), edited: new Set() },
      },
      unrelatedBranch,
    );
    expect([...isolated.fileOps.read]).toEqual(["local.ts"]);
  });

  it("uses a prior checkpoint as history when a split turn has no new history", async () => {
    const prompts: string[] = [];
    const complete = vi.fn<RegistryComplete>(async (_model, context) => {
      prompts.push(JSON.stringify(context.messages[0].content));
      return fauxAssistantMessage(
        prompts.length === 1 ? "updated prior checkpoint" : "prefix summary",
      );
    });
    const result = await runSelectedModelCompaction({
      preparation: { ...preparation, messagesToSummarize: [] },
      model: fauxProvider().getModel(),
      complete,
      signal: new AbortController().signal,
      customInstructions: "Keep owner decisions.",
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(prompts[0]).toContain("previous checkpoint");
    expect(prompts[0]).toContain("Keep owner decisions.");
    expect(result.summary).toContain("updated prior checkpoint");
    expect(result.summary).not.toContain("No prior history.");
  });

  it("preserves optional usage fields with SDK aggregation semantics", async () => {
    const complete = vi
      .fn<RegistryComplete>()
      .mockResolvedValueOnce({
        ...fauxAssistantMessage("history summary"),
        usage: { ...usage(10, 4), cacheWrite1h: 4, reasoning: 2 },
      })
      .mockResolvedValueOnce({
        ...fauxAssistantMessage("prefix summary"),
        usage: { ...usage(6, 3), reasoning: 3 },
      });
    const result = await runSelectedModelCompaction({
      preparation,
      model: fauxProvider().getModel(),
      complete,
      signal: new AbortController().signal,
    });
    expect(result.usage.cacheWrite1h).toBe(4);
    expect(result.usage.reasoning).toBe(5);
  });

  it("rejects an empty split-turn section before wrappers or file metadata mask it", async () => {
    const faux = fauxProvider({ provider: "empty-summary-faux" });
    faux.setResponses([fauxAssistantMessage("history summary"), fauxAssistantMessage("")]);
    const complete: RegistryComplete = (model, context, options): Promise<AssistantMessage> =>
      faux.provider.stream(model, context, options).result();

    await expect(
      runSelectedModelCompaction({
        preparation,
        model: faux.getModel(),
        complete,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("empty summary section");
    expect(faux.state.callCount).toBe(2);
  });

  it("fails closed on cancellation and length-limited sections", async () => {
    const controller = new AbortController();
    const complete = vi.fn<RegistryComplete>();
    complete.mockImplementationOnce(async () => {
      controller.abort();
      return fauxAssistantMessage("late summary");
    });
    await expect(
      runSelectedModelCompaction({
        preparation: { ...preparation, isSplitTurn: false },
        model: fauxProvider().getModel(),
        complete,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");

    const lengthResponse = { ...fauxAssistantMessage("partial"), stopReason: "length" as const };
    await expect(
      runSelectedModelCompaction({
        preparation: { ...preparation, isSplitTurn: false },
        model: fauxProvider().getModel(),
        complete: async () => lengthResponse,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("token cap");
  });
});
