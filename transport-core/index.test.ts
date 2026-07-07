import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCompatibilityInstanceScope,
  buildCompatibilityWorkspaceScope,
  buildRuntimeScopeCarrier,
  type AdapterCapabilityRequest,
  type InboundMessage,
  type OutboundMessage,
} from "./index.ts";

test("buildCompatibilityWorkspaceScope keeps unknown workspace ids unknown while preserving compatibility mode", () => {
  assert.deepEqual(
    buildCompatibilityWorkspaceScope({
      provider: "slack",
      workspaceId: "",
      channelId: " C123 ",
    }),
    {
      provider: "slack",
      source: "compatibility",
      compatibilityKey: "default",
      channelId: "C123",
    },
  );
});

test("buildRuntimeScopeCarrier combines workspace and instance compatibility carriers", () => {
  const scope = buildRuntimeScopeCarrier({
    workspace: buildCompatibilityWorkspaceScope({
      provider: "slack",
      workspaceId: "T123",
      channelId: "C123",
    }),
    instance: buildCompatibilityInstanceScope(),
  });

  assert.deepEqual(scope, {
    workspace: {
      provider: "slack",
      source: "compatibility",
      compatibilityKey: "default",
      workspaceId: "T123",
      channelId: "C123",
    },
    instance: {
      source: "compatibility",
      compatibilityKey: "default",
    },
  });
});

test("InboundMessage can carry first-class runtime scope metadata", () => {
  const message: InboundMessage = {
    source: "slack",
    threadId: "123.456",
    channel: "C123",
    userId: "U123",
    text: "hello",
    timestamp: "123.456",
    scope: buildRuntimeScopeCarrier({
      workspace: buildCompatibilityWorkspaceScope({
        provider: "slack",
        workspaceId: "T123",
      }),
      instance: buildCompatibilityInstanceScope(),
    }),
  };

  assert.equal(message.scope?.workspace?.workspaceId, "T123");
  assert.equal(message.scope?.instance?.compatibilityKey, "default");
});

test("transport payload DTOs carry JSON-compatible metadata and blocks", () => {
  const message: OutboundMessage = {
    threadId: "123.456",
    channel: "C123",
    text: "hello",
    metadata: { attempt: 1, tags: ["owl", "transport"], nested: { ok: true } },
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "*hello*" } }],
  };
  const request: AdapterCapabilityRequest = {
    capability: "thread.claim",
    params: { threadId: message.threadId, dryRun: false },
  };

  assert.deepEqual(message.metadata?.nested, { ok: true });
  assert.equal(message.blocks?.[0]?.type, "section");
  assert.equal(request.params.threadId, "123.456");
});
