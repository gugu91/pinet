import { createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { ATTESTATION_KIND, RECEIPT_KIND, type ExecuteRequest } from "./contracts.js";
import { attestationSigningBytes, receiptSigningBytes } from "./canonical.js";

export interface TrustPolicy {
  readonly issuerKeyId: string;
  readonly issuerPublicKeyPem: string;
  readonly expectedUserId: string;
  readonly processInstanceId: string;
  readonly now?: Date;
}
function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function verifyRequest(request: ExecuteRequest, policy: TrustPolicy): void {
  const { receipt, attestation } = request;
  if (receipt.kind !== RECEIPT_KIND || attestation.kind !== ATTESTATION_KIND)
    throw new Error("unsupported_contract");
  if (
    !sameText(receipt.issuerKeyId, policy.issuerKeyId) ||
    !sameText(attestation.issuerKeyId, policy.issuerKeyId)
  )
    throw new Error("untrusted_issuer");
  const key = createPublicKey(policy.issuerPublicKeyPem);
  if (!verify(null, receiptSigningBytes(receipt), key, Buffer.from(receipt.signature, "base64")))
    throw new Error("forged_receipt");
  if (
    !verify(
      null,
      attestationSigningBytes(attestation),
      key,
      Buffer.from(attestation.signature, "base64"),
    )
  )
    throw new Error("forged_attestation");
  const now = (policy.now ?? new Date()).getTime();
  const issuedAt = Date.parse(receipt.issuedAt);
  const expiresAt = Date.parse(receipt.expiresAt);
  const attestedAt = Date.parse(attestation.attestedAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt >= expiresAt)
    throw new Error("invalid_receipt_window");
  if (now < issuedAt || now > expiresAt) throw new Error("expired_receipt");
  if (
    !Number.isFinite(attestedAt) ||
    attestedAt < issuedAt ||
    attestedAt > expiresAt ||
    attestedAt > now + 30_000 ||
    now - attestedAt > 5 * 60_000
  )
    throw new Error("stale_attestation");
  if (attestation.receiptId !== receipt.id) throw new Error("receipt_mismatch");
  if (
    !sameText(receipt.approved.expectedUserId, policy.expectedUserId) ||
    !sameText(attestation.userId, policy.expectedUserId)
  )
    throw new Error("wrong_user");
  if (!sameText(attestation.processInstanceId, policy.processInstanceId))
    throw new Error("wrong_process");
}
