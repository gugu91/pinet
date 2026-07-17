import type { ApprovalReceipt } from "@pinet/broker-core/approval-receipts";

export interface ExecuteRequest {
  readonly receipt: ApprovalReceipt;
}
export type ExecutionState = "claimed" | "sent" | "failed" | "unknown";
export interface ExecutionStatus {
  readonly receiptId: string;
  readonly state: ExecutionState;
  readonly updatedAt: string;
  readonly providerMessageId?: string;
  readonly errorCode?: string;
}
