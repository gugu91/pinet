import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalAuditStore,
  ApprovalReceiptVerifier,
  ApprovalSignerPreSignRejection,
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
} from "./approval-receipts.js";
import type {
  SlackV0ApprovalContextAuthenticator,
  SlackV0RequestApprovalContext,
} from "./slack-approval-authenticator.js";

const AUTHORIZED_SLACK_ID = "U0AF5S3LQ5C";

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
  let authenticatedContexts: Map<
    string,
    {
      readonly principal: string;
      readonly approvalId: string;
      readonly threadId: string;
      readonly envelopeDigest: string;
    }
  >;
  let contextSequence: number;
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
    authenticatedContexts = new Map();
    contextSequence = 0;
    contextAuthenticator = {
      authenticateAndConsume: (context) => {
        const handle = context.authenticationHandle;
        if (!handle) throw new Error("Slack/broker context authentication failed");
        const authenticated = authenticatedContexts.get(handle);
        if (!authenticated) throw new Error("Slack/broker context authentication failed");
        authenticatedContexts.delete(handle);
        return authenticated;
      },
    };
    nowMs = Date.parse("2026-07-11T10:00:00.000Z");
    issuer = new SlackApprovalIssuer(
      contextAuthenticator as SlackV0ApprovalContextAuthenticator,
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

  function contextFor(
    approvalId: string,
    value: ApprovalEnvelope,
    principal = AUTHORIZED_SLACK_ID,
  ): SlackV0RequestApprovalContext {
    const authenticationHandle = `authenticated-ingress-${contextSequence++}`;
    authenticatedContexts.set(authenticationHandle, {
      principal,
      approvalId,
      threadId: value.threadId,
      envelopeDigest: digestApprovalEnvelope(value),
    });
    return { authenticationHandle } as SlackV0RequestApprovalContext;
  }

  async function issue(
    approvalId = "approval-1",
    value = envelope(),
    ttlMs = MAX_APPROVAL_TTL_MS,
  ): Promise<ApprovalReceipt> {
    return issuer.create(contextFor(approvalId, value), { approvalId, ttlMs, envelope: value });
  }

  it("derives every authorization binding only from one-time trusted context", async () => {
    const receipt = await issue();
    expect(receipt.claims.principal).toBe(AUTHORIZED_SLACK_ID);
    expect(receipt.claims.envelope.threadId).toBe("thread-1");

    await expect(
      issuer.create({ authenticationHandle: "caller-invented" } as SlackV0RequestApprovalContext, {
        approvalId: "approval-2",
        ttlMs: 1_000,
        envelope: envelope({ sendId: "send-2" }),
      }),
    ).rejects.toThrow("authentication failed");

    const wrongPrincipalAuthenticator: SlackApprovalContextAuthenticator = {
      authenticateAndConsume: () => ({
        principal: "U_ATTACKER",
        approvalId: "approval-3",
        threadId: "thread-1",
        envelopeDigest: digestApprovalEnvelope(envelope({ sendId: "send-3" })),
      }),
    };
    const wrongPrincipalIssuer = new SlackApprovalIssuer(
      wrongPrincipalAuthenticator as SlackV0ApprovalContextAuthenticator,
      signer,
      audit,
    );
    await expect(
      wrongPrincipalIssuer.create(
        { authenticationHandle: "wrong-principal" } as SlackV0RequestApprovalContext,
        {
          approvalId: "approval-3",
          ttlMs: 1_000,
          envelope: envelope({ sendId: "send-3" }),
        },
      ),
    ).rejects.toThrow("not authorized");

    const boundEnvelope = envelope({ sendId: "send-4" });
    await expect(
      issuer.create(contextFor("approval-4", boundEnvelope), {
        approvalId: "approval-4",
        ttlMs: 1_000,
        envelope: { ...boundEnvelope, threadId: "caller-controlled-thread" },
      }),
    ).rejects.toThrow("authenticated Slack context");
  });

  it("atomically consumes the request-bound context and rejects replay before signing", async () => {
    const value = envelope();
    const context = contextFor("approval-1", value);
    await expect(
      issuer.create(context, { approvalId: "approval-1", ttlMs: 1_000, envelope: value }),
    ).resolves.toMatchObject({ claims: { approvalId: "approval-1" } });
    await expect(
      issuer.create(context, { approvalId: "approval-1", ttlMs: 1_000, envelope: value }),
    ).rejects.toThrow("authentication failed");
    expect(signerCalls).toBe(1);
  });

  it("atomically allows only one concurrent issuance attempt per context handle", async () => {
    const value = envelope();
    const context = contextFor("approval-1", value);
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        issuer.create(context, {
          approvalId: "approval-1",
          ttlMs: 1_000,
          envelope: value,
        }),
      ),
    );
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(7);
    expect(signerCalls).toBe(1);
  });

  it("rejects approval ID substitution, consumes the detached handle, and never signs", async () => {
    const value = envelope();
    const context = contextFor("approval-bound", value);
    await expect(
      issuer.create(context, { approvalId: "approval-substituted", ttlMs: 1_000, envelope: value }),
    ).rejects.toThrow("Approval ID");
    await expect(
      issuer.create(context, { approvalId: "approval-bound", ttlMs: 1_000, envelope: value }),
    ).rejects.toThrow("authentication failed");
    expect(signerCalls).toBe(0);
  });

  it("rejects every canonical envelope substitution before signer invocation", async () => {
    const substitutions: Array<{
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
      { name: "attestation", alter: (value) => ({ ...value, attestation: digest("altered") }) },
      { name: "payload", alter: (value) => ({ ...value, payload: "altered" }) },
      {
        name: "recipients.to",
        alter: (value) => ({
          ...value,
          recipients: { ...value.recipients, to: ["altered@example.com"] },
        }),
      },
      {
        name: "recipients.cc",
        alter: (value) => ({
          ...value,
          recipients: { ...value.recipients, cc: ["altered@example.com"] },
        }),
      },
      {
        name: "recipients.bcc",
        alter: (value) => ({
          ...value,
          recipients: { ...value.recipients, bcc: ["altered@example.com"] },
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

    for (const [index, substitution] of substitutions.entries()) {
      const approvalId = `approval-context-substitution-${index}`;
      const bound = envelope({
        draftId: `draft-context-substitution-${index}`,
        draftFingerprint: digest(`context-substitution-${index}`),
        sendId: `send-context-substitution-${index}`,
      });
      await expect(
        issuer.create(contextFor(approvalId, bound), {
          approvalId,
          ttlMs: 1_000,
          envelope: substitution.alter(bound),
        }),
        substitution.name,
      ).rejects.toThrow("authenticated Slack context");
    }
    expect(signerCalls).toBe(0);
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
    expect(
      issuer.status(contextFor("approval-1", receipt.claims.envelope), "approval-1")?.state,
    ).toBe("consumed");
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
    expect(
      issuer.status(
        contextFor(receipt.claims.approvalId, receipt.claims.envelope),
        receipt.claims.approvalId,
      )?.state,
    ).toBe("consumed");
  });

  it("rejects cancellation before consumption and prevents cancellation after consumption", async () => {
    const cancelled = await issue();
    expect(
      issuer.cancel(
        contextFor(cancelled.claims.approvalId, cancelled.claims.envelope),
        cancelled.claims.approvalId,
      ).state,
    ).toBe("cancelled");
    expect(() => receiptVerifier.verifyAndConsume(cancelled, expected(cancelled))).toThrow(
      "cancelled",
    );

    const consumed = await issue(
      "approval-2",
      envelope({ draftId: "draft-2", draftFingerprint: digest("draft-2"), sendId: "send-2" }),
    );
    receiptVerifier.verifyAndConsume(consumed, expected(consumed));
    expect(() =>
      issuer.cancel(
        contextFor(consumed.claims.approvalId, consumed.claims.envelope),
        consumed.claims.approvalId,
      ),
    ).toThrow("consumed");
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
      contextAuthenticator as SlackV0ApprovalContextAuthenticator,
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

  it("releases only an operation-bound definitive pre-sign rejection", async () => {
    let fail = true;
    const failOnceSigner: ApprovalSigner = {
      keyId: "synthetic-test-root",
      issueApproval: async (claims, request) => {
        if (fail) {
          fail = false;
          throw new ApprovalSignerPreSignRejection(
            request.operationId,
            "synthetic definitive pre-sign rejection",
          );
        }
        return {
          signature: sign(null, Buffer.from(serializeApprovalClaims(claims)), privateKey).toString(
            "base64url",
          ),
        };
      },
    };
    issuer = new SlackApprovalIssuer(
      contextAuthenticator as SlackV0ApprovalContextAuthenticator,
      failOnceSigner,
      audit,
      () => new Date(nowMs),
    );
    await expect(issue()).rejects.toThrow("definitive pre-sign rejection");
    await expect(issue()).resolves.toMatchObject({ claims: { approvalId: "approval-1" } });
  });

  it("retains a pre-sign rejection that names a different operation", async () => {
    const mismatchedSigner: ApprovalSigner = {
      keyId: "synthetic-test-root",
      issueApproval: async () => {
        throw new ApprovalSignerPreSignRejection("different-operation");
      },
    };
    issuer = new SlackApprovalIssuer(
      contextAuthenticator as SlackV0ApprovalContextAuthenticator,
      mismatchedSigner,
      audit,
      () => new Date(nowMs),
    );
    await expect(issue()).rejects.toThrow("rejected before signing");
    await expect(issue()).rejects.toThrow("already reserved");
  });

  it("retains an ambiguous signer failure and reconciles with the same operation ID", async () => {
    const operationIds: string[] = [];
    let fail = true;
    const ambiguousOnceSigner: ApprovalSigner = {
      keyId: "synthetic-test-root",
      issueApproval: async (claims, request) => {
        operationIds.push(request.operationId);
        if (fail) {
          fail = false;
          throw new Error("transport disconnected after request delivery");
        }
        return {
          signature: sign(null, Buffer.from(serializeApprovalClaims(claims)), privateKey).toString(
            "base64url",
          ),
        };
      },
    };
    issuer = new SlackApprovalIssuer(
      contextAuthenticator as SlackV0ApprovalContextAuthenticator,
      ambiguousOnceSigner,
      audit,
      () => new Date(nowMs),
      { signerTimeoutMs: 10, reservationLeaseMs: 30 },
    );
    await expect(issue()).rejects.toThrow("transport disconnected");
    await expect(issue()).rejects.toThrow("already reserved");
    nowMs += 31;
    await expect(issue()).resolves.toMatchObject({ claims: { approvalId: "approval-1" } });
    expect(operationIds).toHaveLength(2);
    expect(operationIds[1]).toBe(operationIds[0]);
  });

  it("bounds a hung signer call and retains its reservation for safe recovery", async () => {
    const hungSigner: ApprovalSigner = {
      keyId: "synthetic-test-root",
      issueApproval: () => new Promise(() => undefined),
    };
    issuer = new SlackApprovalIssuer(
      contextAuthenticator as SlackV0ApprovalContextAuthenticator,
      hungSigner,
      audit,
      () => new Date(nowMs),
      { signerTimeoutMs: 10, reservationLeaseMs: 50 },
    );
    await expect(issue()).rejects.toThrow("timed out");
    await expect(issue()).rejects.toThrow("already reserved");
  });

  it("fences an abort-ignoring stale signer completion from finalizing or deleting its successor", async () => {
    const operationIds: string[] = [];
    let firstSignal: AbortSignal | undefined;
    let resolveFirst: (() => void) | undefined;
    let resolveSuccessor: (() => void) | undefined;
    const recoveringSigner: ApprovalSigner = {
      keyId: "synthetic-test-root",
      issueApproval: (claims, request) => {
        operationIds.push(request.operationId);
        const signature = sign(
          null,
          Buffer.from(serializeApprovalClaims(claims)),
          privateKey,
        ).toString("base64url");
        if (operationIds.length === 1) {
          firstSignal = request.signal;
          return new Promise((resolve) => {
            resolveFirst = () => resolve({ signature });
          });
        }
        return new Promise((resolve) => {
          resolveSuccessor = () => resolve({ signature });
        });
      },
    };
    issuer = new SlackApprovalIssuer(
      contextAuthenticator as SlackV0ApprovalContextAuthenticator,
      recoveringSigner,
      audit,
      () => new Date(nowMs),
      { signerTimeoutMs: 100, reservationLeaseMs: 200 },
    );
    await expect(issue()).rejects.toThrow("timed out");
    expect(firstSignal?.aborted).toBe(true);

    nowMs += 201;
    const successor = issue();
    expect(operationIds).toHaveLength(2);
    expect(operationIds[1]).toBe(operationIds[0]);

    resolveFirst?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(issuer.status(contextFor("approval-1", envelope()), "approval-1")).toBeNull();
    await expect(issue()).rejects.toThrow("already reserved");

    resolveSuccessor?.();
    await expect(successor).resolves.toMatchObject({ claims: { approvalId: "approval-1" } });
    expect(issuer.status(contextFor("approval-1", envelope()), "approval-1")?.state).toBe("active");
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
