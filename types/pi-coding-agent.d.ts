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

  export interface Theme {
    fg(color: string, text: string): string;
    bold(text: string): string;
  }

  export interface ExtensionUI {
    theme: any;
    notify(message: string, level?: string): void;
    setStatus(id: string, value?: any): void;
    select(title: string, options: string[]): Promise<string | undefined>;
    custom<T>(
      factory: (
        tui: { requestRender(): void },
        theme: Theme,
        keybindings: object,
        done: (value: T) => void,
      ) => import("@earendil-works/pi-tui").Component,
      options?: {
        overlay?: boolean;
        overlayOptions?: {
          anchor?: string;
          width?: number | `${number}%`;
          minWidth?: number;
          maxHeight?: number | `${number}%`;
          margin?: number;
        };
      },
    ): Promise<T>;
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
    getSessionFile(): string | undefined;
  }

  export interface RegistryModel {
    provider: string;
    id: string;
    name?: string;
    reasoning?: boolean;
    thinkingLevelMap?: Partial<
      Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>
    >;
    contextWindow: number;
    maxTokens: number;
  }

  export type ResolvedRequestAuth =
    | {
        ok: true;
        apiKey?: string;
        headers?: import("@earendil-works/pi-ai/compat").ProviderHeaders;
        baseUrl?: string;
        env?: Record<string, string>;
      }
    | {
        ok: false;
        error: string;
      };

  export interface ModelsRefreshResult {
    aborted: boolean;
    errors: ReadonlyMap<string, Error>;
  }

  /** Catalog-reading slice of Pi's ModelRuntime (see dist/core/model-runtime.d.ts). */
  export interface ModelRuntime {
    getModel(providerId: string, modelId: string): RegistryModel | undefined;
    getAvailableSnapshot(): readonly RegistryModel[];
    getError(): string | undefined;
    refresh(options?: { signal?: AbortSignal }): Promise<ModelsRefreshResult>;
  }
  export function initTheme(themeName?: string, enableWatcher?: boolean): void;
  export const ModelRuntime: {
    create(options?: {
      refreshOnCreate?: boolean;
      modelsPath?: string | null;
    }): Promise<ModelRuntime>;
  };

  export interface ModelRegistry {
    find(provider: string, modelId: string): RegistryModel | undefined;
    getAvailable(): RegistryModel[];
    getError(): string | undefined;
    refresh(options?: { signal?: AbortSignal }): Promise<ModelsRefreshResult>;
    getApiKeyAndHeaders(model: RegistryModel): Promise<ResolvedRequestAuth>;
    registerProvider(provider: import("@earendil-works/pi-ai/compat").Provider): void;
    complete<TApi extends import("@earendil-works/pi-ai/compat").Api>(
      model: import("@earendil-works/pi-ai/compat").Model<TApi>,
      context: import("@earendil-works/pi-ai/compat").Context,
      options?: import("@earendil-works/pi-ai/compat").ApiStreamOptions<TApi>,
    ): Promise<import("@earendil-works/pi-ai/compat").AssistantMessage>;
  }
  export const ModelRegistry: {
    new (runtime: ModelRuntime): ModelRegistry;
  };

  export interface AgentMessage {
    role: string;
  }

  export interface CompactionPreparation {
    firstKeptEntryId: string;
    messagesToSummarize: AgentMessage[];
    turnPrefixMessages: AgentMessage[];
    isSplitTurn: boolean;
    tokensBefore: number;
    previousSummary?: string;
    fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> };
    settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  }

  export interface SessionBeforeCompactEvent {
    preparation: CompactionPreparation;
    branchEntries: SessionEntry[];
    customInstructions?: string;
    reason: "manual" | "threshold" | "overflow";
    willRetry: boolean;
    signal: AbortSignal;
  }

  export function convertToLlm(messages: AgentMessage[]): AgentMessage[];
  export function serializeConversation(messages: AgentMessage[]): string;
  export function compact(
    preparation: CompactionPreparation,
    model: RegistryModel,
    apiKey?: string,
    headers?: Record<string, string>,
    customInstructions?: string,
    signal?: AbortSignal,
    thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
    streamFn?: undefined,
    env?: Record<string, string>,
  ): Promise<{
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    usage?: object;
    details?: object;
  }>;

  export interface ScopedModel {
    model: RegistryModel;
    thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  }

  /** Pi's /model picker (dist/modes/interactive/components/model-selector.d.ts). */
  export class ModelSelectorComponent implements import("@earendil-works/pi-tui").Component {
    constructor(
      tui: { requestRender(): void },
      currentModel: RegistryModel | undefined,
      modelRuntime: ModelRuntime,
      scopedModels: ReadonlyArray<ScopedModel>,
      onSelect: (model: RegistryModel) => void,
      onCancel: () => void,
      initialSearchInput?: string,
      onSelectAsDefault?: (model: RegistryModel) => void,
      defaultModel?: { provider: string; id: string },
    );
    render(width: number): string[];
    handleInput(data: string): void;
    invalidate(): void;
    dispose(): void;
  }

  export type ExtensionMode = "tui" | "rpc" | "json" | "print";

  export interface ExtensionContext {
    cwd: string;
    /** Run mode; only "tui" supports ui.custom components. */
    mode?: ExtensionMode;
    hasUI?: boolean;
    isIdle?: () => boolean;
    ui: ExtensionUI;
    sessionManager: SessionManager;
    model?: { provider?: string; id?: string };
    scopedModels?: readonly ScopedModel[];
    getContextUsage?: () =>
      | { tokens: number | null; contextWindow: number; percent: number | null }
      | undefined;
    compact?: (options?: {
      customInstructions?: string;
      onComplete?: (result?: unknown) => void;
      onError?: (error: Error) => void;
    }) => void;
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

  export interface ExtensionCommandContext extends ExtensionContext {}

  export interface CommandDefinition {
    description?: string;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
  }

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
    getActiveTools(): string[];
    setActiveTools(toolNames: string[]): void;
  }
}
