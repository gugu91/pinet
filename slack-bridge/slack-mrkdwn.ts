/**
 * Outbound Slack mrkdwn normalization.
 *
 * Pi agents frequently emit standard Markdown bold (`**bold**`) in their
 * replies. Slack's `chat.postMessage` `text` field is rendered as *mrkdwn*,
 * where bold is a single asterisk (`*bold*`). When a message mixes both
 * conventions, Slack renders the single-asterisk spans correctly but leaks the
 * literal `**` markers for the Markdown-style spans (see issue #848).
 *
 * This module converts Markdown `**bold**` to Slack `*bold*` on the outbound
 * path while leaving already-Slack-formatted text untouched. It deliberately
 * keeps the surface tight:
 *  - Only double-asterisk bold is rewritten. Single `*…*` / `_…_` spans, which
 *    are already valid Slack mrkdwn, are preserved.
 *  - Content inside inline code spans and fenced code blocks is never touched,
 *    so literal `**` shown as code stays literal.
 */

// Matches fenced code blocks (```…```) and inline code spans (`…`). Fenced
// blocks are listed first so they win over inline spans during masking.
const CODE_SEGMENT = /```[\s\S]*?```|`[^`\n]*`/g;

// Matches Markdown-style **bold** spans on a single line. The bold text must
// begin and end with a non-whitespace character so we don't match stray/odd
// markers, spaced-out `** … **`, or collide with already-Slack `*…*` emphasis.
const MARKDOWN_BOLD = /\*\*(?=\S)(.*?\S)\*\*/g;

// Private Use Area sentinels are extremely unlikely to appear in real message
// text and avoid the control characters that `no-control-regex` rejects.
const PLACEHOLDER_PREFIX = "\uE000mrkdwn-code-";
const PLACEHOLDER_SUFFIX = "\uE001";

/**
 * Convert Markdown `**bold**` to Slack `*bold*` while preserving inline code,
 * fenced code blocks, and existing Slack mrkdwn emphasis.
 */
export function convertMarkdownBoldToSlackMrkdwn(text: string): string {
  if (!text.includes("**")) {
    return text;
  }

  const codeSegments: string[] = [];
  const masked = text.replace(CODE_SEGMENT, (match) => {
    const token = `${PLACEHOLDER_PREFIX}${codeSegments.length}${PLACEHOLDER_SUFFIX}`;
    codeSegments.push(match);
    return token;
  });

  const converted = masked.replace(MARKDOWN_BOLD, (_match, inner: string) => `*${inner}*`);

  if (codeSegments.length === 0) {
    return converted;
  }

  return converted.replace(
    /\uE000mrkdwn-code-(\d+)\uE001/g,
    (_match, index: string) => codeSegments[Number(index)] ?? "",
  );
}
