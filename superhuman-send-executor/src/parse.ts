import type { ApprovalEnvelope, ApprovalReceipt } from "@pinet/broker-core/approval-receipts";
import type { ExecuteRequest } from "./contracts.js";

interface JsonObject {
  readonly [key: string]: JsonValue;
}
type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
function objectAt(value: JsonValue, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object")
    throw new Error(`invalid_${label}`);
  return value as JsonObject;
}
function textAt(value: JsonValue | undefined, label: string, max = 8192): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new Error(`invalid_${label}`);
  return value;
}
function textsAt(value: JsonValue | undefined, label: string, maxItems = 100): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`invalid_${label}`);
  return value.map((child, index) => textAt(child, `${label}_${index}`, 512));
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
  exactKeys(root, ["receipt"], "request");
  const receiptObject = objectAt(root.receipt, "receipt");
  exactKeys(receiptObject, ["claims", "signature"], "receipt");
  const claims = objectAt(receiptObject.claims, "claims");
  exactKeys(
    claims,
    ["version", "keyId", "approvalId", "principal", "issuedAt", "expiresAt", "envelope"],
    "claims",
  );
  const envelopeObject = objectAt(claims.envelope, "envelope");
  exactKeys(
    envelopeObject,
    [
      "accountId",
      "threadId",
      "draftId",
      "draftFingerprint",
      "attestation",
      "payload",
      "recipients",
      "rendererBuild",
      "screenshotDigests",
      "sendId",
      "delayMs",
      "scheduledFor",
      "action",
      "provider",
    ],
    "envelope",
  );
  const recipients = objectAt(envelopeObject.recipients, "recipients");
  exactKeys(recipients, ["to", "cc", "bcc"], "recipients");
  if (!Number.isSafeInteger(envelopeObject.delayMs) || (envelopeObject.delayMs as number) < 0)
    throw new Error("invalid_delay_ms");
  const envelope: ApprovalEnvelope = {
    accountId: textAt(envelopeObject.accountId, "account_id", 128),
    threadId: textAt(envelopeObject.threadId, "thread_id", 128),
    draftId: textAt(envelopeObject.draftId, "draft_id", 128),
    draftFingerprint: textAt(envelopeObject.draftFingerprint, "draft_fingerprint", 71),
    attestation: textAt(envelopeObject.attestation, "attestation", 71),
    payload: textAt(envelopeObject.payload, "payload", 128 * 1024),
    recipients: {
      to: textsAt(recipients.to, "to"),
      cc: textsAt(recipients.cc, "cc"),
      bcc: textsAt(recipients.bcc, "bcc"),
    },
    rendererBuild: textAt(envelopeObject.rendererBuild, "renderer_build", 256),
    screenshotDigests: textsAt(envelopeObject.screenshotDigests, "screenshot_digests", 32),
    sendId: textAt(envelopeObject.sendId, "send_id", 128),
    delayMs: envelopeObject.delayMs as number,
    scheduledFor:
      envelopeObject.scheduledFor === null
        ? null
        : textAt(envelopeObject.scheduledFor, "scheduled_for", 64),
    action: textAt(envelopeObject.action, "action", 128),
    provider: textAt(envelopeObject.provider, "provider", 128),
  };
  const receipt: ApprovalReceipt = {
    claims: {
      version: textAt(claims.version, "version", 64) as ApprovalReceipt["claims"]["version"],
      keyId: textAt(claims.keyId, "key_id", 128),
      approvalId: textAt(claims.approvalId, "approval_id", 128),
      principal: textAt(claims.principal, "principal", 128),
      issuedAt: textAt(claims.issuedAt, "issued_at", 64),
      expiresAt: textAt(claims.expiresAt, "expires_at", 64),
      envelope,
    },
    signature: textAt(receiptObject.signature, "signature", 128),
  };
  return { receipt };
}

export interface ParsedTrustPolicy {
  readonly expectedPrincipal: string;
  readonly brokerCoreVersion: string;
  readonly callerGid: number;
  readonly approvalAuditPath: string;
  readonly pinnedIssuerKeys: readonly { readonly keyId: string; readonly publicKeyPem: string }[];
}
export function parseTrustPolicy(value: JsonValue): ParsedTrustPolicy {
  const root = objectAt(value, "trust_policy");
  exactKeys(
    root,
    [
      "expectedPrincipal",
      "brokerCoreVersion",
      "callerGid",
      "approvalAuditPath",
      "pinnedIssuerKeys",
    ],
    "trust_policy",
  );
  if (!Number.isSafeInteger(root.callerGid) || (root.callerGid as number) < 1)
    throw new Error("invalid_caller_gid");
  if (
    !Array.isArray(root.pinnedIssuerKeys) ||
    root.pinnedIssuerKeys.length < 1 ||
    root.pinnedIssuerKeys.length > 2
  )
    throw new Error("invalid_pinned_issuer_keys");
  const pinnedIssuerKeys = root.pinnedIssuerKeys.map((entry, index) => {
    const key = objectAt(entry, `issuer_key_${index}`);
    exactKeys(key, ["keyId", "publicKeyPem"], `issuer_key_${index}`);
    return {
      keyId: textAt(key.keyId, "issuer_key_id", 128),
      publicKeyPem: textAt(key.publicKeyPem, "issuer_public_key", 8192),
    };
  });
  return {
    expectedPrincipal: textAt(root.expectedPrincipal, "expected_principal", 128),
    brokerCoreVersion: textAt(root.brokerCoreVersion, "broker_core_version", 32),
    callerGid: root.callerGid as number,
    approvalAuditPath: textAt(root.approvalAuditPath, "approval_audit_path", 512),
    pinnedIssuerKeys,
  };
}

export function parseRenderedDraft(value: JsonValue): {
  readonly revisionId: string;
  readonly envelope: ApprovalEnvelope;
} {
  const root = objectAt(value, "rendered_draft");
  exactKeys(root, ["revisionId", "envelope"], "rendered_draft");
  const synthetic = parseExecuteRequest({
    receipt: {
      claims: {
        version: "shm-approval-receipt/v1",
        keyId: "render",
        approvalId: "render",
        principal: "render",
        issuedAt: "1970-01-01T00:00:00.000Z",
        expiresAt: "1970-01-01T00:00:01.000Z",
        envelope: root.envelope,
      },
      signature: "render",
    },
  });
  return {
    revisionId: textAt(root.revisionId, "provider_revision_id", 128),
    envelope: synthetic.receipt.claims.envelope,
  };
}
export function parseSendResult(value: JsonValue): { readonly messageId: string } {
  const root = objectAt(value, "send_result");
  exactKeys(root, ["messageId"], "send_result");
  return { messageId: textAt(root.messageId, "provider_message_id", 256) };
}
