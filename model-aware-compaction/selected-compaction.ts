import { contentText, uuidv7 } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ThinkingLevel as ReasoningLevel,
  Usage,
} from "@earendil-works/pi-ai/compat";
import {
  convertToLlm,
  serializeConversation,
  type CompactionPreparation,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  buildHistoryPrompt,
  buildTurnPrefixPrompt,
  SUMMARIZATION_SYSTEM_PROMPT,
} from "./prompts.js";
import type { ThinkingLevel } from "./helpers.js";

export type RegistryComplete = (
  model: Model<Api>,
  context: Context,
  options: {
    maxTokens: number;
    signal: AbortSignal;
    cacheRetention: "none";
    sessionId: string;
    reasoning?: ReasoningLevel;
  },
) => Promise<AssistantMessage>;

export interface ModelAwareCompactionDetails {
  owner: "@pinet/model-aware-compaction";
  version: 1;
  readFiles: string[];
  modifiedFiles: string[];
}

interface SelectedCompactionOptions {
  preparation: CompactionPreparation;
  model: Model<Api>;
  complete: RegistryComplete;
  signal: AbortSignal;
  customInstructions?: string;
  /** Explicit `:level` from the selector; omitted (or `off`) sends no reasoning option. */
  thinkingLevel?: ThinkingLevel;
}

export function mergePriorModelAwareFiles(
  preparation: CompactionPreparation,
  branchEntries: SessionEntry[],
): CompactionPreparation {
  const cloned = {
    ...preparation,
    fileOps: {
      read: new Set(preparation.fileOps.read),
      written: new Set(preparation.fileOps.written),
      edited: new Set(preparation.fileOps.edited),
    },
  };
  const currentBoundaryIndex = branchEntries.findIndex(
    (entry) => entry.id === preparation.firstKeptEntryId,
  );
  if (currentBoundaryIndex < 0) return cloned;

  let priorIndex = -1;
  for (let index = branchEntries.length - 1; index >= 0; index--) {
    if (branchEntries[index].type === "compaction") {
      priorIndex = index;
      break;
    }
  }
  if (priorIndex < 0) return cloned;

  const prior = branchEntries[priorIndex];
  if (prior.type !== "compaction" || !prior.fromHook) return cloned;
  const details = prior.details as Partial<ModelAwareCompactionDetails> | undefined;
  if (
    details?.owner !== "@pinet/model-aware-compaction" ||
    details.version !== 1 ||
    !Array.isArray(details.readFiles) ||
    !details.readFiles.every((file) => typeof file === "string") ||
    !Array.isArray(details.modifiedFiles) ||
    !details.modifiedFiles.every((file) => typeof file === "string") ||
    preparation.previousSummary !== prior.summary
  )
    return cloned;

  const priorBoundaryIndex = branchEntries.findIndex(
    (entry) => entry.id === prior.firstKeptEntryId,
  );
  if (priorBoundaryIndex < 0 || currentBoundaryIndex < priorBoundaryIndex) return cloned;

  for (const file of details.readFiles) cloned.fileOps.read.add(file);
  for (const file of details.modifiedFiles) cloned.fileOps.edited.add(file);
  return cloned;
}

async function summarize(
  complete: RegistryComplete,
  model: Model<Api>,
  promptText: string,
  maxTokens: number,
  signal: AbortSignal,
  thinkingLevel: ThinkingLevel | undefined,
): Promise<{ text: string; usage: Usage }> {
  const response = await complete(
    model,
    {
      systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: promptText,
            },
          ],
          timestamp: Date.now(),
        },
      ],
    },
    // Pi passes no session ID for compaction, so each summary gets a fresh routing ID.
    {
      maxTokens,
      signal,
      cacheRetention: "none",
      sessionId: uuidv7(),
      // pi-ai has no "off" level: omitting `reasoning` is off / provider default.
      ...(thinkingLevel && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
    },
  );
  if (signal.aborted) throw new Error("Compaction cancelled");
  if (response.stopReason === "error")
    throw new Error(response.errorMessage || "Compaction provider failed");
  if (response.stopReason === "length")
    throw new Error("generation hit the token cap and the summary is incomplete");
  if (response.content.some((block) => block.type === "toolCall"))
    throw new Error("Compaction model attempted to call a tool");
  const text = contentText(response.content).trim();
  if (!text) throw new Error("Compaction model returned an empty summary section");
  return { text, usage: response.usage };
}

