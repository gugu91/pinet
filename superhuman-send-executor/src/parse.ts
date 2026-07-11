import type {
  ATTESTATION_KIND,
  RECEIPT_KIND,
  ApprovalAttestation,
  ApprovalReceipt,
  ExecuteRequest,
} from "./contracts.js";

interface JsonObject {
  readonly [key: string]: JsonValue;
}
type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

function objectAt(value: JsonValue, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object")
    throw new Error(`invalid_${label}`);
  return value as JsonObject;
}
function textAt(value: JsonValue | undefined, label: string, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new Error(`invalid_${label}`);
  return value;
}
function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    throw new Error(`invalid_${label}_fields`);
}
export function parseJson(text: string): JsonValue {
  const parsed: JsonValue = JSON.parse(text);
  return parsed;
}
export function parseExecuteRequest(value: JsonValue): ExecuteRequest {
  const root = objectAt(value, "request");
  exactKeys(root, ["receipt", "attestation"], "request");
  const receiptObject = objectAt(root.receipt, "receipt");
  exactKeys(
    receiptObject,
    ["kind", "id", "issuedAt", "expiresAt", "issuerKeyId", "approved", "signature"],
    "receipt",
  );
  const approvedObject = objectAt(receiptObject.approved, "approved");
  exactKeys(
    approvedObject,
    ["accountId", "draftId", "expectedUserId", "renderedSha256"],
    "approved",
  );
  const receipt: ApprovalReceipt = {
    kind: textAt(receiptObject.kind, "receipt_kind") as typeof RECEIPT_KIND,
    id: textAt(receiptObject.id, "receipt_id", 128),
    issuedAt: textAt(receiptObject.issuedAt, "issued_at", 64),
    expiresAt: textAt(receiptObject.expiresAt, "expires_at", 64),
    issuerKeyId: textAt(receiptObject.issuerKeyId, "issuer_key_id", 128),
    approved: {
      accountId: textAt(approvedObject.accountId, "account_id", 128),
      draftId: textAt(approvedObject.draftId, "draft_id", 128),
      expectedUserId: textAt(approvedObject.expectedUserId, "expected_user_id", 128),
      renderedSha256: textAt(approvedObject.renderedSha256, "rendered_sha256", 64),
    },
    signature: textAt(receiptObject.signature, "receipt_signature", 256),
  };
  const attestationObject = objectAt(root.attestation, "attestation");
  exactKeys(
    attestationObject,
    ["kind", "receiptId", "processInstanceId", "userId", "attestedAt", "issuerKeyId", "signature"],
    "attestation",
  );
  const attestation: ApprovalAttestation = {
    kind: textAt(attestationObject.kind, "attestation_kind") as typeof ATTESTATION_KIND,
    receiptId: textAt(attestationObject.receiptId, "attestation_receipt_id", 128),
    processInstanceId: textAt(attestationObject.processInstanceId, "process_instance_id", 128),
    userId: textAt(attestationObject.userId, "attestation_user_id", 128),
    attestedAt: textAt(attestationObject.attestedAt, "attested_at", 64),
    issuerKeyId: textAt(attestationObject.issuerKeyId, "attestation_key_id", 128),
    signature: textAt(attestationObject.signature, "attestation_signature", 256),
  };
  return { receipt, attestation };
}

export interface ParsedTrustPolicy {
  readonly issuerKeyId: string;
  readonly issuerPublicKeyPem: string;
  readonly expectedUserId: string;
  readonly processInstanceId: string;
  readonly brokerCoreVersion: string;
  readonly callerGid: number;
}
export function parseTrustPolicy(value: JsonValue): ParsedTrustPolicy {
  const root = objectAt(value, "trust_policy");
  exactKeys(
    root,
    [
      "issuerKeyId",
      "issuerPublicKeyPem",
      "expectedUserId",
      "processInstanceId",
      "brokerCoreVersion",
      "callerGid",
    ],
    "trust_policy",
  );
  if (!Number.isSafeInteger(root.callerGid) || (root.callerGid as number) < 1)
    throw new Error("invalid_caller_gid");
  return {
    issuerKeyId: textAt(root.issuerKeyId, "issuer_key_id", 128),
    issuerPublicKeyPem: textAt(root.issuerPublicKeyPem, "issuer_public_key", 8192),
    expectedUserId: textAt(root.expectedUserId, "expected_user_id", 128),
    processInstanceId: textAt(root.processInstanceId, "process_instance_id", 128),
    brokerCoreVersion: textAt(root.brokerCoreVersion, "broker_core_version", 32),
    callerGid: root.callerGid as number,
  };
}

export function parseRenderedDraft(value: JsonValue): {
  readonly accountId: string;
  readonly draftId: string;
  readonly userId: string;
  readonly revisionId: string;
  readonly rendered: JsonObject;
} {
  const root = objectAt(value, "rendered_draft");
  exactKeys(root, ["accountId", "draftId", "userId", "revisionId", "rendered"], "rendered_draft");
  return {
    accountId: textAt(root.accountId, "provider_account_id", 128),
    draftId: textAt(root.draftId, "provider_draft_id", 128),
    userId: textAt(root.userId, "provider_user_id", 128),
    revisionId: textAt(root.revisionId, "provider_revision_id", 128),
    rendered: objectAt(root.rendered, "provider_rendered"),
  };
}
export function parseSendResult(value: JsonValue): { readonly messageId: string } {
  const root = objectAt(value, "send_result");
  exactKeys(root, ["messageId"], "send_result");
  return { messageId: textAt(root.messageId, "provider_message_id", 256) };
}
