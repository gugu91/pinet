import {
  buildSessionContext,
  findCutPoint,
  type CompactionPreparation,
  type CompactionSettings,
  type FileOperations,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { extractFileListDetails } from "./helpers.js";

export function buildPreparationFromBranch(
  branchEntries: SessionEntry[],
  settings: CompactionSettings,
  tokensBefore: number = 0,
): CompactionPreparation | undefined {
  if (branchEntries.length === 0) return undefined;
  if (branchEntries[branchEntries.length - 1]?.type === "compaction") return undefined;

  const prevCompactionIndex = findPreviousCompactionIndex(branchEntries);
  const previousCompaction =
    prevCompactionIndex >= 0 ? branchEntries[prevCompactionIndex] : undefined;
  const previousSummary =
    previousCompaction?.type === "compaction"
      ? getStringProperty(previousCompaction, "summary")
      : undefined;
  let boundaryStart = 0;

  if (previousCompaction?.type === "compaction") {
    const firstKeptEntryId = getStringProperty(previousCompaction, "firstKeptEntryId");
    const firstKeptEntryIndex = firstKeptEntryId
      ? branchEntries.findIndex((entry) => entry.id === firstKeptEntryId)
      : -1;
    boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
  }

  const cutPoint = findCutPoint(
    branchEntries,
    boundaryStart,
    branchEntries.length,
    settings.keepRecentTokens,
  );
  const firstKeptEntry = branchEntries[cutPoint.firstKeptEntryIndex];
  const firstKeptEntryId = typeof firstKeptEntry?.id === "string" ? firstKeptEntry.id : undefined;
  if (!firstKeptEntryId) return undefined;

  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
  if (historyEnd < boundaryStart) return undefined;

  const messagesToSummarize = collectMessagesFromRange(branchEntries, boundaryStart, historyEnd);
  const turnPrefixMessages = cutPoint.isSplitTurn
    ? collectMessagesFromRange(branchEntries, cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex)
    : [];

  return {
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cutPoint.isSplitTurn,
    tokensBefore,
    previousSummary,
    fileOps: buildFileOperations(
      messagesToSummarize,
      turnPrefixMessages,
      branchEntries,
      prevCompactionIndex,
    ),
    settings,
  };
}

function findPreviousCompactionIndex(entries: SessionEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "compaction") return index;
  }
  return -1;
}

function collectMessagesFromRange(
  entries: SessionEntry[],
  start: number,
  end: number,
): CompactionPreparation["messagesToSummarize"] {
  if (start < 0 || end <= start) return [];
  return buildSessionContext(entries.slice(start, end)).messages;
}

function buildFileOperations(
  messagesToSummarize: CompactionPreparation["messagesToSummarize"],
  turnPrefixMessages: CompactionPreparation["turnPrefixMessages"],
  entries: SessionEntry[],
  prevCompactionIndex: number,
): FileOperations {
  const fileOps: FileOperations = {
    read: new Set<string>(),
    written: new Set<string>(),
    edited: new Set<string>(),
  };

  if (prevCompactionIndex >= 0) {
    const previousCompaction = entries[prevCompactionIndex];
    const details =
      previousCompaction?.type === "compaction"
        ? getRecordProperty(previousCompaction, "details")
        : undefined;
    const fileLists = extractFileListDetails(details);
    for (const path of fileLists.readFiles) fileOps.read.add(path);
    for (const path of fileLists.modifiedFiles) fileOps.edited.add(path);
  }

  for (const message of messagesToSummarize) extractFileOpsFromMessage(message, fileOps);
  for (const message of turnPrefixMessages) extractFileOpsFromMessage(message, fileOps);

  return fileOps;
}

function extractFileOpsFromMessage(message: unknown, fileOps: FileOperations): void {
  if (!message || typeof message !== "object") return;
  const role = "role" in message ? message.role : undefined;
  if (role !== "assistant") return;
  const content = "content" in message ? message.content : undefined;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const type = "type" in block ? block.type : undefined;
    if (type !== "toolCall") continue;
    const args = "arguments" in block ? block.arguments : undefined;
    if (!args || typeof args !== "object") continue;
    const path = "path" in args && typeof args.path === "string" ? args.path : undefined;
    if (!path) continue;
    const name = "name" in block ? block.name : undefined;
    if (name === "read") fileOps.read.add(path);
    if (name === "write") fileOps.written.add(path);
    if (name === "edit") fileOps.edited.add(path);
  }
}

function getStringProperty(value: SessionEntry, key: string): string | undefined {
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" ? raw : undefined;
}

function getRecordProperty(value: SessionEntry, key: string): Record<string, unknown> | undefined {
  const raw = (value as Record<string, unknown>)[key];
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}