export async function runSelectedModelCompaction({
  preparation,
  model,
  complete,
  signal,
  customInstructions,
  thinkingLevel,
}: SelectedCompactionOptions) {
  const historyMaxTokens = Math.min(
    Math.floor(preparation.settings.reserveTokens * 0.8),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
  const prefixMaxTokens = Math.min(
    Math.floor(preparation.settings.reserveTokens * 0.5),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
  let summary: string;
  let usage: Usage;

  if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
    const history =
      preparation.messagesToSummarize.length > 0 || preparation.previousSummary
        ? await summarize(
            complete,
            model,
            buildHistoryPrompt(
              serializeConversation(convertToLlm(preparation.messagesToSummarize)),
              customInstructions,
              preparation.previousSummary,
            ),
            historyMaxTokens,
            signal,
            thinkingLevel,
          )
        : undefined;
    const prefix = await summarize(
      complete,
      model,
      buildTurnPrefixPrompt(serializeConversation(convertToLlm(preparation.turnPrefixMessages))),
      prefixMaxTokens,
      signal,
      thinkingLevel,
    );
    summary = `${history?.text ?? "No prior history."}\n\n---\n\n**Turn Context (split turn):**\n\n${prefix.text}`;
    usage = history
      ? {
          input: history.usage.input + prefix.usage.input,
          output: history.usage.output + prefix.usage.output,
          cacheRead: history.usage.cacheRead + prefix.usage.cacheRead,
          cacheWrite: history.usage.cacheWrite + prefix.usage.cacheWrite,
          totalTokens: history.usage.totalTokens + prefix.usage.totalTokens,
          cost: {
            input: history.usage.cost.input + prefix.usage.cost.input,
            output: history.usage.cost.output + prefix.usage.cost.output,
            cacheRead: history.usage.cost.cacheRead + prefix.usage.cost.cacheRead,
            cacheWrite: history.usage.cost.cacheWrite + prefix.usage.cost.cacheWrite,
            total: history.usage.cost.total + prefix.usage.cost.total,
          },
          ...(history.usage.cacheWrite1h !== undefined || prefix.usage.cacheWrite1h !== undefined
            ? {
                cacheWrite1h: (history.usage.cacheWrite1h ?? 0) + (prefix.usage.cacheWrite1h ?? 0),
              }
            : {}),
          ...(history.usage.reasoning !== undefined || prefix.usage.reasoning !== undefined
            ? { reasoning: (history.usage.reasoning ?? 0) + (prefix.usage.reasoning ?? 0) }
            : {}),
        }
      : prefix.usage;
  } else {
    const history = await summarize(
      complete,
      model,
      buildHistoryPrompt(
        serializeConversation(convertToLlm(preparation.messagesToSummarize)),
        customInstructions,
        preparation.previousSummary,
      ),
      historyMaxTokens,
      signal,
      thinkingLevel,
    );
    summary = history.text;
    usage = history.usage;
  }

  const modifiedFiles = [
    ...new Set([...preparation.fileOps.edited, ...preparation.fileOps.written]),
  ].sort();
  const modified = new Set(modifiedFiles);
  const readFiles = [...preparation.fileOps.read].filter((file) => !modified.has(file)).sort();
  const fileSections = [
    readFiles.length ? `<read-files>\n${readFiles.join("\n")}\n</read-files>` : "",
    modifiedFiles.length ? `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>` : "",
  ].filter(Boolean);
  if (fileSections.length) summary += `\n\n${fileSections.join("\n\n")}`;

  return {
    summary,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    usage,
    details: {
      owner: "@pinet/model-aware-compaction" as const,
      version: 1 as const,
      readFiles,
      modifiedFiles,
    },
  };
}
