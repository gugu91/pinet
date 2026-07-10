import type { ExecuteRequest, ExecutionStatus } from "./contracts.js";
import { canonicalJson, sha256 } from "./canonical.js";
import type { Journal } from "./journal.js";
import { verifyRequest } from "./verify.js";
import type { TrustPolicy } from "./verify.js";

export interface RenderedDraft {
  readonly accountId: string;
  readonly draftId: string;
  readonly userId: string;
  readonly rendered: object;
}
export interface Provider {
  render(accountId: string, draftId: string): Promise<RenderedDraft>;
  send(accountId: string, draftId: string): Promise<{ messageId: string }>;
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
  constructor(
    private readonly journal: Journal,
    private readonly provider: Provider,
    private readonly policy: TrustPolicy,
    private readonly audit: AuditSink,
  ) {}
  async execute(request: ExecuteRequest): Promise<ExecutionStatus> {
    verifyRequest(request, this.policy);
    const receiptHash = sha256(canonicalJson(request.receipt));
    const prior = this.journal.status(request.receipt.id);
    if (prior) return prior;
    const draft = await this.provider.render(
      request.receipt.approved.accountId,
      request.receipt.approved.draftId,
    );
    if (
      draft.accountId !== request.receipt.approved.accountId ||
      draft.draftId !== request.receipt.approved.draftId ||
      draft.userId !== this.policy.expectedUserId ||
      sha256(canonicalJson(draft.rendered)) !== request.receipt.approved.renderedSha256
    )
      throw new Error("render_mismatch");
    const claim = this.journal.claim(request.receipt.id, receiptHash, new Date().toISOString());
    if (!claim.inserted) return claim.status;
    try {
      const sent = await this.provider.send(draft.accountId, draft.draftId);
      const status = this.journal.finish(
        request.receipt.id,
        "sent",
        new Date().toISOString(),
        sent.messageId,
      );
      this.audit.write({
        receiptId: request.receipt.id,
        receiptHash,
        state: status.state,
        at: status.updatedAt,
      });
      return status;
    } catch {
      const status = this.journal.finish(
        request.receipt.id,
        "unknown",
        new Date().toISOString(),
        "provider_outcome_unknown",
      );
      this.audit.write({
        receiptId: request.receipt.id,
        receiptHash,
        state: status.state,
        at: status.updatedAt,
        errorCode: "provider_outcome_unknown",
      });
      return status;
    }
  }
  status(receiptId: string): ExecutionStatus | undefined {
    return this.journal.status(receiptId);
  }
}
