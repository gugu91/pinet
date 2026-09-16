import { randomUUID } from "node:crypto";
import type { Api, AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai/compat";
import {
  convertToLlm,
  serializeConversation,
  type CompactionPreparation,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

const SYSTEM_PROMPT = `You are a context summarization assistant. Summarize the supplied conversation so another LLM can continue the work. Do not continue the conversation or answer its questions.`;
const SUMMARY_PROMPT = `Create a structured context checkpoint with these sections: Goal, Constraints & Preferences, Progress (Done, In Progress, Blocked), Key Decisions, Next Steps, and Critical Context. Be concise and preserve exact paths, names, errors, decisions, and validation results.`;
const TURN_PREFIX_PROMPT = `This is the prefix of a turn whose suffix is retained. Summarize the original request, early progress, and context needed to understand the retained suffix. Be concise.`;

export type RegistryComplete = (
  model: Model<Api>,
  context: Context,
  options: {
    maxTokens: number;
    signal: AbortSignal;
    cacheRetention: "none";
    sessionId: string;
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
  serializedConversation: string,
  instructions: string,
  maxTokens: number,
  signal: AbortSignal,
  previousSummary?: string,
): Promise<{ text: string; usage: Usage }> {
  const previous = previousSummary
    ? `\n\n<previous-summary>\n${previousSummary}\n</previous-summary>\nUpdate and preserve the previous summary.`
    : "";
  const response = await complete(
    model,
    {
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `<conversation>\n${serializedConversation}\n</conversation>${previous}\n\n${instructions}`,
            },
          ],
          timestamp: Date.now(),
        },
      ],
    },
    { maxTokens, signal, cacheRetention: "none", sessionId: randomUUID() },
  );
  if (signal.aborted) throw new Error("Compaction cancelled");
  if (response.stopReason === "error")
    throw new Error(response.errorMessage || "Compaction provider failed");
  if (response.stopReason === "length")
    throw new Error("generation hit the token cap and the summary is incomplete");
  if (response.content.some((block) => block.type === "toolCall"))
    throw new Error("Compaction model attempted to call a tool");
  const text = response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("Compaction model returned an empty summary section");
  return { text, usage: response.usage };
}

export async function runSelectedModelCompaction({
  preparation,
  model,
  complete,
  signal,
  customInstructions,
}: SelectedCompactionOptions) {
  const maxTokens = Math.min(
    Math.floor(preparation.settings.reserveTokens * 0.8),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
  const historyInstructions = customInstructions
    ? `${SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`
    : SUMMARY_PROMPT;
  let summary: string;
  let usage: Usage;

  if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
    const history =
      preparation.messagesToSummarize.length > 0 || preparation.previousSummary
        ? await summarize(
            complete,
            model,
            serializeConversation(convertToLlm(preparation.messagesToSummarize)),
            historyInstructions,
            maxTokens,
            signal,
            preparation.previousSummary,
          )
        : undefined;
    const prefix = await summarize(
      complete,
      model,
      serializeConversation(convertToLlm(preparation.turnPrefixMessages)),
      TURN_PREFIX_PROMPT,
      maxTokens,
      signal,
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
      serializeConversation(convertToLlm(preparation.messagesToSummarize)),
      historyInstructions,
      maxTokens,
      signal,
      preparation.previousSummary,
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
