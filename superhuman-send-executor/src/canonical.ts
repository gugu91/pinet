import { createHash } from "node:crypto";
import type { ApprovalAttestation, ApprovalReceipt } from "./contracts.js";

function sortValue(value: object): object {
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [
        key,
        child !== null && typeof child === "object" && !Array.isArray(child)
          ? sortValue(child as object)
          : child,
      ]),
  );
}
export function canonicalJson(value: object): string {
  return JSON.stringify(sortValue(value));
}
export function receiptSigningBytes(receipt: ApprovalReceipt): Buffer {
  const { signature, ...unsigned } = receipt;
  void signature;
  return Buffer.from(canonicalJson(unsigned));
}
export function attestationSigningBytes(attestation: ApprovalAttestation): Buffer {
  const { signature, ...unsigned } = attestation;
  void signature;
  return Buffer.from(canonicalJson(unsigned));
}
export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
