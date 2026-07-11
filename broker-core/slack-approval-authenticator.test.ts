import { createHmac, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APPROVAL_SIGNATURE_ALGORITHM,
  ApprovalAuditStore,
  SlackApprovalIssuer,
  THOMAS_SLACK_USER_ID,
  digestApprovalEnvelope,
  serializeApprovalClaims,
  type ApprovalClaims,
  type ApprovalEnvelope,
} from "./approval-receipts.js";
import {
  SLACK_APPROVAL_ACTION_ID,
  SLACK_APPROVAL_CONTEXT_VERSION,
  SLACK_APPROVAL_VIEW_CALLBACK_ID,
  SlackV0ApprovalContextAuthenticator,
  type SlackV0RequestApprovalContext,
} from "./slack-approval-authenticator.js";

const SIGNING_SECRET = "test-only-slack-signing-secret";
const ENVELOPE_DIGEST = "A".repeat(43);

interface SlackPayloadOptions {
  readonly userId?: string;
  readonly approvalId?: string;
  readonly threadId?: string;
  readonly envelopeDigest?: string;
  readonly actionId?: string;
  readonly callbackId?: string;
}

function bindingMetadata(options: SlackPayloadOptions): string {
  return JSON.stringify({
    type: SLACK_APPROVAL_CONTEXT_VERSION,
    approvalId: options.approvalId ?? "approval-1",
    threadId: options.threadId ?? "1712345678.123456",
    envelopeDigest: options.envelopeDigest ?? ENVELOPE_DIGEST,
  });
}

function formBody(payload: object): Uint8Array {
  return Buffer.from(new URLSearchParams({ payload: JSON.stringify(payload) }).toString());
}

function blockActionBody(options: SlackPayloadOptions = {}): Uint8Array {
  const threadId = options.threadId ?? "1712345678.123456";
  return formBody({
    type: "block_actions",
    team: { id: "T123", domain: "nexcade" },
    user: { id: options.userId ?? THOMAS_SLACK_USER_ID, username: "thomas" },
    api_app_id: "A123",
    trigger_id: "trigger.1",
    container: {
      type: "message",
      message_ts: threadId,
      channel_id: "C123",
      is_ephemeral: false,
    },
    actions: [
      {
        type: "button",
        action_id: options.actionId ?? SLACK_APPROVAL_ACTION_ID,
        action_ts: "1712345680.654321",
        block_id: "approval-block",
        value: bindingMetadata(options),
      },
    ],
  });
}

function viewSubmissionBody(options: SlackPayloadOptions = {}): Uint8Array {
  return formBody({
    type: "view_submission",
    team: { id: "T123", domain: "nexcade" },
    user: { id: options.userId ?? THOMAS_SLACK_USER_ID, username: "thomas" },
    api_app_id: "A123",
    trigger_id: "trigger.2",
    view: {
      id: "V123",
      team_id: "T123",
      type: "modal",
      callback_id: options.callbackId ?? SLACK_APPROVAL_VIEW_CALLBACK_ID,
      hash: "view-hash-1",
      private_metadata: bindingMetadata(options),
      state: { values: {} },
      title: { type: "plain_text", text: "Approve" },
    },
  });
}

function signedRequest(
  rawBody: Uint8Array,
  timestamp = "1783764000",
  secret = SIGNING_SECRET,
): SlackV0RequestApprovalContext {
  const base = Buffer.concat([Buffer.from(`v0:${timestamp}:`), Buffer.from(rawBody)]);
  return {
    rawBody,
    slackRequestTimestamp: timestamp,
    slackSignature: `v0=${createHmac("sha256", secret).update(base).digest("hex")}`,
  };
}

