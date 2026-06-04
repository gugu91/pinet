import type {
  InboundMessage as IMessageAdapterInboundMessage,
  MessageAdapter,
  OutboundMessage as IMessageAdapterOutboundMessage,
} from "@pinet/transport-core";
import { assertIMessageSendCapability, sendIMessage, type RunAppleScript } from "./send.js";
import {
  formatIMessageMvpReadiness,
  type DetectIMessageMvpEnvironmentOptions,
  type IMessageMvpEnvironment,
} from "./mvp.js";

export type { IMessageAdapterInboundMessage, IMessageAdapterOutboundMessage };

export interface IMessageAdapterOptions {
  osascriptPath?: string;
  runAppleScript?: RunAppleScript;
  detectEnvironmentOptions?: DetectIMessageMvpEnvironmentOptions;
  detectEnvironment?: (options?: DetectIMessageMvpEnvironmentOptions) => IMessageMvpEnvironment;
}

export interface IMessageAdapter extends MessageAdapter {
  readonly name: "imessage";
}

export class AppleScriptIMessageAdapter implements IMessageAdapter {
  readonly name = "imessage" as const;

  private readonly options: IMessageAdapterOptions;

  constructor(options: IMessageAdapterOptions = {}) {
    this.options = options;
  }

  async connect(): Promise<void> {
    const detectEnvironment = this.options.detectEnvironment;
    const environment = detectEnvironment
      ? detectEnvironment(this.options.detectEnvironmentOptions)
      : null;

    if (environment) {
      if (!environment.canAttemptSend) {
        throw new Error(
          [
            "iMessage send-first adapter is not ready.",
            ...formatIMessageMvpReadiness(environment),
          ].join(" "),
        );
      }
      return;
    }

    assertIMessageSendCapability(this.options.detectEnvironmentOptions);
  }

  async disconnect(): Promise<void> {
    // The current send-first adapter does not hold inbound subscriptions or
    // long-lived connection state beyond the shared MessageAdapter surface.
  }

  onInbound(_handler: (msg: IMessageAdapterInboundMessage) => void): void {
    // The shared MessageAdapter contract requires an inbound hook, but the
    // current iMessage adapter is send-only and intentionally ignores it.
  }

  async send(msg: IMessageAdapterOutboundMessage): Promise<void> {
    await sendIMessage({
      recipient: msg.channel,
      text: msg.content?.text ?? msg.text,
      osascriptPath: this.options.osascriptPath,
      runAppleScript: this.options.runAppleScript,
    });
  }
}

export function createIMessageAdapter(options: IMessageAdapterOptions = {}): IMessageAdapter {
  return new AppleScriptIMessageAdapter(options);
}
