import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalAuditStore,
  ApprovalReceiptVerifier,
  MAX_APPROVAL_TTL_MS,
  SlackApprovalIssuer,
  digestApprovalEnvelope,
  serializeApprovalClaims,
  type ApprovalClaims,
  type ApprovalEnvelope,
  type ApprovalReceipt,
  type ApprovalSigner,
  type ExpectedApproval,
  type PinnedApprovalSignatureVerifier,
  type SlackApprovalContextAuthenticator,
  type SlackBrokerApprovalContext,
} from "./approval-receipts.js";

const AUTHORIZED_SLACK_ID = "U0AF5S3LQ5C";
const AUTHENTICATED_HANDLE = "test-authenticated-ingress-handle";
const CONTEXT: SlackBrokerApprovalContext = { authenticationHandle: AUTHENTICATED_HANDLE };

function digest(label: string): string {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

function envelope(overrides: Partial<ApprovalEnvelope> = {}): ApprovalEnvelope {
  return {
    accountId: "account-1",
    threadId: "thread-1",
    draftId: "draft-1",
    draftFingerprint: digest("draft"),
    attestation: digest("attestation"),
    payload: "complete rendered payload",
    recipients: {
      to: ["to@example.com"],
      cc: ["cc@example.com"],
      bcc: ["bcc@example.com"],
    },
    rendererBuild: "renderer@abc123",
    screenshotDigests: [digest("screenshot")],
    sendId: "send-1",
    delayMs: 60_000,
    scheduledFor: "2026-07-11T12:00:00.000Z",
    action: "email.send",
    provider: "superhuman",
    ...overrides,
  };
}

function expected(receipt: ApprovalReceipt, value = receipt.claims.envelope): ExpectedApproval {
  return { approvalId: receipt.claims.approvalId, envelope: value };
}

function alteredReceipt(
  receipt: ApprovalReceipt,
  claims: Partial<ApprovalClaims>,
): ApprovalReceipt {
  return { ...receipt, claims: { ...receipt.claims, ...claims } };
}

describe("broker-core approval receipts", () => {
  let directory: string;
  let audit: ApprovalAuditStore;
  let privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  let signerCalls: number;
  let signer: ApprovalSigner;
  let pinnedVerifier: PinnedApprovalSignatureVerifier;
  let contextAuthenticator: SlackApprovalContextAuthenticator;
  let nowMs: number;
  let issuer: SlackApprovalIssuer;
  let receiptVerifier: ApprovalReceiptVerifier;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "approval-receipts-"));
    audit = new ApprovalAuditStore(path.join(directory, "audit.db"));

    // NON-PRODUCTION TEST FIXTURE ONLY: synthetic process-local key material is
    // isolated to this test and never exported by broker-core production code.
    const pair = generateKeyPairSync("ed25519");
    privateKey = pair.privateKey;
    const publicKey = pair.publicKey;
    signerCalls = 0;
    signer = {
      keyId: "synthetic-test-root",
      issueApproval: async (claims: ApprovalClaims) => {
        signerCalls += 1;
        return {
          signature: sign(null, Buffer.from(serializeApprovalClaims(claims)), privateKey).toString(
            "base64url",
          ),
        };
      },
    };
    pinnedVerifier = {
      keyId: "synthetic-test-root",
      verify: (canonicalClaims, signature) =>
        verify(null, Buffer.from(canonicalClaims), publicKey, Buffer.from(signature, "base64url")),
    };
    contextAuthenticator = {
      authenticate: (context) => {
        if (context.authenticationHandle !== AUTHENTICATED_HANDLE) {
          throw new Error("Slack/broker context authentication failed");
        }
        return { principal: AUTHORIZED_SLACK_ID, threadId: "thread-1" };
      },
    };
    nowMs = Date.parse("2026-07-11T10:00:00.000Z");
    issuer = new SlackApprovalIssuer(
      AUTHORIZED_SLACK_ID,
      contextAuthenticator,
      signer,
      audit,
      () => new Date(nowMs),
    );
    receiptVerifier = new ApprovalReceiptVerifier(
      AUTHORIZED_SLACK_ID,
      pinnedVerifier,
      audit,
      () => new Date(nowMs),
    );
  });

  afterEach(() => {
    audit.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function issue(
    approvalId = "approval-1",
    value = envelope(),
    ttlMs = MAX_APPROVAL_TTL_MS,
  ): Promise<ApprovalReceipt> {
    return issuer.create(CONTEXT, { approvalId, ttlMs, envelope: value });
  }

  it("derives principal and thread only from the trusted authenticated context", async () => {
    const receipt = await issue();
    expect(receipt.claims.principal).toBe(AUTHORIZED_SLACK_ID);
    expect(receipt.claims.envelope.threadId).toBe("thread-1");

    await expect(
      issuer.create(
        { authenticationHandle: "caller-invented" },
        { approvalId: "approval-2", ttlMs: 1_000, envelope: envelope({ sendId: "send-2" }) },
      ),
    ).rejects.toThrow("authentication failed");

    const wrongPrincipalAuthenticator: SlackApprovalContextAuthenticator = {
      authenticate: () => ({ principal: "U_ATTACKER", threadId: "thread-1" }),
    };
    const wrongPrincipalIssuer = new SlackApprovalIssuer(
      AUTHORIZED_SLACK_ID,
      wrongPrincipalAuthenticator,
      signer,
      audit,
    );
    await expect(
      wrongPrincipalIssuer.create(CONTEXT, {
        approvalId: "approval-3",
        ttlMs: 1_000,
        envelope: envelope({ sendId: "send-3" }),
      }),
    ).rejects.toThrow("not authorized");

    await expect(
      issue("approval-4", envelope({ threadId: "caller-controlled-thread", sendId: "send-4" })),
    ).rejects.toThrow("authenticated Slack context");
  });

  it("includes keyId in signed claims and rejects an altered keyId", async () => {
    const receipt = await issue();
    expect(receipt.claims.keyId).toBe("synthetic-test-root");
    const altered = alteredReceipt(receipt, { keyId: "attacker-key" });
    expect(() => receiptVerifier.verifyAndConsume(altered, expected(receipt))).toThrow("keyId");
  });

  it("uses a pinned verifier object and performs one-time semantic verification", async () => {
    const receipt = await issue();
    expect(() => receiptVerifier.verifyAndConsume(receipt, expected(receipt))).not.toThrow();
    expect(issuer.status(CONTEXT, "approval-1")?.state).toBe("consumed");
    expect(() => receiptVerifier.verifyAndConsume(receipt, expected(receipt))).toThrow("consumed");
  });

  it("rejects wrong version, principal, signature, future issuance, invalid lifetime, and expiry", async () => {
    const versionReceipt = await issue(
      "approval-version",
      envelope({
        draftId: "draft-version",
        draftFingerprint: digest("version"),
        sendId: "send-version",
      }),
    );
    expect(() =>
      receiptVerifier.verifyAndConsume(
        alteredReceipt(versionReceipt, { version: "other-version" as ApprovalClaims["version"] }),
        expected(versionReceipt),
      ),
    ).toThrow("version");

    const principalReceipt = await issue(
      "approval-principal",
      envelope({
        draftId: "draft-principal",
        draftFingerprint: digest("principal"),
        sendId: "send-principal",
      }),
    );
    expect(() =>
      receiptVerifier.verifyAndConsume(
        alteredReceipt(principalReceipt, { principal: "U_ATTACKER" }),
        expected(principalReceipt),
      ),
    ).toThrow("principal");

    const signatureReceipt = await issue(
      "approval-signature",
      envelope({
        draftId: "draft-signature",
        draftFingerprint: digest("signature"),
        sendId: "send-signature",
      }),
    );
    expect(() =>
      receiptVerifier.verifyAndConsume(
        {
          ...signatureReceipt,
          signature: `${signatureReceipt.signature[0] === "A" ? "B" : "A"}${signatureReceipt.signature.slice(1)}`,
        },
        expected(signatureReceipt),
      ),
    ).toThrow("signature");

    const futureReceipt = await issue(
      "approval-future",
      envelope({
        draftId: "draft-future",
        draftFingerprint: digest("future"),
        sendId: "send-future",
      }),
    );
    nowMs -= 1;
    expect(() => receiptVerifier.verifyAndConsume(futureReceipt, expected(futureReceipt))).toThrow(
      "future",
    );
    nowMs += 1;

    const lifetimeReceipt = await issue(
      "approval-lifetime",
      envelope({
        draftId: "draft-lifetime",
        draftFingerprint: digest("lifetime"),
        sendId: "send-lifetime",
      }),
    );
    expect(() =>
      receiptVerifier.verifyAndConsume(
        alteredReceipt(lifetimeReceipt, {
          expiresAt: new Date(nowMs + MAX_APPROVAL_TTL_MS + 1).toISOString(),
        }),
        expected(lifetimeReceipt),
      ),
    ).toThrow("lifetime");

    const expiredReceipt = await issue(
      "approval-expired",
      envelope({
        draftId: "draft-expired",
        draftFingerprint: digest("expired"),
        sendId: "send-expired",
      }),
      1_000,
    );
    nowMs += 1_000;
    expect(() =>
      receiptVerifier.verifyAndConsume(expiredReceipt, expected(expiredReceipt)),
    ).toThrow("expired");
  });

  it("atomically permits only one concurrent consumption", async () => {
    const receipt = await issue();
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        Promise.resolve().then(() => receiptVerifier.verifyAndConsume(receipt, expected(receipt))),
      ),
    );
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(7);
    expect(issuer.status(CONTEXT, receipt.claims.approvalId)?.state).toBe("consumed");
  });

  it("rejects cancellation before consumption and prevents cancellation after consumption", async () => {
    const cancelled = await issue();
    expect(issuer.cancel(CONTEXT, cancelled.claims.approvalId).state).toBe("cancelled");
    expect(() => receiptVerifier.verifyAndConsume(cancelled, expected(cancelled))).toThrow(
      "cancelled",
    );

    const consumed = await issue(
      "approval-2",
      envelope({ draftId: "draft-2", draftFingerprint: digest("draft-2"), sendId: "send-2" }),
    );
    receiptVerifier.verifyAndConsume(consumed, expected(consumed));
    expect(() => issuer.cancel(CONTEXT, consumed.claims.approvalId)).toThrow("consumed");
  });

  it("rejects an exact mismatch for every expected delivery field", async () => {
    const cases: Array<{
      name: string;
      alter: (value: ApprovalEnvelope) => ApprovalEnvelope;
    }> = [
      { name: "accountId", alter: (value) => ({ ...value, accountId: "altered" }) },
      { name: "threadId", alter: (value) => ({ ...value, threadId: "altered" }) },
      { name: "draftId", alter: (value) => ({ ...value, draftId: "altered" }) },
      {
        name: "draftFingerprint",
        alter: (value) => ({ ...value, draftFingerprint: digest("altered") }),
      },
      {
        name: "attestation",
        alter: (value) => ({ ...value, attestation: digest("altered") }),
      },
      { name: "payload", alter: (value) => ({ ...value, payload: "altered" }) },
      {
        name: "recipients.to",
        alter: (value) => ({
          ...value,
          recipients: { ...value.recipients, to: ["x@example.com"] },
        }),
      },
      {
        name: "recipients.cc",
        alter: (value) => ({
          ...value,
          recipients: { ...value.recipients, cc: ["x@example.com"] },
        }),
      },
      {
        name: "recipients.bcc",
        alter: (value) => ({
          ...value,
          recipients: { ...value.recipients, bcc: ["x@example.com"] },
        }),
      },
      { name: "rendererBuild", alter: (value) => ({ ...value, rendererBuild: "altered" }) },
      {
        name: "screenshotDigests",
        alter: (value) => ({ ...value, screenshotDigests: [digest("altered")] }),
      },
      { name: "sendId", alter: (value) => ({ ...value, sendId: "altered" }) },
      { name: "delayMs", alter: (value) => ({ ...value, delayMs: value.delayMs + 1 }) },
      { name: "scheduledFor", alter: (value) => ({ ...value, scheduledFor: null }) },
      { name: "action", alter: (value) => ({ ...value, action: "altered" }) },
      { name: "provider", alter: (value) => ({ ...value, provider: "altered" }) },
    ];

    for (const [index, mismatch] of cases.entries()) {
      const value = envelope({
        draftId: `draft-mismatch-${index}`,
        draftFingerprint: digest(`mismatch-${index}`),
        sendId: `send-mismatch-${index}`,
      });
      const receipt = await issue(`approval-mismatch-${index}`, value);
      expect(
        () => receiptVerifier.verifyAndConsume(receipt, expected(receipt, mismatch.alter(value))),
        mismatch.name,
      ).toThrow("mismatch");
    }
  });

  it("also rejects mismatched approval identity", async () => {
    const receipt = await issue();
    expect(() =>
      receiptVerifier.verifyAndConsume(receipt, {
        approvalId: "different-approval",
        envelope: receipt.claims.envelope,
      }),
    ).toThrow("approvalId mismatch");
  });

  it("uses locale-independent canonical JSON", async () => {
    const original = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error("localeCompare must not be used");
    };
    try {
      const receipt = await issue();
      expect(serializeApprovalClaims(receipt.claims)).toContain('"accountId":"account-1"');
      expect(digestApprovalEnvelope(receipt.claims.envelope)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    } finally {
      String.prototype.localeCompare = original;
    }
  });

  it("signs and returns deep immutable copies despite caller mutation", async () => {
    let releaseSigner: (() => void) | undefined;
    const signerGate = new Promise<void>((resolve) => {
      releaseSigner = resolve;
    });
    let signedClaims: ApprovalClaims | undefined;
    const gatedSigner: ApprovalSigner = {
      keyId: "synthetic-test-root",
      issueApproval: async (claims) => {
        signedClaims = claims;
        await signerGate;
        return {
          signature: sign(null, Buffer.from(serializeApprovalClaims(claims)), privateKey).toString(
            "base64url",
          ),
        };
      },
    };
    issuer = new SlackApprovalIssuer(
      AUTHORIZED_SLACK_ID,
      contextAuthenticator,
      gatedSigner,
      audit,
      () => new Date(nowMs),
    );
    const mutableTo = ["to@example.com"];
    const mutableScreenshots = [digest("screenshot")];
    const mutableEnvelope = envelope({
      recipients: { to: mutableTo, cc: [], bcc: [] },
      screenshotDigests: mutableScreenshots,
    });
    const pending = issue("approval-immutable", mutableEnvelope);
    mutableTo[0] = "attacker@example.com";
    mutableScreenshots[0] = "attacker-digest";
    releaseSigner?.();
    const receipt = await pending;

    expect(receipt.claims.envelope.recipients.to).toEqual(["to@example.com"]);
    expect(receipt.claims.envelope.screenshotDigests).toEqual([digest("screenshot")]);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.claims)).toBe(true);
    expect(Object.isFrozen(receipt.claims.envelope)).toBe(true);
    expect(Object.isFrozen(receipt.claims.envelope.recipients.to)).toBe(true);
    expect(Object.isFrozen(signedClaims?.envelope.screenshotDigests)).toBe(true);
  });

  it("atomically reserves approval/send/draft/fingerprint/envelope before exactly one signer call", async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        issue(
          `approval-${index}`,
          envelope({
            // All attempts intentionally collide on send, draft, fingerprint, and envelope.
          }),
        ),
      ),
    );
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(7);
    expect(signerCalls).toBe(1);
  });

  it("reserves each identity independently before signing", async () => {
    await issue();
    const collisions: ApprovalEnvelope[] = [
      envelope({ draftId: "draft-a", draftFingerprint: digest("a"), sendId: "send-1" }),
      envelope({ draftId: "draft-1", draftFingerprint: digest("b"), sendId: "send-b" }),
      envelope({ draftId: "draft-c", draftFingerprint: digest("draft"), sendId: "send-c" }),
      envelope(),
    ];
    for (const [index, value] of collisions.entries()) {
      await expect(issue(`approval-collision-${index}`, value)).rejects.toThrow("reserved");
    }
    await expect(
      issue(
        "approval-1",
        envelope({ draftId: "draft-z", draftFingerprint: digest("z"), sendId: "send-z" }),
      ),
    ).rejects.toThrow("reserved");
    expect(signerCalls).toBe(1);
  });

  it("safely cleans only a failed reservation so it can be retried", async () => {
    let fail = true;
    const failOnceSigner: ApprovalSigner = {
      keyId: "synthetic-test-root",
      issueApproval: async (claims) => {
        if (fail) {
          fail = false;
          throw new Error("synthetic signer failure");
        }
        return {
          signature: sign(null, Buffer.from(serializeApprovalClaims(claims)), privateKey).toString(
            "base64url",
          ),
        };
      },
    };
    issuer = new SlackApprovalIssuer(
      AUTHORIZED_SLACK_ID,
      contextAuthenticator,
      failOnceSigner,
      audit,
      () => new Date(nowMs),
    );
    await expect(issue()).rejects.toThrow("synthetic signer failure");
    await expect(issue()).resolves.toMatchObject({ claims: { approvalId: "approval-1" } });
  });

  it("enforces TTL and complete To/Cc/Bcc and screenshot validation", async () => {
    await expect(issue("approval-long", envelope(), MAX_APPROVAL_TTL_MS + 1)).rejects.toThrow(
      "ttlMs",
    );
    await expect(
      issue("approval-no-recipient", envelope({ recipients: { to: [], cc: [], bcc: [] } })),
    ).rejects.toThrow("To/Cc/Bcc");
    await expect(
      issue("approval-no-screenshot", envelope({ screenshotDigests: [] })),
    ).rejects.toThrow("screenshotDigests");
    await expect(
      issue("approval-bad-fingerprint", envelope({ draftFingerprint: "not-a-digest" })),
    ).rejects.toThrow("draftFingerprint");
    await expect(
      issue("approval-bad-attestation", envelope({ attestation: "not-a-digest" })),
    ).rejects.toThrow("attestation");
    await expect(
      issue("approval-bad-screenshot", envelope({ screenshotDigests: ["not-a-digest"] })),
    ).rejects.toThrow("screenshotDigests");
  });

  it("does not persist payload or any To/Cc/Bcc recipient", async () => {
    await issue();
    const bytes = readFileSync(path.join(directory, "audit.db"), "utf8");
    expect(bytes).not.toContain("complete rendered payload");
    expect(bytes).not.toContain("to@example.com");
    expect(bytes).not.toContain("cc@example.com");
    expect(bytes).not.toContain("bcc@example.com");
  });
});
