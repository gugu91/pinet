import { describe, expect, it } from "vitest";

import { renderMarkdownForSlackMrkdwn } from "./slack-markdown.js";

describe("renderMarkdownForSlackMrkdwn", () => {
  it("converts Markdown strong emphasis into Slack bold", () => {
    expect(renderMarkdownForSlackMrkdwn("Please review **bold text** now.")).toBe(
      "Please review *bold text* now.",
    );
    expect(renderMarkdownForSlackMrkdwn("**Leading** and **trailing**")).toBe(
      "*Leading* and *trailing*",
    );
  });

  it("preserves existing Slack mrkdwn and literal single-star expressions", () => {
    expect(renderMarkdownForSlackMrkdwn("Already *Slack bold* and 4*3=12.")).toBe(
      "Already *Slack bold* and 4*3=12.",
    );
  });

  it("does not treat globstars as Markdown bold", () => {
    expect(renderMarkdownForSlackMrkdwn("Check src/**/*.ts and packages/**/README.md.")).toBe(
      "Check src/**/*.ts and packages/**/README.md.",
    );
    expect(renderMarkdownForSlackMrkdwn("Copy src/**/foo/**/bar before **announcing**.")).toBe(
      "Copy src/**/foo/**/bar before *announcing*.",
    );
  });

  it("does not convert strong markers inside code spans", () => {
    expect(renderMarkdownForSlackMrkdwn("Use `**literal**` then **announce**.")).toBe(
      "Use `**literal**` then *announce*.",
    );
  });

  it("does not convert strong markers inside fenced code blocks", () => {
    const input = [
      "Before **bold**",
      "```",
      'const pattern = "**literal**";',
      "```",
      "After **bold**",
    ].join("\n");

    const output = [
      "Before *bold*",
      "```",
      'const pattern = "**literal**";',
      "```",
      "After *bold*",
    ].join("\n");

    expect(renderMarkdownForSlackMrkdwn(input)).toBe(output);
  });
});
