import { describe, expect, it, vi } from "vitest";
import {
  buildPinetDeliveryCardDetails,
  PINET_DELIVERY_CUSTOM_TYPE,
  registerPinetDeliveryMessageRenderer,
  renderPinetDeliveryMessage,
  sendPinetDeliveryMessage,
  type PinetDeliveryApi,
} from "./pinet-delivery-card.js";

const body = [
  "New Pinet messages:",
  "[thread a2a:broker:worker] [steering] Broker: inbox_id=42 pointer=pinet action=read args.thread_id=a2a:broker:worker args.unread_only=true",
  "",
  "Read pointer(s) before acting; reply via pinet action=send.",
].join("\n");

function renderText(component: { render(width: number): string[] }): string {
  return component.render(300).join("\n");
}

describe("Pinet delivery cards", () => {
  it("builds compact delivery card details from the full prompt body", () => {
    expect(buildPinetDeliveryCardDetails(body)).toEqual({
      title: "New Pinet messages:",
      summary:
        "[thread a2a:broker:worker] [steering] Broker: inbox_id=42 pointer=pinet action=read args.thread_id=a2a:broker:worker args.unread_only=true",
      lineCount: 4,
      characterCount: body.length,
    });
  });

  it("renders collapsed cards by default with an expand hint and without the full body", () => {
    const rendered = renderText(
      renderPinetDeliveryMessage(
        { content: body, details: buildPinetDeliveryCardDetails(body) },
        { expanded: false },
      ),
    );

    expect(rendered).toContain("[Slack Bridge] New Pinet messages:");
    expect(rendered).toContain("Ctrl+O to expand full delivery prompt");
    expect(rendered).toContain("[thread a2a:broker:worker] [steering] Broker:");
    expect(rendered).not.toContain("Read pointer(s) before acting");
  });

  it("renders the exact full prompt body when expanded", () => {
    const rendered = renderText(renderPinetDeliveryMessage({ content: body }, { expanded: true }));

    expect(rendered).toContain(body);
  });

  it("registers the custom renderer under the Slack Bridge Pinet delivery type", () => {
    const registerMessageRenderer = vi.fn();

    registerPinetDeliveryMessageRenderer({ registerMessageRenderer });

    expect(registerMessageRenderer).toHaveBeenCalledWith(
      PINET_DELIVERY_CUSTOM_TYPE,
      renderPinetDeliveryMessage,
    );
  });

  it("delivers full model-visible content through a displayed custom message", () => {
    const sendMessage = vi.fn();
    const sendUserMessage = vi.fn();
    const pi: PinetDeliveryApi = { sendMessage, sendUserMessage };

    sendPinetDeliveryMessage(pi, body);

    expect(sendMessage).toHaveBeenCalledWith(
      {
        customType: PINET_DELIVERY_CUSTOM_TYPE,
        content: body,
        display: true,
        details: buildPinetDeliveryCardDetails(body),
      },
      { triggerTurn: true },
    );
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("falls back to user-message delivery when custom messages are unavailable", () => {
    const sendUserMessage = vi.fn();
    const pi: PinetDeliveryApi = { sendUserMessage };

    sendPinetDeliveryMessage(pi, body);

    expect(sendUserMessage).toHaveBeenCalledWith(body);
  });
});
