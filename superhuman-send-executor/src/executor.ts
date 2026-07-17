import {
  serializeApprovalClaims,
  type ApprovalEnvelope,
  type ApprovalReceipt,
  type RotatingApprovalReceiptVerifier,
} from "@pinet/broker-core/approval-receipts";
import { createHash } from "node:crypto";
import type { ExecutionStatus } from "./contracts.js";
import type { Journal } from "./journal.js";

export interface RenderedDraft {
  readonly revisionId: string;
  readonly envelope: ApprovalEnvelope;
}
export class ProviderPreSendRejection extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProviderPreSendRejection";
  }
}
export interface Provider {
  render(accountId: string, draftId: string): Promise<RenderedDraft>;
  send(
    accountId: string,
    draftId: string,
    revisionId: string,
    draftFingerprint: string,
  ): Promise<{ messageId: string }>;
}
export interface AuditSink {
  write(record: {
    receiptId: string;
    receiptHash: string;
    state: ExecutionStatus["state"];
    at: string;
    errorCode?: string;
  }): void;
}
export class Executor {
  readonly #inflight = new Map<
    string,
    { readonly receiptHash: string; readonly execution: Promise<ExecutionStatus> }
  >();
  constructor(
    private readonly journal: Journal,
    private readonly provider: Provider,
    private readonly verifier: RotatingApprovalReceiptVerifier,
    private readonly audit: AuditSink,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async execute(receipt: ApprovalReceipt): Promise<ExecutionStatus> {
    const key = receipt.claims.approvalId;
    const receiptHash = createHash("sha256")
      .update(serializeApprovalClaims(receipt.claims))
      .update("\n")
      .update(receipt.signature)
      .digest("hex");
    const active = this.#inflight.get(key);
    if (active) {
      if (active.receiptHash !== receiptHash) throw new Error("receipt_id_conflict");
      return await active.execution;
    }
    const execution = this.executeOnce(receipt, receiptHash).finally(() =>
      this.#inflight.delete(key),
    );
    this.#inflight.set(key, { receiptHash, execution });
    return await execution;
  }
  private async executeOnce(
    receipt: ApprovalReceipt,
    receiptHash: string,
  ): Promise<ExecutionStatus> {
    const prior = this.journal.entry(receipt.claims.approvalId);
    if (prior) {
      if (prior.receiptHash !== receiptHash) throw new Error("receipt_id_conflict");
      return prior.status;
    }
    this.verifier.verify(receipt, {
      approvalId: receipt.claims.approvalId,
      envelope: receipt.claims.envelope,
    });
    this.journal.assertActive(receipt, this.now().toISOString());
    if (
      receipt.claims.envelope.action !== "send" ||
      receipt.claims.envelope.provider !== "superhuman" ||
      receipt.claims.envelope.delayMs !== 0 ||
      receipt.claims.envelope.scheduledFor !== null
    )
      throw new Error("unsupported_execution_semantics");
    const draft = await this.provider.render(
      receipt.claims.envelope.accountId,
      receipt.claims.envelope.draftId,
    );
    this.verifier.verify(receipt, {
      approvalId: receipt.claims.approvalId,
      envelope: draft.envelope,
    });
    const claim = this.journal.consumeAndClaim(receipt, receiptHash, this.now().toISOString());
    if (!claim.inserted) return claim.status;
    let providerResult: { readonly messageId: string } | undefined;
    let providerError: Error | undefined;
    try {
      providerResult = await this.provider.send(
        draft.envelope.accountId,
        draft.envelope.draftId,
        draft.revisionId,
        draft.envelope.draftFingerprint,
      );
    } catch (error) {
      providerError = error instanceof Error ? error : new Error("provider_outcome_unknown");
    }
    let status: ExecutionStatus;
    if (providerResult) {
      status = this.journal.finish(
        receipt.claims.approvalId,
        "sent",
        this.now().toISOString(),
        providerResult.messageId,
      );
    } else if (providerError instanceof ProviderPreSendRejection) {
      status = this.journal.finish(
        receipt.claims.approvalId,
        "failed",
        this.now().toISOString(),
        providerError.code,
      );
    } else {
      status = this.journal.finish(
        receipt.claims.approvalId,
        "unknown",
        this.now().toISOString(),
        "provider_outcome_unknown",
      );
    }
    try {
      this.audit.write({
        receiptId: receipt.claims.approvalId,
        receiptHash,
        state: status.state,
        at: status.updatedAt,
        ...(status.errorCode ? { errorCode: status.errorCode } : {}),
      });
    } catch {
      // SQLite audit_transitions is canonical; JSONL is a repairable bounded mirror.
    }
    return status;
  }
  status(receiptId: string): ExecutionStatus | undefined {
    return this.journal.status(receiptId);
  }
}
