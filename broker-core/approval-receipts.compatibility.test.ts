import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  APPROVAL_SIGNATURE_ALGORITHM,
  ApprovalAuditStore,
  PinnedApprovalVerifierSet,
  RotatingApprovalReceiptVerifier,
  SlackApprovalIssuer,
  digestApprovalEnvelope,
  serializeApprovalClaims,
  type ApprovalClaims,
  type ApprovalEnvelope,
  type ApprovalReceipt,
  type ApprovalSigner,
  type PinnedApprovalSignatureVerifier,
} from "./approval-receipts.js";
import type {
  SlackV0ApprovalContextAuthenticator,
  SlackV0RequestApprovalContext,
} from "./slack-approval-authenticator.js";

const PRINCIPAL = "U0AF5S3LQ5C";
const NOW = new Date("2026-07-11T10:00:00.000Z");
const directories: string[] = [];

function sha256(label: string): string {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

function syntheticEnvelope(sequence: number): ApprovalEnvelope {
  return {
    accountId: "synthetic-account",
    threadId: "synthetic-thread",
    draftId: `synthetic-draft-${sequence}`,
    draftFingerprint: sha256(`draft-${sequence}`),
    attestation: sha256(`attestation-${sequence}`),
    payload: `synthetic rendered body ${sequence}`,
    recipients: { to: ["recipient@example.test"], cc: [], bcc: [] },
    rendererBuild: "synthetic-renderer@test-only",
    screenshotDigests: [sha256(`screenshot-${sequence}`)],
    sendId: `synthetic-send-${sequence}`,
    delayMs: 0,
    scheduledFor: null,
    action: "synthetic.accept-only",
    provider: "none",
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("NON-PRODUCTION synthetic issuer-to-executor compatibility harness", () => {
  it("round-trips the exact v1 receipt and supports pinned-root overlap then revocation without transport", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "synthetic-approval-compat-"));
    directories.push(directory);
    const audit = new ApprovalAuditStore(path.join(directory, "audit.sqlite"));

    // TEST-ONLY: both private keys are generated ephemerally in this process. This
    // file is excluded from broker-core build output and package exports.
    const oldPair = generateKeyPairSync("ed25519");
    const newPair = generateKeyPairSync("ed25519");
    const signerFor = (keyId: string, privateKey: typeof oldPair.privateKey): ApprovalSigner => ({
      keyId,
      issueApproval: async (claims: ApprovalClaims) => ({
        algorithm: APPROVAL_SIGNATURE_ALGORITHM,
        keyId,
        signature: sign(null, Buffer.from(serializeApprovalClaims(claims)), privateKey).toString(
          "base64url",
        ),
      }),
    });
    const verifierFor = (
      keyId: string,
      publicKey: typeof oldPair.publicKey,
    ): PinnedApprovalSignatureVerifier => ({
      algorithm: APPROVAL_SIGNATURE_ALGORITHM,
      keyId,
      verify: (canonicalClaims, signature) =>
        verify(null, Buffer.from(canonicalClaims), publicKey, Buffer.from(signature, "base64url")),
    });
    const oldVerifier = verifierFor("synthetic-old", oldPair.publicKey);
    const newVerifier = verifierFor("synthetic-new", newPair.publicKey);

    let sequence = 0;
    const contexts = new Map<string, ReturnType<typeof authenticatedContext>>();
    function authenticatedContext(approvalId: string, envelope: ApprovalEnvelope) {
      return {
        principal: PRINCIPAL,
        approvalId,
        threadId: envelope.threadId,
        envelopeDigest: digestApprovalEnvelope(envelope),
      };
    }
    const authenticator = {
      authenticateAndConsume(context: SlackV0RequestApprovalContext) {
        const handle = context.authenticationHandle ?? "";
        const authenticated = contexts.get(handle);
        if (!authenticated) throw new Error("synthetic context missing or replayed");
        contexts.delete(handle);
        return authenticated;
      },
    } as SlackV0ApprovalContextAuthenticator;
    const issueWith = async (
      signer: ApprovalSigner,
      verifier: PinnedApprovalSignatureVerifier,
    ): Promise<ApprovalReceipt> => {
      sequence += 1;
      const envelope = syntheticEnvelope(sequence);
      const approvalId = `synthetic-approval-${sequence}`;
      const handle = `synthetic-context-${sequence}`;
      contexts.set(handle, authenticatedContext(approvalId, envelope));
      return new SlackApprovalIssuer(authenticator, signer, verifier, audit, () => NOW).create(
        {
          authenticationHandle: handle,
          rawBody: new Uint8Array(),
          slackRequestTimestamp: "synthetic",
          slackSignature: "synthetic",
        },
        { approvalId, ttlMs: 300_000, envelope },
      );
    };

    const oldReceipt = await issueWith(signerFor("synthetic-old", oldPair.privateKey), oldVerifier);
    const newReceipt = await issueWith(signerFor("synthetic-new", newPair.privateKey), newVerifier);
    const revokedOldReceipt = await issueWith(
      signerFor("synthetic-old", oldPair.privateKey),
      oldVerifier,
    );

    // This JSON round-trip is the executor hand-off. No provider adapter, network,
    // credential lookup, or send capability exists anywhere in this harness.
    const wireReceipt = JSON.parse(JSON.stringify(newReceipt)) as ApprovalReceipt;
    expect(Object.keys(wireReceipt).sort()).toEqual(["claims", "signature"]);
    expect(Object.keys(wireReceipt.claims).sort()).toEqual([
      "approvalId",
      "envelope",
      "expiresAt",
      "issuedAt",
      "keyId",
      "principal",
      "version",
    ]);
    expect(serializeApprovalClaims(wireReceipt.claims)).toBe(
      serializeApprovalClaims(newReceipt.claims),
    );

    expect(() => new PinnedApprovalVerifierSet([])).toThrow("At least one");
    expect(() => new PinnedApprovalVerifierSet([oldVerifier, oldVerifier])).toThrow("Duplicate");
    const overlap = new RotatingApprovalReceiptVerifier(
      PRINCIPAL,
      new PinnedApprovalVerifierSet([oldVerifier, newVerifier]),
      audit,
      () => NOW,
    );
    expect(() =>
      overlap.verifyAndConsume(oldReceipt, {
        approvalId: oldReceipt.claims.approvalId,
        envelope: oldReceipt.claims.envelope,
      }),
    ).not.toThrow();
    expect(() =>
      overlap.verifyAndConsume(wireReceipt, {
        approvalId: wireReceipt.claims.approvalId,
        envelope: wireReceipt.claims.envelope,
      }),
    ).not.toThrow();

    const afterRevocation = new RotatingApprovalReceiptVerifier(
      PRINCIPAL,
      new PinnedApprovalVerifierSet([newVerifier]),
      audit,
      () => NOW,
    );
    expect(() =>
      afterRevocation.verifyAndConsume(revokedOldReceipt, {
        approvalId: revokedOldReceipt.claims.approvalId,
        envelope: revokedOldReceipt.claims.envelope,
      }),
    ).toThrow("not in the pinned verifier set");

    const health = audit.health(NOW);
    expect(health).toEqual({
      status: "ok",
      checkedAt: NOW.toISOString(),
      pending: 0,
      stalePending: 0,
      active: 1,
      cancelled: 0,
      expired: 0,
      consumed: 2,
    });
    expect(JSON.stringify(health)).not.toContain("synthetic rendered body");
    expect(JSON.stringify(health)).not.toContain("recipient@example.test");
    audit.close();
  });
});
