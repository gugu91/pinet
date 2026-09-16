import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { GoalEvent, GoalEventSink } from "./domain.js";

/**
 * Append-only JSONL diagnostics for goal lifecycle transitions. Opt in with
 * `PI_AGENT_GOAL_EVENT_LOG=<path>`; stalls can then be diagnosed from events instead of
 * reconstructing them from session transcripts.
 */
export class JsonlGoalEventSink implements GoalEventSink {
  private directoryReady = false;

  constructor(
    private readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(event: GoalEvent): void {
    if (!this.directoryReady) {
      mkdirSync(dirname(this.path), { recursive: true });
      this.directoryReady = true;
    }
    appendFileSync(this.path, `${JSON.stringify({ at: this.now().toISOString(), ...event })}\n`);
  }
}
