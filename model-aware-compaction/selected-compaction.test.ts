import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { runSelectedModelCompaction, type RegistryComplete } from "./selected-compaction.js";

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
