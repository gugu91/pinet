import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  attestationSigningBytes,
  receiptSigningBytes,
  sha256,
} from "./src/canonical.js";
import {
  ATTESTATION_KIND,
  RECEIPT_KIND,
  type ApprovalAttestation,
  type ApprovalReceipt,
  type ExecuteRequest,
} from "./src/contracts.js";
import { Executor, type Provider } from "./src/executor.js";
import { Journal } from "./src/journal.js";
import { verifyRequest, type TrustPolicy } from "./src/verify.js";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(overrides?: {
  expiresAt?: string;
  userId?: string;
  processId?: string;
  draftHash?: string;
}): { request: ExecuteRequest; policy: TrustPolicy } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const rendered = { to: ["recipient@example.test"], subject: "Approved", body: "secret body" };
  const receiptBase = {
    kind: RECEIPT_KIND,
    id: "receipt-1",
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: overrides?.expiresAt ?? "2027-01-01T00:00:00.000Z",
    issuerKeyId: "issuer-root-1",
    approved: {
      accountId: "acct",
      draftId: "draft",
      expectedUserId: "user-1",
      renderedSha256: overrides?.draftHash ?? sha256(canonicalJson(rendered)),
    },
  };
  const unsignedReceipt = { ...receiptBase, signature: "" } as ApprovalReceipt;
  const receipt = {
    ...unsignedReceipt,
    signature: sign(null, receiptSigningBytes(unsignedReceipt), privateKey).toString("base64"),
  };
  const attBase = {
    kind: ATTESTATION_KIND,
    receiptId: receipt.id,
    processInstanceId: overrides?.processId ?? "executor-1",
    userId: overrides?.userId ?? "user-1",
    attestedAt: "2026-06-01T00:00:00.000Z",
    issuerKeyId: "issuer-root-1",
  };
  const unsignedAttestation = { ...attBase, signature: "" } as ApprovalAttestation;
  const attestation = {
    ...unsignedAttestation,
    signature: sign(null, attestationSigningBytes(unsignedAttestation), privateKey).toString(
      "base64",
    ),
  };
  return {
    request: { receipt, attestation },
    policy: {
      issuerKeyId: "issuer-root-1",
      issuerPublicKeyPem: publicPem,
      expectedUserId: "user-1",
      processInstanceId: "executor-1",
      now: new Date("2026-06-01"),
    },
  };
}
function harness(input = fixture()): {
  executor: Executor;
  provider: { sends: number };
  request: ExecuteRequest;
} {
  const dir = mkdtempSync(join(tmpdir(), "executor-"));
  dirs.push(dir);
  const counter = { sends: 0 };
  const provider: Provider = {
    async render() {
      return {
        accountId: "acct",
        draftId: "draft",
        userId: "user-1",
        revisionId: "revision-1",
        rendered: { to: ["recipient@example.test"], subject: "Approved", body: "secret body" },
      };
    },
    async send() {
      counter.sends++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { messageId: "msg-1" };
    },
  };
  return {
    executor: new Executor(new Journal(join(dir, "journal.db")), provider, input.policy, {
      write() {},
    }),
    provider: counter,
    request: input.request,
  };
}
describe("request verification", () => {
  it("rejects forged receipts and attestations", () => {
    const a = fixture();
    const forgedReceipt = {
      ...a.request,
      receipt: { ...a.request.receipt, signature: Buffer.alloc(64).toString("base64") },
    };
    expect(() => verifyRequest(forgedReceipt, a.policy)).toThrow("forged_receipt");
    const b = fixture();
    const forgedAttestation = {
      ...b.request,
      attestation: { ...b.request.attestation, signature: Buffer.alloc(64).toString("base64") },
    };
    expect(() => verifyRequest(forgedAttestation, b.policy)).toThrow("forged_attestation");
  });
  it("rejects expired, wrong-user, and cross-process approvals", () => {
    for (const [value, message] of [
      [fixture({ expiresAt: "2026-05-01T00:00:00Z" }), "expired_receipt"],
      [fixture({ userId: "other" }), "wrong_user"],
      [fixture({ processId: "other" }), "wrong_process"],
    ] as const)
      expect(() => verifyRequest(value.request, value.policy)).toThrow(message);
  });
});
describe("executor", () => {
  it("sends at most once under replay and cross-process races", async () => {
    const h = harness();
    const statuses = await Promise.all(
      Array.from({ length: 12 }, () => h.executor.execute(h.request)),
    );
    expect(h.provider.sends).toBe(1);
    expect(statuses.some((s) => s.state === "sent")).toBe(true);
    expect((await h.executor.execute(h.request)).state).toBe("sent");
    expect(h.provider.sends).toBe(1);
  });
  it("serializes independent journal connections racing the same receipt", async () => {
    const input = fixture();
    const dir = mkdtempSync(join(tmpdir(), "executor-"));
    dirs.push(dir);
    const path = join(dir, "journal.db");
    let sends = 0;
    const provider: Provider = {
      async render() {
        return {
          accountId: "acct",
          draftId: "draft",
          userId: "user-1",
          revisionId: "revision-1",
          rendered: { to: ["recipient@example.test"], subject: "Approved", body: "secret body" },
        };
      },
      async send() {
        sends++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { messageId: "msg-1" };
      },
    };
    const executors = Array.from(
      { length: 8 },
      () => new Executor(new Journal(path), provider, input.policy, { write() {} }),
    );
    await Promise.all(executors.map((executor) => executor.execute(input.request)));
    expect(sends).toBe(1);
  });
  it("refuses a rerender mismatch before claiming or sending", async () => {
    const input = fixture({ draftHash: "0".repeat(64) });
    const h = harness(input);
    await expect(h.executor.execute(h.request)).rejects.toThrow("render_mismatch");
    expect(h.provider.sends).toBe(0);
    expect(h.executor.status("receipt-1")).toBeUndefined();
  });
  it("reports unknown and never retries an ambiguous provider outcome", async () => {
    const input = fixture();
    const dir = mkdtempSync(join(tmpdir(), "executor-"));
    dirs.push(dir);
    let sends = 0;
    const provider: Provider = {
      async render() {
        return {
          accountId: "acct",
          draftId: "draft",
          userId: "user-1",
          revisionId: "revision-1",
          rendered: { to: ["recipient@example.test"], subject: "Approved", body: "secret body" },
        };
      },
      async send() {
        sends++;
        throw new Error("socket closed");
      },
    };
    const executor = new Executor(new Journal(join(dir, "journal.db")), provider, input.policy, {
      write() {},
    });
    expect((await executor.execute(input.request)).state).toBe("unknown");
    expect((await executor.execute(input.request)).state).toBe("unknown");
    expect(sends).toBe(1);
  });
  it("converts an interrupted durable claim to truthful unknown on restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "executor-"));
    dirs.push(dir);
    new Journal(join(dir, "journal.db")).claim("r", "h", new Date().toISOString());
    const restarted = new Journal(join(dir, "journal.db"));
    expect(restarted.status("r")?.state).toBe("unknown");
    expect(restarted.auditStates("r")).toEqual(["claimed", "unknown"]);
  });
});
