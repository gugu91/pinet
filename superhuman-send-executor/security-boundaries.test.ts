import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlAudit } from "./src/audit.js";
import {
  attestationSigningBytes,
  canonicalJson,
  receiptSigningBytes,
  sha256,
} from "./src/canonical.js";
import {
  ATTESTATION_KIND,
  RECEIPT_KIND,
  type ApprovalAttestation,
  type ApprovalReceipt,
} from "./src/contracts.js";
import { Journal } from "./src/journal.js";
import { parseExecuteRequest, parseJson, parseSendResult, parseTrustPolicy } from "./src/parse.js";
import { verifyRequest } from "./src/verify.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("strict external boundaries", () => {
  it("rejects extra request fields and malformed helper success", () => {
    expect(() =>
      parseExecuteRequest(parseJson('{"receipt":{},"attestation":{},"url":"x"}')),
    ).toThrow("invalid_request_fields");
    expect(() => parseSendResult(parseJson("{}"))).toThrow("invalid_send_result_fields");
  });
  it("requires a bounded caller group in the pinned trust policy", () => {
    expect(() =>
      parseTrustPolicy(
        parseJson(
          JSON.stringify({
            issuerKeyId: "k",
            issuerPublicKeyPem: "pem",
            expectedUserId: "u",
            processInstanceId: "p",
            brokerCoreVersion: "0.2.4",
            callerGid: 0,
          }),
        ),
      ),
    ).toThrow("invalid_caller_gid");
  });
  it("rejects malformed expiry even when the signature is valid", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const unsigned = {
      kind: RECEIPT_KIND,
      id: "r",
      issuedAt: "2026-06-01T00:00:00Z",
      expiresAt: "not-a-date",
      issuerKeyId: "k",
      approved: {
        accountId: "a",
        draftId: "d",
        expectedUserId: "u",
        renderedSha256: "0".repeat(64),
      },
      signature: "",
    } as ApprovalReceipt;
    const receipt = {
      ...unsigned,
      signature: sign(null, receiptSigningBytes(unsigned), privateKey).toString("base64"),
    };
    const unsignedAttestation = {
      kind: ATTESTATION_KIND,
      receiptId: "r",
      processInstanceId: "p",
      userId: "u",
      attestedAt: "2026-06-01T00:00:00Z",
      issuerKeyId: "k",
      signature: "",
    } as ApprovalAttestation;
    const attestation = {
      ...unsignedAttestation,
      signature: sign(null, attestationSigningBytes(unsignedAttestation), privateKey).toString(
        "base64",
      ),
    };
    expect(() =>
      verifyRequest(
        {
          receipt,
          attestation,
        },
        {
          issuerKeyId: "k",
          issuerPublicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
          expectedUserId: "u",
          processInstanceId: "p",
          now: new Date("2026-06-01T00:00:00Z"),
        },
      ),
    ).toThrow("invalid_receipt_window");
  });
});
describe("canonical journal identity", () => {
  it("refuses receipt-id reuse with a different signed receipt hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "journal-"));
    dirs.push(dir);
    const journal = new Journal(join(dir, "journal.db"));
    expect(
      journal.claim("r", sha256(canonicalJson({ value: 1 })), new Date().toISOString()).inserted,
    ).toBe(true);
    expect(() =>
      journal.claim("r", sha256(canonicalJson({ value: 2 })), new Date().toISOString()),
    ).toThrow("receipt_id_conflict");
  });
  it("canonicalizes nested objects in arrays deterministically", () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: true })).toBe('{"a":true,"z":[{"a":1,"b":2}]}');
  });
  it("writes a bounded body-free audit schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    dirs.push(dir);
    const path = join(dir, "audit.jsonl");
    new JsonlAudit(path).write({
      receiptId: "receipt-1",
      receiptHash: "a".repeat(64),
      state: "sent",
      at: "2026-06-01T00:00:00Z",
    });
    const record: object = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(record).sort()).toEqual(["at", "receiptHash", "receiptId", "state"]);
    expect(readFileSync(path, "utf8")).not.toContain("body");
  });
});
