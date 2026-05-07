import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CommentRecord } from "./comments.js";
import extension from "./index.js";
import {
  buildPiCommsReadPrompt,
  formatContext,
  parseCommentRpcRequest,
  parseNvimEvent,
  type EditorState,
} from "./helpers.js";

function createState(overrides: Partial<EditorState> = {}): EditorState {
  return {
    file: null,
    line: null,
    visibleStart: null,
    visibleEnd: null,
    selectionStart: null,
    selectionEnd: null,
    ...overrides,
  };
}

function createComment(overrides: Partial<CommentRecord> = {}): CommentRecord {
  return {
    id: "c1",
    threadId: "global",
    actorType: "agent",
    actorId: "pi",
    createdAt: "2024-01-01T00:00:00.000Z",
    bodyPath: "items/c1.md",
    body: "Comment body",
    ...overrides,
  };
}

describe("nvim-bridge extension registration", () => {
  it("registers only the editor bridge surface while PiComms is disabled", () => {
    const tools: string[] = [];
    const commands: string[] = [];
    const events: string[] = [];
    const pi = {
      registerTool: vi.fn((definition: { name: string }) => tools.push(definition.name)),
      registerCommand: vi.fn((name: string) => commands.push(name)),
      on: vi.fn((name: string) => events.push(name)),
    } as unknown as ExtensionAPI;

    extension(pi);

    expect(tools).toEqual(["open_in_editor"]);
    expect(tools).not.toEqual(
      expect.arrayContaining(["comment_add", "comment_list", "comment_wipe_all"]),
    );
    expect(commands).not.toEqual(expect.arrayContaining(["picomms:read", "picomms:clean"]));
    expect(events).toEqual(["session_start", "before_agent_start", "session_shutdown"]);
  });
});

describe("formatContext", () => {
  it("formats the current editor viewport, cursor, and selection", () => {
    expect(
      formatContext(
        createState({
          file: "src/app.ts",
          visibleStart: 10,
          visibleEnd: 20,
          line: 15,
          selectionStart: 16,
          selectionEnd: 18,
        }),
      ),
    ).toBe(
      "User is viewing src/app.ts, lines 10-20 (cursor at line 15), selection on lines 16-18.",
    );
  });

  it("returns an empty string when no file is focused", () => {
    expect(formatContext(createState())).toBe("");
  });
});

describe("parseNvimEvent", () => {
  it("parses valid editor events", () => {
    expect(parseNvimEvent({ type: "buffer_focus", file: "src/app.ts", line: 12 })).toEqual({
      type: "buffer_focus",
      file: "src/app.ts",
      line: 12,
    });
    expect(parseNvimEvent({ type: "selection", file: "src/app.ts", start: 4, end: 8 })).toEqual({
      type: "selection",
      file: "src/app.ts",
      start: 4,
      end: 8,
    });
  });

  it("rejects malformed or unknown events", () => {
    expect(parseNvimEvent({ type: "buffer_focus", file: "src/app.ts", line: 0 })).toBeNull();
    expect(parseNvimEvent({ type: "unknown", file: "src/app.ts" })).toBeNull();
    expect(parseNvimEvent(null)).toBeNull();
  });
});

describe("parseCommentRpcRequest", () => {
  it("parses comment.add requests with optional context", () => {
    expect(
      parseCommentRpcRequest({
        id: "req-1",
        type: "comment.add",
        payload: {
          body: "Please revisit this block",
          threadId: "review-thread",
          actorType: "human",
          actorId: "alice",
          context: {
            file: "src/app.ts",
            startLine: 30,
            endLine: 32,
          },
        },
      }),
    ).toEqual({
      id: "req-1",
      type: "comment.add",
      payload: {
        body: "Please revisit this block",
        threadId: "review-thread",
        actorType: "human",
        actorId: "alice",
        context: {
          file: "src/app.ts",
          startLine: 30,
          endLine: 32,
        },
      },
    });
  });

  it("parses list requests and rejects invalid payloads", () => {
    expect(
      parseCommentRpcRequest({
        id: "req-2",
        type: "comment.list",
        payload: { threadId: "thread-1", limit: 5 },
      }),
    ).toEqual({
      id: "req-2",
      type: "comment.list",
      payload: { threadId: "thread-1", limit: 5 },
    });
    expect(parseCommentRpcRequest({ id: "", type: "comment.list", payload: {} })).toBeNull();
    expect(parseCommentRpcRequest({ id: "req-3", type: "comment.add", payload: {} })).toBeNull();
  });
});

describe("buildPiCommsReadPrompt", () => {
  it("prioritizes comments matching the current editor context", () => {
    const state = createState({
      file: "src/app.ts",
      line: 15,
    });
    const comments = [
      createComment({
        id: "other",
        bodyPath: "items/other.md",
        body: "General repo note",
        createdAt: "2024-01-01T00:00:00.000Z",
      }),
      createComment({
        id: "relevant",
        threadId: "ctx:src/app.ts:15-15",
        bodyPath: "items/relevant.md",
        body: "Relevant line-specific guidance",
        createdAt: "2024-01-02T00:00:00.000Z",
        context: {
          file: "src/app.ts",
          startLine: 15,
          endLine: 15,
        },
      }),
    ];

    const result = buildPiCommsReadPrompt(state, comments, comments.length, 5000);

    expect(result.included).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.prompt).toContain("Most relevant PiComms:");
    expect(result.prompt.indexOf("Relevant line-specific guidance")).toBeLessThan(
      result.prompt.indexOf("General repo note"),
    );
  });

  it("marks the prompt as truncated when not all comments fit", () => {
    const state = createState({ file: "src/app.ts", line: 10 });
    const comments = [
      createComment({
        id: "c1",
        bodyPath: "items/c1.md",
        threadId: "ctx:src/app.ts:10-10",
        body: "This is the highest priority comment and it is deliberately long to consume space.",
        context: { file: "src/app.ts", startLine: 10, endLine: 10 },
      }),
      createComment({
        id: "c2",
        bodyPath: "items/c2.md",
        body: "Secondary note that should fall off once the prompt budget is exhausted.",
      }),
      createComment({
        id: "c3",
        bodyPath: "items/c3.md",
        body: "Tertiary note that should also be omitted.",
      }),
    ];

    const result = buildPiCommsReadPrompt(state, comments, comments.length, 180);

    expect(result.truncated).toBe(true);
    expect(result.included).toBeLessThan(comments.length);
    expect(result.prompt).toContain("Some comments were omitted due to prompt size limits.");
  });
});
