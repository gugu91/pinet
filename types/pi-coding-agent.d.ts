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
    getSessionFile(): string | undefined;
  }

  export interface ExtensionContext {
    cwd: string;
    hasUI?: boolean;
    isIdle?: () => boolean;
    ui: ExtensionUI;
    sessionManager: SessionManager;
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
