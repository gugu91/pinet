declare module "@earendil-works/pi-coding-agent" {
  export interface TruncationResult {
    content: string;
    truncated: boolean;
    outputLines: number;
    totalLines: number;
    outputBytes: number;
    totalBytes: number;
  }

  export const DEFAULT_MAX_BYTES: number;
  export const DEFAULT_MAX_LINES: number;

  export function formatSize(bytes: number): string;
  export function getAgentDir(): string;
  export function truncateHead(
    text: string,
    options: { maxLines: number; maxBytes: number },
  ): TruncationResult;

  export interface ExtensionUI {
    theme: any;
    notify(message: string, level?: string): void;
    setStatus(id: string, value?: any): void;
  }

  export interface SessionEntry {
    type: string;
    customType?: string;
    data?: unknown;
    [k: string]: unknown;
  }

  export interface SessionManager {
    getEntries(): SessionEntry[];
    getBranch(): SessionEntry[];
    getLeafId(): string | undefined;
    getSessionId?(): string | undefined;
    getSessionFile(): string | undefined;
  }

  export interface ModelRegistry {
    find(provider: string, id: string): any | undefined;
    getApiKeyAndHeaders(model: any): Promise<{
      ok: boolean;
      apiKey?: string;
      headers?: Record<string, string>;
      error?: string;
    }>;
  }

  export interface ContextUsage {
    tokens: number;
    contextWindow?: number;
  }

  export interface CompactOptions {
    customInstructions?: string;
    onComplete?: (result: CompactionResult) => void;
    onError?: (error: Error) => void;
  }

  export interface ExtensionContext {
    cwd: string;
    hasUI?: boolean;
    isIdle?: () => boolean;
    ui: ExtensionUI;
    sessionManager: SessionManager;
    model?: { provider?: string; id?: string; contextWindow?: number };
    modelRegistry: ModelRegistry;
    getContextUsage(): ContextUsage | undefined;
    compact(options?: CompactOptions): void;
  }

  export interface ToolUpdate {
    content?: Array<{ type: string; text?: string }>;
    details?: any;
  }

  export interface ToolDefinition {
    name: string;
    label?: string;
    description?: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters?: unknown;
    execute?: (
      toolCallId: string,
      params: any,
      signal?: AbortSignal,
      onUpdate?: (update: ToolUpdate) => void,
      ctx: ExtensionContext,
    ) => Promise<any> | any;
    renderCall?: (args: any, theme: any) => any;
    renderResult?: (result: any, options: any, theme: any) => any;
  }

  export interface CommandDefinition {
    description?: string;
    handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
  }

  export interface CompactionSettings {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
  }

  export interface FileOperations {
    read: Set<string>;
    written: Set<string>;
    edited: Set<string>;
  }

  export interface CompactionPreparation {
    firstKeptEntryId: string;
    messagesToSummarize: any[];
    turnPrefixMessages: any[];
    isSplitTurn: boolean;
    tokensBefore: number;
    previousSummary?: string;
    fileOps: FileOperations;
    settings: CompactionSettings;
  }

  export interface CompactionResult<T = unknown> {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: T;
  }

  export interface SessionBeforeCompactEvent {
    type: "session_before_compact";
    preparation: CompactionPreparation;
    branchEntries: SessionEntry[];
    customInstructions?: string;
    signal: AbortSignal;
  }

  export interface SessionContext {
    messages: any[];
    thinkingLevel?: string;
    model?: { provider: string; modelId: string } | null;
  }

  export interface CutPointResult {
    firstKeptEntryIndex: number;
    turnStartIndex: number;
    isSplitTurn: boolean;
  }

  export function buildSessionContext(
    entries: SessionEntry[],
    leafId?: string | null,
  ): SessionContext;

  export function findCutPoint(
    entries: SessionEntry[],
    startIndex: number,
    endIndex: number,
    keepRecentTokens: number,
  ): CutPointResult;

  export function compact(
    preparation: CompactionPreparation,
    model: any,
    apiKey: string,
    headers?: Record<string, string>,
    customInstructions?: string,
    signal?: AbortSignal,
    thinkingLevel?: any,
  ): Promise<CompactionResult>;

  export interface ExtensionAPI {
    on(event: string, handler: (event: any, ctx: ExtensionContext) => any): void;
    registerTool(definition: ToolDefinition): void;
    registerCommand(name: string, options: CommandDefinition): void;
    registerMessageRenderer(
      name: string,
      renderer: (message: any, options: any, theme: any) => any,
    ): void;
    sendUserMessage(
      content: string | Array<Record<string, unknown>>,
      options?: { deliverAs?: string },
    ): void;
    sendMessage(message: any): void;
    appendEntry(customType: string, data?: unknown): void;
  }
}
