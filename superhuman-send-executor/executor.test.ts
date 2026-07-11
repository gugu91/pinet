import {
  APPROVAL_SIGNATURE_ALGORITHM,
  ApprovalAuditStore,
  PinnedApprovalVerifierSet,
  RotatingApprovalReceiptVerifier,
  SlackApprovalIssuer,
  digestApprovalEnvelope,
  serializeApprovalClaims,
  type ApprovalEnvelope,
  type ApprovalReceipt,
  type PinnedApprovalSignatureVerifier,
  type SlackApprovalContextAuthenticator,
} from "@pinet/broker-core/approval-receipts";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Executor, ProviderPreSendRejection, type Provider } from "./src/executor.js";
import { Journal } from "./src/journal.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function fixture(options?: { principal?: string; now?: Date }): Promise<{
  receipt: ApprovalReceipt;
  envelope: ApprovalEnvelope;
  verifier: RotatingApprovalReceiptVerifier;
  pinned: PinnedApprovalSignatureVerifier;
  path: string;
  audit: ApprovalAuditStore;
}> {
  const dir = mkdtempSync(join(tmpdir(), "executor-"));
  dirs.push(dir);
  const path = join(dir, "journal.db");
  const audit = new ApprovalAuditStore(path);
  const pair = generateKeyPairSync("ed25519");
  const keyId = "issuer-1";
  const pinned: PinnedApprovalSignatureVerifier = {
    algorithm: APPROVAL_SIGNATURE_ALGORITHM,
    keyId,
    verify: (claims, signature) =>
      verify(null, Buffer.from(claims), pair.publicKey, Buffer.from(signature, "base64url")),
  };
  const envelope: ApprovalEnvelope = {
    accountId: "acct",
    threadId: "thread",
    draftId: "draft",
    draftFingerprint: `sha256:${"a".repeat(64)}`,
    attestation: `sha256:${"b".repeat(64)}`,
    payload: "secret body",
    recipients: { to: ["recipient@example.test"], cc: [], bcc: [] },
    rendererBuild: "renderer@1",
    screenshotDigests: [`sha256:${"c".repeat(64)}`],
    sendId: "send-1",
    delayMs: 0,
    scheduledFor: null,
    action: "send",
    provider: "superhuman",
  };
  const approvalId = "approval-1";
  const handle = "handle";
  const principal = options?.principal ?? "U0AF5S3LQ5C";
  const authenticator = {
    authenticateAndConsume() {
      return {
        principal,
        approvalId,
        threadId: envelope.threadId,
        envelopeDigest: digestApprovalEnvelope(envelope),
      };
    },
  } as SlackApprovalContextAuthenticator;
  const now = options?.now ?? new Date("2026-07-11T10:00:00.000Z");
  const issuer = new SlackApprovalIssuer(
    authenticator,
    {
      keyId,
      issueApproval: async (claims) => ({
        algorithm: APPROVAL_SIGNATURE_ALGORITHM,
        keyId,
        signature: sign(
          null,
          Buffer.from(serializeApprovalClaims(claims)),
          pair.privateKey,
        ).toString("base64url"),
      }),
    },
    pinned,
    audit,
    () => now,
  );
  const receipt = await issuer.create(
    {
      authenticationHandle: handle,
      rawBody: new Uint8Array(),
      slackRequestTimestamp: "test",
      slackSignature: "test",
    },
    { approvalId, ttlMs: 300_000, envelope },
  );
  return {
    receipt,
    envelope,
    path,
    audit,
    pinned,
    verifier: new RotatingApprovalReceiptVerifier(
      "U0AF5S3LQ5C",
      new PinnedApprovalVerifierSet([pinned]),
      audit,
      () => now,
    ),
  };
}
function provider(
  envelope: ApprovalEnvelope,
  behavior: "sent" | "unknown" | "failed" = "sent",
): Provider & { sends: number } {
  return {
    sends: 0,
    async render() {
      return { revisionId: "revision-1", envelope };
    },
    async send() {
      this.sends++;
      if (behavior === "unknown") throw new Error("socket closed");
      if (behavior === "failed") throw new ProviderPreSendRejection("precondition_rejected");
      return { messageId: "message-1" };
    },
  };
}
function executor(
  path: string,
  verifier: RotatingApprovalReceiptVerifier,
  adapter: Provider,
): Executor {
  return new Executor(new Journal(path), adapter, verifier, { write() {} });
}
describe("credential-free issuer-to-executor execution", () => {
  it("accepts the exact issuer receipt once and replays canonical sent status", async () => {
    const f = await fixture();
    const adapter = provider(f.envelope);
    const subject = executor(f.path, f.verifier, adapter);
    expect(
      (await subject.execute(JSON.parse(JSON.stringify(f.receipt)) as ApprovalReceipt)).state,
    ).toBe("sent");
    expect((await subject.execute(f.receipt)).state).toBe("sent");
    expect(adapter.sends).toBe(1);
  });
  it("serializes independent journal connections racing one receipt", async () => {
    const f = await fixture();
    const adapter = provider(f.envelope);
    const subjects = Array.from({ length: 8 }, () => executor(f.path, f.verifier, adapter));
    await Promise.all(subjects.map((subject) => subject.execute(f.receipt)));
    expect(adapter.sends).toBe(1);
  });
  it("rejects forged and mutated envelope fields before claiming", async () => {
    const f = await fixture();
    const forged = { ...f.receipt, signature: "A".repeat(86) };
    await expect(
      executor(f.path, f.verifier, provider(f.envelope)).execute(forged),
    ).rejects.toThrow();
    const mutated = { ...f.envelope, attestation: `sha256:${"d".repeat(64)}` };
    await expect(
      executor(f.path, f.verifier, provider(mutated)).execute(f.receipt),
    ).rejects.toThrow("attestation mismatch");
  });
  it("rejects wrong principal and expired approvals", async () => {
    const wrong = await fixture();
    const wrongPrincipalVerifier = new RotatingApprovalReceiptVerifier(
      "OTHER",
      new PinnedApprovalVerifierSet([wrong.pinned]),
      wrong.audit,
      () => new Date("2026-07-11T10:00:00.000Z"),
    );
    await expect(
      executor(wrong.path, wrongPrincipalVerifier, provider(wrong.envelope)).execute(wrong.receipt),
    ).rejects.toThrow("principal");
    const expired = await fixture();
    const lateVerifier = new RotatingApprovalReceiptVerifier(
      "U0AF5S3LQ5C",
      new PinnedApprovalVerifierSet([
        {
          algorithm: APPROVAL_SIGNATURE_ALGORITHM,
          keyId: expired.receipt.claims.keyId,
          verify: () => true,
        },
      ]),
      expired.audit,
      () => new Date("2026-07-11T10:06:00.000Z"),
    );
    await expect(
      executor(expired.path, lateVerifier, provider(expired.envelope)).execute(expired.receipt),
    ).rejects.toThrow("expired");
  });
  it("records definitive pre-send rejection as failed", async () => {
    const f = await fixture();
    const adapter = provider(f.envelope, "failed");
    expect((await executor(f.path, f.verifier, adapter).execute(f.receipt)).state).toBe("failed");
    expect(adapter.sends).toBe(1);
  });
  it("records ambiguous provider outcome as unknown and never retries", async () => {
    const f = await fixture();
    const adapter = provider(f.envelope, "unknown");
    const subject = executor(f.path, f.verifier, adapter);
    expect((await subject.execute(f.receipt)).state).toBe("unknown");
    expect((await subject.execute(f.receipt)).state).toBe("unknown");
    expect(adapter.sends).toBe(1);
  });
  it("recovers an interrupted durable claim to unknown with an atomic audit transition", async () => {
    const f = await fixture();
    const journal = new Journal(f.path);
    f.verifier.verify(f.receipt, { approvalId: f.receipt.claims.approvalId, envelope: f.envelope });
    journal.consumeAndClaim(f.receipt, "hash", new Date("2026-07-11T10:00:01.000Z").toISOString());
    journal.recoverInterruptedClaims();
    expect(journal.status(f.receipt.claims.approvalId)?.state).toBe("unknown");
    expect(journal.auditStates(f.receipt.claims.approvalId)).toEqual(["claimed", "unknown"]);
  });
});
