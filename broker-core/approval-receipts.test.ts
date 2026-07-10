import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalAuditStore,
  MAX_APPROVAL_TTL_MS,
  SlackApprovalIssuer,
  serializeApprovalClaims,
  verifyApprovalReceipt,
  type ApprovalClaims,
  type ApprovalEnvelope,
  type ApprovalSigner,
} from "./approval-receipts.js";

const THOMAS_SLACK_ID = "U0AF5S3LQ5C";

function envelope(overrides: Partial<ApprovalEnvelope> = {}): ApprovalEnvelope {
  return {
    accountId: "account-1",
    threadId: "thread-1",
    draftId: "draft-1",
    draftFingerprint: "sha256:draft",
    attestation: "sha256:attestation",
    payload: "complete rendered payload",
    recipients: ["recipient@example.com"],
    rendererBuild: "renderer@abc123",
    screenshotDigests: ["sha256:screenshot"],
    sendId: "send-1",
    delayMs: 60_000,
    scheduledFor: "2026-07-11T12:00:00.000Z",
    action: "email.send",
    provider: "superhuman",
    ...overrides,
  };
}

describe("SlackApprovalIssuer", () => {
  let directory: string;
  let audit: ApprovalAuditStore;
  let privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  let publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"];
  let signer: ApprovalSigner;
  let nowMs: number;
  let issuer: SlackApprovalIssuer;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "approval-receipts-"));
    audit = new ApprovalAuditStore(path.join(directory, "audit.db"));
    // Synthetic, process-local test key only. Production must use the external signer contract.
    ({ privateKey, publicKey } = generateKeyPairSync("ed25519"));
    signer = {
      issueApproval: async (claims: ApprovalClaims) => ({
        keyId: "test-root",
        signature: sign(null, Buffer.from(serializeApprovalClaims(claims)), privateKey).toString(
          "base64url",
        ),
      }),
    };
    nowMs = Date.parse("2026-07-11T10:00:00.000Z");
    issuer = new SlackApprovalIssuer(THOMAS_SLACK_ID, signer, audit, () => new Date(nowMs));
  });

  afterEach(() => {
    audit.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("issues a verifiable receipt bound to every envelope field", async () => {
    const receipt = await issuer.create({
      principal: THOMAS_SLACK_ID,
      approvalId: "approval-1",
      ttlMs: MAX_APPROVAL_TTL_MS,
      envelope: envelope(),
    });

    expect(
      verifyApprovalReceipt(receipt, publicKey.export({ type: "spki", format: "pem" }).toString()),
    ).toBe(true);
    expect(receipt.claims.expiresAt).toBe("2026-07-11T10:05:00.000Z");
    expect(issuer.status("approval-1", THOMAS_SLACK_ID)?.state).toBe("active");
  });

  it("rejects a forged receipt", async () => {
    const receipt = await issuer.create({
      principal: THOMAS_SLACK_ID,
      approvalId: "approval-1",
      ttlMs: 1_000,
      envelope: envelope(),
    });
    const forged = {
      ...receipt,
      claims: { ...receipt.claims, envelope: envelope({ action: "email.delete" }) },
    };
    expect(
      verifyApprovalReceipt(forged, publicKey.export({ type: "spki", format: "pem" }).toString()),
    ).toBe(false);
  });

  it("rejects wrong users and TTLs above five minutes", async () => {
    await expect(
      issuer.create({
        principal: "U_ATTACKER",
        approvalId: "approval-1",
        ttlMs: 1_000,
        envelope: envelope(),
      }),
    ).rejects.toThrow("not authorized");
    await expect(
      issuer.create({
        principal: THOMAS_SLACK_ID,
        approvalId: "approval-1",
        ttlMs: MAX_APPROVAL_TTL_MS + 1,
        envelope: envelope(),
      }),
    ).rejects.toThrow("ttlMs");
  });

  it("marks expired and cancelled approvals", async () => {
    await issuer.create({
      principal: THOMAS_SLACK_ID,
      approvalId: "approval-1",
      ttlMs: 1_000,
      envelope: envelope(),
    });
    nowMs += 1_001;
    expect(issuer.status("approval-1", THOMAS_SLACK_ID)?.state).toBe("expired");

    nowMs -= 1_001;
    expect(issuer.cancel("approval-1", THOMAS_SLACK_ID).state).toBe("cancelled");
    expect(issuer.cancel("approval-1", THOMAS_SLACK_ID).state).toBe("cancelled");
  });

  it("prevents replay by approval, send, and envelope identity", async () => {
    await issuer.create({
      principal: THOMAS_SLACK_ID,
      approvalId: "approval-1",
      ttlMs: 1_000,
      envelope: envelope(),
    });
    await expect(
      issuer.create({
        principal: THOMAS_SLACK_ID,
        approvalId: "approval-1",
        ttlMs: 1_000,
        envelope: envelope({ sendId: "send-2" }),
      }),
    ).rejects.toThrow();
    await expect(
      issuer.create({
        principal: THOMAS_SLACK_ID,
        approvalId: "approval-2",
        ttlMs: 1_000,
        envelope: envelope(),
      }),
    ).rejects.toThrow();
    await expect(
      issuer.create({
        principal: THOMAS_SLACK_ID,
        approvalId: "approval-3",
        ttlMs: 1_000,
        envelope: envelope({ sendId: "send-3" }),
      }),
    ).rejects.toThrow();
  });

  it("allows exactly one concurrent create for the same send", async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        issuer.create({
          principal: THOMAS_SLACK_ID,
          approvalId: `approval-${index}`,
          ttlMs: 1_000,
          envelope: envelope(),
        }),
      ),
    );
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(7);
  });

  it("does not persist payload or recipients in the audit database", async () => {
    await issuer.create({
      principal: THOMAS_SLACK_ID,
      approvalId: "approval-1",
      ttlMs: 1_000,
      envelope: envelope(),
    });
    const bytes = await import("node:fs").then(({ readFileSync }) =>
      readFileSync(path.join(directory, "audit.db"), "utf8"),
    );
    expect(bytes).not.toContain("complete rendered payload");
    expect(bytes).not.toContain("recipient@example.com");
  });
});
