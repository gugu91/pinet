import { createHash } from "node:crypto";
import type { ApprovalAttestation, ApprovalReceipt } from "./contracts.js";

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | CanonicalObject;
interface CanonicalObject {
  readonly [key: string]: CanonicalValue;
}
function canonicalize(value: CanonicalValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non_finite_canonical_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((child) => canonicalize(child)).join(",")}]`;
  const object = value as CanonicalObject;
  return `{${Object.keys(object)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key] as CanonicalValue)}`)
    .join(",")}}`;
}
export function canonicalJson(value: object): string {
  return canonicalize(value as CanonicalObject);
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