describe("SlackV0ApprovalContextAuthenticator", () => {
  let directory: string;
  let databasePath: string;
  let nowMs: number;
  let authenticator: SlackV0ApprovalContextAuthenticator;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "slack-approval-auth-"));
    databasePath = path.join(directory, "contexts.db");
    nowMs = Date.parse("2026-07-11T10:00:00.000Z");
    authenticator = new SlackV0ApprovalContextAuthenticator({
      databasePath,
      signingSecret: SIGNING_SECRET,
      now: () => new Date(nowMs),
    });
  });

  afterEach(() => {
    authenticator.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("constructs SlackApprovalIssuer directly against the production authenticator", async () => {
    const audit = new ApprovalAuditStore(path.join(directory, "audit.db"));
    const value: ApprovalEnvelope = {
      accountId: "account-1",
      threadId: "1712345678.123456",
      draftId: "draft-1",
      draftFingerprint: `sha256:${"a".repeat(64)}`,
      attestation: `sha256:${"b".repeat(64)}`,
      payload: "rendered payload",
      recipients: { to: ["to@example.com"], cc: [], bcc: [] },
      rendererBuild: "renderer@1",
      screenshotDigests: [`sha256:${"c".repeat(64)}`],
      sendId: "send-1",
      delayMs: 0,
      scheduledFor: null,
      action: "email.send",
      provider: "provider",
    };
    // NON-PRODUCTION TEST FIXTURE ONLY.
    const pair = generateKeyPairSync("ed25519");
    const issuer = new SlackApprovalIssuer(
      authenticator,
      {
        keyId: "external-root",
        issueApproval: async (claims: ApprovalClaims) => ({
          algorithm: APPROVAL_SIGNATURE_ALGORITHM,
          keyId: "external-root",
          signature: sign(
            null,
            Buffer.from(serializeApprovalClaims(claims)),
            pair.privateKey,
          ).toString("base64url"),
        }),
      },
      {
        algorithm: APPROVAL_SIGNATURE_ALGORITHM,
        keyId: "external-root",
        verify: (claims, signature) =>
          verify(null, Buffer.from(claims), pair.publicKey, Buffer.from(signature, "base64url")),
      },
      audit,
      () => new Date(nowMs),
    );
    const context = signedRequest(
      blockActionBody({ envelopeDigest: digestApprovalEnvelope(value) }),
    );
    await expect(
      issuer.create(context, { approvalId: "approval-1", ttlMs: 1_000, envelope: value }),
    ).resolves.toMatchObject({ claims: { principal: THOMAS_SLACK_USER_ID } });
    audit.close();
  });

  it("parses a genuine form-encoded Slack block_actions payload", () => {
    const authenticated = authenticator.authenticateAndConsume(signedRequest(blockActionBody()));
    expect(authenticated).toEqual({
      principal: THOMAS_SLACK_USER_ID,
      approvalId: "approval-1",
      threadId: "1712345678.123456",
      envelopeDigest: ENVELOPE_DIGEST,
    });
  });

  it("parses a genuine form-encoded Slack view_submission payload", () => {
    const authenticated = authenticator.authenticateAndConsume(
      signedRequest(viewSubmissionBody({ approvalId: "approval-view" })),
    );
    expect(authenticated).toEqual({
      principal: THOMAS_SLACK_USER_ID,
      approvalId: "approval-view",
      threadId: "1712345678.123456",
      envelopeDigest: ENVELOPE_DIGEST,
    });
  });

  it("rejects custom JSON and wrong Slack action or view identifiers", () => {
    const custom = Buffer.from(
      JSON.stringify({
        type: SLACK_APPROVAL_CONTEXT_VERSION,
        userId: THOMAS_SLACK_USER_ID,
        approvalId: "approval-1",
        threadId: "1712345678.123456",
        envelopeDigest: ENVELOPE_DIGEST,
      }),
    );
    expect(() => authenticator.authenticateAndConsume(signedRequest(custom))).toThrow("form");
    expect(() =>
      authenticator.authenticateAndConsume(
        signedRequest(blockActionBody({ actionId: "attacker.action" })),
      ),
    ).toThrow("action identifier");
    expect(() =>
      authenticator.authenticateAndConsume(
        signedRequest(viewSubmissionBody({ callbackId: "attacker.view" })),
      ),
    ).toThrow("view identifier");
  });

  it("rejects forged signatures and a body modified after signing", () => {
    expect(() =>
      authenticator.authenticateAndConsume(
        signedRequest(blockActionBody(), undefined, "wrong-secret"),
      ),
    ).toThrow("signature");

    const request = signedRequest(blockActionBody());
    const modified: SlackV0RequestApprovalContext = {
      ...request,
      rawBody: blockActionBody({ approvalId: "attacker-approval" }),
    };
    expect(() => authenticator.authenticateAndConsume(modified)).toThrow("signature");
  });

  it("rejects stale and excessively future timestamps", () => {
    expect(() =>
      authenticator.authenticateAndConsume(signedRequest(blockActionBody(), "1783763699")),
    ).toThrow("stale");
    expect(() =>
      authenticator.authenticateAndConsume(signedRequest(blockActionBody(), "1783764301")),
    ).toThrow("stale");
  });

  it("hard-caps configured freshness at Slack's five-minute maximum", () => {
    authenticator.close();
    authenticator = new SlackV0ApprovalContextAuthenticator({
      databasePath,
      signingSecret: SIGNING_SECRET,
      requestFreshnessMs: 60 * 60 * 1000,
      now: () => new Date(nowMs),
    });
    expect(() =>
      authenticator.authenticateAndConsume(signedRequest(blockActionBody(), "1783763699")),
    ).toThrow("stale");
  });

  it("rejects a validly signed context for any user other than Thomas", () => {
    expect(() =>
      authenticator.authenticateAndConsume(
        signedRequest(blockActionBody({ userId: "U_ATTACKER" })),
      ),
    ).toThrow("not authorized");
  });

  it("rejects a block action whose signed metadata thread differs from its container", () => {
    const payload = {
      type: "block_actions",
      user: { id: THOMAS_SLACK_USER_ID },
      container: {
        type: "message",
        message_ts: "1712345678.999999",
        channel_id: "C123",
      },
      actions: [
        {
          type: "button",
          action_id: SLACK_APPROVAL_ACTION_ID,
          action_ts: "1712345680.654321",
          value: bindingMetadata({}),
        },
      ],
    };
    expect(() => authenticator.authenticateAndConsume(signedRequest(formBody(payload)))).toThrow(
      "thread",
    );
  });

  it("durably rejects exact request replay after restart", () => {
    const request = signedRequest(blockActionBody());
    authenticator.authenticateAndConsume(request);
    authenticator.close();
    authenticator = new SlackV0ApprovalContextAuthenticator({
      databasePath,
      signingSecret: SIGNING_SECRET,
      now: () => new Date(nowMs),
    });
    expect(() => authenticator.authenticateAndConsume(request)).toThrow("already been consumed");
  });

  it("rejects context replay even with a fresh Slack timestamp and signature", () => {
    authenticator.authenticateAndConsume(signedRequest(blockActionBody()));
    nowMs += 1_000;
    expect(() =>
      authenticator.authenticateAndConsume(signedRequest(blockActionBody(), "1783764001")),
    ).toThrow("already been consumed");
  });

  it("atomically permits only one concurrent consumption", async () => {
    const request = signedRequest(blockActionBody());
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        Promise.resolve().then(() => authenticator.authenticateAndConsume(request)),
      ),
    );
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(11);
  });

  it("does not persist request bodies or the signing secret", () => {
    authenticator.authenticateAndConsume(signedRequest(blockActionBody()));
    const bytes = readFileSync(databasePath, "utf8");
    expect(bytes).not.toContain("approval-1");
    expect(bytes).not.toContain("1712345678.123456");
    expect(bytes).not.toContain(SIGNING_SECRET);
  });
});
