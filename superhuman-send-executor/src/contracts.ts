export const RECEIPT_KIND = "shm-approval-receipt/v1" as const;
export const ATTESTATION_KIND = "shm-approval-attestation/v1" as const;

export interface ApprovedMessage {
  readonly accountId: string;
  readonly draftId: string;
  readonly expectedUserId: string;
  readonly renderedSha256: string;
}
export interface ApprovalReceipt {
  readonly kind: typeof RECEIPT_KIND;
  readonly id: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly issuerKeyId: string;
  readonly approved: ApprovedMessage;
  readonly signature: string;
}
export interface ApprovalAttestation {
  readonly kind: typeof ATTESTATION_KIND;
  readonly receiptId: string;
  readonly processInstanceId: string;
  readonly userId: string;
  readonly attestedAt: string;
  readonly issuerKeyId: string;
  readonly signature: string;
}
export interface ExecuteRequest {
  readonly receipt: ApprovalReceipt;
  readonly attestation: ApprovalAttestation;
}
export type ExecutionState = "claimed" | "sent" | "failed" | "unknown";
export interface ExecutionStatus {
  readonly receiptId: string;
  readonly state: ExecutionState;
  readonly updatedAt: string;
  readonly providerMessageId?: string;
  readonly errorCode?: string;
}
