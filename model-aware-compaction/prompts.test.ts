import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import {
  PI_COMPACTION_PROMPT_VERSION,
  SUMMARIZATION_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
  TURN_PREFIX_SUMMARIZATION_PROMPT,
  UPDATE_SUMMARIZATION_INSTRUCTIONS,
  UPDATE_SUMMARIZATION_PROMPT,
} from "./prompts.js";
import { runSelectedModelCompaction, type RegistryComplete } from "./selected-compaction.js";

const sdkCompactionDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  "core",
  "compaction",
);

function sdkPromptTemplate(sourceFile: string, name: string): string {
  const source = fs.readFileSync(path.join(sdkCompactionDirectory, sourceFile), "utf8");
  const match = new RegExp("const " + name + " = `([\\s\\S]*?)`;").exec(source);
  if (!match) throw new Error(`Pi ${PI_COMPACTION_PROMPT_VERSION} prompt ${name} was not found`);
  return match[1];
}

const sdkSystemPrompt = sdkPromptTemplate("utils.js", "SUMMARIZATION_SYSTEM_PROMPT");
const sdkSummarizationPrompt = sdkPromptTemplate("compaction.js", "SUMMARIZATION_PROMPT");
const sdkUpdateInstructions = sdkPromptTemplate(
  "compaction.js",
  "UPDATE_SUMMARIZATION_INSTRUCTIONS",
);
const sdkUpdatePrompt = sdkPromptTemplate("compaction.js", "UPDATE_SUMMARIZATION_PROMPT").replace(
  "${UPDATE_SUMMARIZATION_INSTRUCTIONS}",
  sdkUpdateInstructions,
);
const sdkTurnPrefixPrompt = sdkPromptTemplate("compaction.js", "TURN_PREFIX_SUMMARIZATION_PROMPT");

interface UserMessage {
  role: "user";
  content: string;
  timestamp: number;
}

const preparation = {
  firstKeptEntryId: "kept",
  messagesToSummarize: [{ role: "user", content: "history", timestamp: 1 }] as UserMessage[],
  turnPrefixMessages: [] as UserMessage[],
  isSplitTurn: false,
  tokensBefore: 1_000,
  previousSummary: undefined as string | undefined,
  fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
  settings: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 500 },
};

async function capturePromptTexts(
  options: Partial<typeof preparation> & { customInstructions?: string },
): Promise<string[]> {
  const { customInstructions, ...preparationOverrides } = options;
  const prompts: string[] = [];
  const complete = vi.fn<RegistryComplete>(async (_model, context) => {
    expect(context.systemPrompt).toBe(sdkSystemPrompt);
    const content = context.messages[0].content;
    const block = typeof content === "string" ? undefined : content[0];
    prompts.push(block && block.type === "text" ? block.text : "");
    return fauxAssistantMessage("summary");
  });
  await runSelectedModelCompaction({
    preparation: { ...preparation, ...preparationOverrides },
    model: fauxProvider().getModel(),
    complete,
    signal: new AbortController().signal,
    customInstructions,
  });
  return prompts;
}

describe(`Pi ${PI_COMPACTION_PROMPT_VERSION} prompt parity`, () => {
  it("copies the pinned SDK system, initial, update, and split-turn prompts verbatim", () => {
    expect(SUMMARIZATION_SYSTEM_PROMPT).toBe(sdkSystemPrompt);
    expect(SUMMARIZATION_PROMPT).toBe(sdkSummarizationPrompt);
    expect(UPDATE_SUMMARIZATION_INSTRUCTIONS).toBe(sdkUpdateInstructions);
    expect(UPDATE_SUMMARIZATION_PROMPT).toBe(sdkUpdatePrompt);
    expect(TURN_PREFIX_SUMMARIZATION_PROMPT).toBe(sdkTurnPrefixPrompt);
  });

  it("sends the SDK initial request text when there is no previous summary", async () => {
    const prompts = await capturePromptTexts({});
    expect(prompts).toEqual([
      `<conversation>\n[User]: history\n</conversation>\n\n${sdkSummarizationPrompt}`,
    ]);
  });

  it("sends the SDK update request text with previous summary and custom focus", async () => {
    const prompts = await capturePromptTexts({
      previousSummary: "previous checkpoint",
      customInstructions: "Preserve validation evidence.",
    });
    expect(prompts).toEqual([
      `<conversation>\n[User]: history\n</conversation>\n\n` +
        `<previous-summary>\nprevious checkpoint\n</previous-summary>\n\n` +
        `${sdkUpdatePrompt}\n\nAdditional focus: Preserve validation evidence.`,
    ]);
  });

  it("sends the SDK turn-prefix request text for split turns", async () => {
    const prompts = await capturePromptTexts({
      isSplitTurn: true,
      turnPrefixMessages: [{ role: "user", content: "prefix", timestamp: 2 }],
    });
    expect(prompts).toEqual([
      `<conversation>\n[User]: history\n</conversation>\n\n${sdkSummarizationPrompt}`,
      `<conversation>\n[User]: prefix\n</conversation>\n\n${sdkTurnPrefixPrompt}`,
    ]);
  });
});
