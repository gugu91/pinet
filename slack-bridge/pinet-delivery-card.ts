import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const PINET_DELIVERY_CUSTOM_TYPE = "slack-bridge:pinet-delivery";

const DEFAULT_SUMMARY = "Slack Bridge delivery";
const COLLAPSED_PREVIEW_MAX_LENGTH = 180;

export interface PinetDeliveryCardDetails {
  title: string;
  summary: string;
  lineCount: number;
  characterCount: number;
}

interface PinetDeliveryMessageContentBlock {
  type: string;
  text?: string;
}

interface PinetDeliveryCustomMessage {
  content: string | PinetDeliveryMessageContentBlock[];
  details?: unknown;
}

interface PinetDeliveryRenderOptions {
  expanded?: boolean;
}

interface PinetDeliveryComponent {
  render(width: number): string[];
  invalidate(): void;
}

export interface PinetDeliveryApi {
  sendMessage?: (
    message: {
      customType: string;
      content: string;
      display: boolean;
      details: PinetDeliveryCardDetails;
    },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ) => void;
  sendUserMessage: ExtensionAPI["sendUserMessage"];
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength = COLLAPSED_PREVIEW_MAX_LENGTH): string {
  const collapsed = collapseWhitespace(value);
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxLength - 1))}…`;
}

function getDeliveryTitle(body: string): string {
  const firstLine = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ?? DEFAULT_SUMMARY;
}

function getDeliverySummary(body: string): string {
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const firstMessageLine =
    lines.find((line) => line.startsWith("[thread ")) ?? lines[1] ?? lines[0];
  return truncateText(firstMessageLine ?? DEFAULT_SUMMARY);
}

export function buildPinetDeliveryCardDetails(body: string): PinetDeliveryCardDetails {
  return {
    title: getDeliveryTitle(body),
    summary: getDeliverySummary(body),
    lineCount: body.length === 0 ? 0 : body.split("\n").length,
    characterCount: body.length,
  };
}

function readTextContent(message: PinetDeliveryCustomMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n");
}

function readDetails(message: PinetDeliveryCustomMessage): PinetDeliveryCardDetails | null {
  if (typeof message.details !== "object" || message.details === null) return null;
  const details = message.details;
  if (!("title" in details) || !("summary" in details)) return null;
  const title = details.title;
  const summary = details.summary;
  if (typeof title !== "string" || typeof summary !== "string") return null;
  return {
    title,
    summary,
    lineCount:
      "lineCount" in details && typeof details.lineCount === "number" ? details.lineCount : 0,
    characterCount:
      "characterCount" in details && typeof details.characterCount === "number"
        ? details.characterCount
        : 0,
  };
}

function truncateLineToWidth(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width === 1) return "…";
  return `${value.slice(0, width - 1)}…`;
}

class PinetDeliveryCardComponent implements PinetDeliveryComponent {
  constructor(private readonly text: string) {}

  render(width: number): string[] {
    return this.text.split("\n").map((line) => truncateLineToWidth(line, width));
  }

  invalidate(): void {
    // Stateless component.
  }
}

export function renderPinetDeliveryMessage(
  message: PinetDeliveryCustomMessage,
  options: PinetDeliveryRenderOptions,
): PinetDeliveryComponent {
  const body = readTextContent(message);
  const details = readDetails(message) ?? buildPinetDeliveryCardDetails(body);
  const heading = `[Slack Bridge] ${details.title}`;

  if (options.expanded) {
    return new PinetDeliveryCardComponent(`${heading}\n\n${body}`);
  }

  const stats =
    details.lineCount > 1 || details.characterCount > COLLAPSED_PREVIEW_MAX_LENGTH
      ? ` (${details.lineCount} lines, ${details.characterCount} chars)`
      : "";
  const summary = details.summary;
  return new PinetDeliveryCardComponent(
    `${heading}${stats}\n${summary}\nCtrl+O to expand full delivery prompt`,
  );
}

export function registerPinetDeliveryMessageRenderer(
  pi: Pick<ExtensionAPI, "registerMessageRenderer">,
): void {
  if (typeof pi.registerMessageRenderer !== "function") return;
  pi.registerMessageRenderer(PINET_DELIVERY_CUSTOM_TYPE, renderPinetDeliveryMessage);
}

export function sendPinetDeliveryMessage(pi: PinetDeliveryApi, body: string): void {
  if (typeof pi.sendMessage === "function") {
    pi.sendMessage(
      {
        customType: PINET_DELIVERY_CUSTOM_TYPE,
        content: body,
        display: true,
        details: buildPinetDeliveryCardDetails(body),
      },
      { triggerTurn: true },
    );
    return;
  }

  pi.sendUserMessage(body);
}
