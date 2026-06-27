import { describe, expect, it } from "vitest";

import { convertMarkdownBoldToSlackMrkdwn } from "./slack-mrkdwn.js";

describe("convertMarkdownBoldToSlackMrkdwn", () => {
  it("converts Markdown **bold** to Slack *bold*", () => {
    expect(convertMarkdownBoldToSlackMrkdwn("**bold**")).toBe("*bold*");
    expect(convertMarkdownBoldToSlackMrkdwn("a **bold** word")).toBe("a *bold* word");
  });

  it("handles the mixed-rendering case from issue #848", () => {
    // Slack `*already*` should survive; Markdown `**leaky**` should be converted.
    const input = "Status: *done* and **also done** plus **one more**";
    expect(convertMarkdownBoldToSlackMrkdwn(input)).toBe(
      "Status: *done* and *also done* plus *one more*",
    );
  });

  it("converts multiple bold spans on one line without merging them", () => {
    expect(convertMarkdownBoldToSlackMrkdwn("**a** and **b**")).toBe("*a* and *b*");
  });

  it("leaves existing Slack mrkdwn single-asterisk bold untouched", () => {
    expect(convertMarkdownBoldToSlackMrkdwn("*already slack*")).toBe("*already slack*");
  });

  it("leaves Slack italic (_text_) untouched", () => {
    expect(convertMarkdownBoldToSlackMrkdwn("_italic_ and **bold**")).toBe("_italic_ and *bold*");
  });

  it("does not touch ** inside an inline code span", () => {
    expect(convertMarkdownBoldToSlackMrkdwn("use `a**b` literally")).toBe("use `a**b` literally");
    expect(convertMarkdownBoldToSlackMrkdwn("`**not bold**` but **bold**")).toBe(
      "`**not bold**` but *bold*",
    );
  });

  it("does not touch ** inside a fenced code block", () => {
    const input = "```\nx = a ** b\n```\nthen **bold**";
    expect(convertMarkdownBoldToSlackMrkdwn(input)).toBe("```\nx = a ** b\n```\nthen *bold*");
  });

  it("preserves Slack-style links", () => {
    expect(convertMarkdownBoldToSlackMrkdwn("see <https://x.test|the **docs**>")).toBe(
      "see <https://x.test|the *docs*>",
    );
  });

  it("does not mangle Markdown links (no bold present)", () => {
    expect(convertMarkdownBoldToSlackMrkdwn("[text](https://x.test)")).toBe(
      "[text](https://x.test)",
    );
  });

  it("leaves bullet lists intact while converting bold inside them", () => {
    const input = "- **first**\n- second\n- *third*";
    expect(convertMarkdownBoldToSlackMrkdwn(input)).toBe("- *first*\n- second\n- *third*");
  });

  it("leaves stray/unbalanced ** untouched", () => {
    expect(convertMarkdownBoldToSlackMrkdwn("just ** two stars")).toBe("just ** two stars");
  });

  it("does not convert spaced-out ** markers (not valid bold)", () => {
    expect(convertMarkdownBoldToSlackMrkdwn("** not bold **")).toBe("** not bold **");
  });

  it("returns the input unchanged when there is no double asterisk", () => {
    expect(convertMarkdownBoldToSlackMrkdwn("plain text")).toBe("plain text");
  });

  it("handles bold spanning multiple words and punctuation", () => {
    expect(convertMarkdownBoldToSlackMrkdwn("**Root cause:** found it")).toBe(
      "*Root cause:* found it",
    );
  });
});
