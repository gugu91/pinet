import { describe, expect, it } from "vitest";
import {
  buildSlackInboundMessageText,
  extractSlackMessageContextLines,
  extractSlackMessageFileMetadata,
} from "./slack-message-context.js";

describe("slack message context extraction", () => {
  it("returns the original text when there is no extra visible context", () => {
    expect(buildSlackInboundMessageText("hello", { text: "hello" })).toBe("hello");
  });

  it("appends compact canvas-style context from message blocks and attachments", () => {
    const evt = {
      text: "Alice mentioned you in a comment",
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_quote",
              elements: [{ type: "text", text: "Can you update the rollout checklist?" }],
            },
          ],
        },
        {
          type: "context",
          elements: [{ type: "plain_text", text: "Canvas: Launch plan > Rollout" }],
        },
      ],
      attachments: [
        {
          title: "Launch plan",
          text: "Section: Rollout",
        },
      ],
    } satisfies Record<string, unknown>;

    expect(buildSlackInboundMessageText("Alice mentioned you in a comment", evt)).toBe(
      [
        "Alice mentioned you in a comment",
        "",
        "Slack message context:",
        "- Can you update the rollout checklist?",
        "- Canvas: Launch plan > Rollout",
        "- Launch plan",
        "- Section: Rollout",
      ].join("\n"),
    );
  });

  it("can build useful text when Slack sends only rich blocks without plain text", () => {
    const evt = {
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Canvas comment mention" },
        },
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "Please tighten the acceptance criteria." }],
            },
          ],
        },
      ],
    } satisfies Record<string, unknown>;

    expect(buildSlackInboundMessageText("", evt)).toBe(
      [
        "(Slack message had no plain-text body)",
        "",
        "Slack message context:",
        "- Canvas comment mention",
        "- Please tighten the acceptance criteria.",
      ].join("\n"),
    );
  });

  it("keeps richer context when it only contains a short base-text word", () => {
    const evt = {
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Please review the rollout checklist" },
        },
      ],
    } satisfies Record<string, unknown>;

    expect(extractSlackMessageContextLines(evt, "review")).toEqual([
      "Please review the rollout checklist",
    ]);
  });

  it("extracts fetchable Slack file metadata for later follow-up", () => {
    const files = [
      {
        id: "F123",
        name: "incident.md",
        title: "Incident notes",
        mimetype: "text/markdown",
        filetype: "markdown",
        pretty_type: "Markdown",
        permalink: "https://files.example/incident.md",
        url_private_download: "https://files.example/download/F123",
        mode: "snippet",
        size: 128,
      },
    ] satisfies unknown[];

    expect(extractSlackMessageFileMetadata(files)).toEqual([
      {
        id: "F123",
        name: "incident.md",
        title: "Incident notes",
        mimetype: "text/markdown",
        filetype: "markdown",
        prettyType: "Markdown",
        permalink: "https://files.example/incident.md",
        mode: "snippet",
        size: 128,
      },
    ]);
  });

  it("keeps file-share context lines fetchable instead of title-only", () => {
    const evt = {
      files: [
        {
          id: "F123",
          title: "Incident notes",
          filetype: "markdown",
          mode: "snippet",
          permalink: "https://files.example/incident.md",
        },
      ],
    } satisfies Record<string, unknown>;

    expect(extractSlackMessageContextLines(evt, "")).toEqual([
      "Incident notes — markdown — snippet — id=F123 — https://files.example/incident.md",
    ]);
  });

  it("dedupes repeated context lines and limits the attached snippet count", () => {
    const evt = {
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "hello" } },
        { type: "context", elements: [{ type: "plain_text", text: "alpha" }] },
        { type: "context", elements: [{ type: "plain_text", text: "beta" }] },
        { type: "context", elements: [{ type: "plain_text", text: "gamma" }] },
        { type: "context", elements: [{ type: "plain_text", text: "delta" }] },
        { type: "context", elements: [{ type: "plain_text", text: "epsilon" }] },
      ],
    } satisfies Record<string, unknown>;

    expect(extractSlackMessageContextLines(evt, "hello")).toEqual([
      "alpha",
      "beta",
      "gamma",
      "delta",
    ]);
  });
});
