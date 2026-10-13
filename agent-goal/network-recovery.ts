import { setTimeout as sleep } from "node:timers/promises";
import { probeGoalNetwork, type GoalNetworkTarget } from "./network-helpers.js";

export interface GoalNetworkRecoveryRequest {
  target: GoalNetworkTarget;
  canResume(): Promise<boolean>;
  resume(): Promise<"busy" | "cancelled" | "resumed">;
  stopped(reason: "cancelled" | "expired" | "resumed" | "failed"): void;
}

export class GoalNetworkRecovery {
  private waiting?: AbortController;
  private resumes = 0;

  constructor(
    private readonly probe = probeGoalNetwork,
    private readonly pause: (milliseconds: number, signal: AbortSignal) => Promise<void> = (
      milliseconds,
      signal,
    ) => sleep(milliseconds, undefined, { signal }),
    private readonly now = Date.now,
  ) {}

  start(request: GoalNetworkRecoveryRequest): boolean {
    this.cancel();
    if (this.resumes >= 20) return false;
    const controller = new AbortController();
    this.waiting = controller;
    void this.wait(request, controller);
    return true;
  }

  cancel(): void {
    this.waiting?.abort();
    this.waiting = undefined;
  }

  private async wait(
    request: GoalNetworkRecoveryRequest,
    controller: AbortController,
  ): Promise<void> {
    const deadline = this.now() + 30 * 60_000;
    let reason: Parameters<GoalNetworkRecoveryRequest["stopped"]>[0] = "cancelled";
    try {
      while (!controller.signal.aborted && this.now() < deadline) {
        await this.pause(15_000, controller.signal);
        if (this.now() >= deadline) {
          reason = "expired";
          return;
        }
        if (controller.signal.aborted || !(await request.canResume())) return;
        if (!(await this.probe(request.target, controller.signal))) continue;
        if (controller.signal.aborted || !(await request.canResume())) return;
        this.resumes += 1;
        const result = await request.resume();
        if (result === "busy") {
          this.resumes -= 1;
          continue;
        }
        if (result === "cancelled") return;
        reason = "resumed";
        return;
      }
      if (!controller.signal.aborted) reason = "expired";
    } catch (error) {
      if (!controller.signal.aborted) {
        reason = "failed";
        console.error(
          `[agent-goal] network recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      if (this.waiting === controller) this.waiting = undefined;
      request.stopped(reason);
    }
  }
}
