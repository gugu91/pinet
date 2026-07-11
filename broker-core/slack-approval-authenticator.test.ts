import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalAuditStore,
  SlackApprovalIssuer,
  THOMAS_SLACK_USER_ID,
  digestApprovalEnvelope,
  type ApprovalEnvelope,
} from "./approval-receipts.js";
import {
  SLACK_APPROVAL_CONTEXT_VERSION,
  SlackV0ApprovalContextAuthenticator,
  type SlackV0RequestApprovalContext,
} from "./slack-approval-authenticator.js";

const SIGNING_SECRET = "test-only-slack-signing-secret";
const ENVELOPE_DIGEST = "A".repeat(43);

function body(overrides: Record<string, string> = {}): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      type: SLACK_APPROVAL_CONTEXT_VERSION,
      contextId: "context-1",
      userId: THOMAS_SLACK_USER_ID,
      approvalId: "approval-1",
      threadId: "1712345678.123456",
      envelopeDigest: ENVELOPE_DIGEST,
      ...overrides,
    }),
  );
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
    const issuer = new SlackApprovalIssuer(
      authenticator,
      { keyId: "external-root", issueApproval: async () => ({ signature: "signed" }) },
      audit,
      () => new Date(nowMs),
    );
    const context = signedRequest(body({ envelopeDigest: digestApprovalEnvelope(value) }));
    await expect(
      issuer.create(context, { approvalId: "approval-1", ttlMs: 1_000, envelope: value }),
    ).resolves.toMatchObject({ claims: { principal: THOMAS_SLACK_USER_ID } });
    audit.close();
  });

  it("verifies Slack v0 over exact raw bytes and returns only fixed Thomas bindings", () => {
    const authenticated = authenticator.authenticateAndConsume(signedRequest(body()));
    expect(authenticated).toEqual({
      principal: THOMAS_SLACK_USER_ID,
      approvalId: "approval-1",
      threadId: "1712345678.123456",
      envelopeDigest: ENVELOPE_DIGEST,
    });
  });

  it("rejects forged signatures and a body modified after signing", () => {
    expect(() =>
      authenticator.authenticateAndConsume(signedRequest(body(), undefined, "wrong-secret")),
    ).toThrow("signature");

    const request = signedRequest(body());
    const modified: SlackV0RequestApprovalContext = {
      ...request,
      rawBody: body({ approvalId: "attacker-approval" }),
    };
    expect(() => authenticator.authenticateAndConsume(modified)).toThrow("signature");
  });

  it("rejects stale and excessively future timestamps", () => {
    expect(() => authenticator.authenticateAndConsume(signedRequest(body(), "1783763699"))).toThrow(
      "stale",
    );
    expect(() => authenticator.authenticateAndConsume(signedRequest(body(), "1783764301"))).toThrow(
      "stale",
    );
  });

  it("rejects a validly signed context for any user other than Thomas", () => {
    expect(() =>
      authenticator.authenticateAndConsume(
        signedRequest(body({ userId: "U_ATTACKER", contextId: "context-attacker" })),
      ),
    ).toThrow("not authorized");
  });

  it("durably rejects exact request replay after restart", () => {
    const request = signedRequest(body());
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
    authenticator.authenticateAndConsume(signedRequest(body()));
    nowMs += 1_000;
    expect(() => authenticator.authenticateAndConsume(signedRequest(body(), "1783764001"))).toThrow(
      "already been consumed",
    );
  });

  it("atomically permits only one concurrent consumption", async () => {
    const request = signedRequest(body());
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        Promise.resolve().then(() => authenticator.authenticateAndConsume(request)),
      ),
    );
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(11);
  });

  it("does not persist request bodies or the signing secret", () => {
    authenticator.authenticateAndConsume(signedRequest(body()));
    const bytes = readFileSync(databasePath, "utf8");
    expect(bytes).not.toContain("approval-1");
    expect(bytes).not.toContain("1712345678.123456");
    expect(bytes).not.toContain(SIGNING_SECRET);
  });
});
