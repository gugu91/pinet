import { describe, expect, it } from "vitest";
import {
  buildSlackThreadExport,
  convertSlackMrkdwnToMarkdown,
  filterSlackExportMessagesByRange,
  normalizeSlackExportFormat,
  parseSlackExportBoundaryTs,
} from "./slack-export.js";

describe("normalizeSlackExportFormat", () => {
  it("defaults to markdown", () => {
    expect(normalizeSlackExportFormat()).toBe("markdown");
  });

  it("accepts markdown, plain, and json", () => {
    expect(normalizeSlackExportFormat("markdown")).toBe("markdown");
    expect(normalizeSlackExportFormat("plain")).toBe("plain");
    expect(normalizeSlackExportFormat("json")).toBe("json");
  });

  it("rejects unsupported formats", () => {
    expect(() => normalizeSlackExportFormat("html")).toThrow(
      "format must be 'markdown', 'json', or 'plain'.",
    );
  });
});

describe("parseSlackExportBoundaryTs", () => {
  it("parses Slack ts values", () => {
    expect(parseSlackExportBoundaryTs("1712345678.123456")).toBe(1712345678.123456);
  });

  it("parses ISO timestamps", () => {
    expect(parseSlackExportBoundaryTs("2026-04-02T14:30:00Z")).toBe(1775140200);
  });
});

describe("filterSlackExportMessagesByRange", () => {
  it("keeps only messages inside the requested range", () => {
    const messages = [
      { ts: "100.000001", text: "too early" },
      { ts: "200.000002", text: "keep me" },
      { ts: "300.000003", text: "too late" },
    ];

    expect(filterSlackExportMessagesByRange(messages, 150, 250)).toEqual([
      { ts: "200.000002", text: "keep me" },
    ]);
  });
});

describe("convertSlackMrkdwnToMarkdown", () => {
  it("converts Slack links, mentions, and formatting", () => {
    const result = convertSlackMrkdwnToMarkdown(
      "Hello <@U123> see <https://example.com|the docs> and *important* ~old~ <!here>",
      { U123: "alice" },
    );

    expect(result).toBe(
      "Hello @alice see [the docs](https://example.com) and **important** ~~old~~ @here",
    );
  });
});

describe("buildSlackThreadExport", () => {
  const messages = [
    {
      ts: "1712345678.000001",
      authorName: "alice",
      text: "Hello <@U456>\n\nSee <https://example.com|design doc>",
      files: [
        {
          id: "F123",
          title: "incident.md",
          filetype: "markdown",
          permalink: "https://files.example/incident.md",
          preview: "Root cause analysis",
        },
      ],
    },
    {
      ts: "1712345688.000002",
      authorName: "bob",
      text: "*Ship it*",
    },
  ];

  it("renders markdown exports with metadata and attachments", () => {
    const result = buildSlackThreadExport({
      format: "markdown",
      includeMetadata: true,
      threadTs: "1712345678.000001",
      channelId: "C123",
      channelLabel: "#eng",
      messages,
      mentionNames: { U456: "bob" },
    });

    expect(result).toContain("# Slack Thread Export");
    expect(result).toContain("- Thread: `1712345678.000001`");
    expect(result).toContain("- Participants: alice, bob");
    expect(result).toContain("## 2024-04-05T19:34:38.000Z — alice");
    expect(result).toContain("Hello @bob");
    expect(result).toContain("[design doc](https://example.com)");
    expect(result).toContain("Attachments:");
    expect(result).toContain("incident.md (markdown) id=F123 — https://files.example/incident.md");
    expect(result).toContain("Preview: Root cause analysis");
    expect(result).toContain("**Ship it**");
  });

  it("renders plain exports without message metadata when disabled", () => {
    const result = buildSlackThreadExport({
      format: "plain",
      includeMetadata: false,
      threadTs: "1712345678.000001",
      channelId: "C123",
      messages,
      mentionNames: { U456: "bob" },
    });

    expect(result).not.toContain("[2024-");
    expect(result).toContain("Hello @bob");
    expect(result).toContain("Attachments:");
  });

  it("renders JSON exports", () => {
    const result = buildSlackThreadExport({
      format: "json",
      includeMetadata: true,
      threadTs: "1712345678.000001",
      channelId: "C123",
      messages,
      mentionNames: { U456: "bob" },
    });

    const parsed = JSON.parse(result) as {
      format: string;
      messages: Array<{
        author: string;
        text: string;
        files: Array<{ id?: string; url_private?: string }>;
      }>;
    };

    expect(parsed.format).toBe("json");
    expect(parsed.messages[0]?.author).toBe("alice");
    expect(parsed.messages[0]?.text).toContain("Hello @bob");
    expect(parsed.messages[0]?.files[0]?.id).toBe("F123");
    expect(parsed.messages[0]?.files[0]).not.toHaveProperty("url_private");
  });
});
