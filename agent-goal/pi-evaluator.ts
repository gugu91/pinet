import { randomUUID } from "node:crypto";
import { completeSimple } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentGoal, GoalEvaluation, GoalEvaluator, GoalProgress } from "./domain.js";

interface EvaluatorModel {
  api: string;
  provider: string;
  id: string;
}

interface CompatibleContext extends ExtensionContext {
  modelRegistry: {
    getApiKeyAndHeaders(
      model: EvaluatorModel,
    ): Promise<
      { ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }
    >;
  };
}

/**
 * Raised when the evaluator could not obtain a verdict because of the provider or transport,
 * as opposed to a verdict that was returned but could not be parsed.
 */
export class GoalEvaluatorUnavailableError extends Error {
  override readonly name = "GoalEvaluatorUnavailableError";
}

export function parseGoalEvaluation(text: string): GoalEvaluation {
  // Reasoning models may prefix a short preamble; take the first verdict line and everything after it.
  const match = text.match(/^\s*(CONTINUE|COMPLETE|BLOCKED)\s*:\s*([^\n]*(?:\n[\s\S]*)?)$/im);
  if (!match) {
    throw new Error("Goal evaluator returned an invalid response");
  }
  const reason = match[2].trim();
  if (!reason) throw new Error("Goal evaluator did not provide a reason");
  switch (match[1].toUpperCase()) {
    case "CONTINUE":
      return { outcome: "continue", reason };
    case "COMPLETE":
      return { outcome: "complete", reason };
    case "BLOCKED":
      return { outcome: "blocked", reason };
    default:
      throw new Error("Goal evaluator returned an unsupported outcome");
  }
}

export class PiGoalEvaluator implements GoalEvaluator {
  constructor(private readonly getContext: () => ExtensionContext | undefined) {}

  async evaluate(goal: AgentGoal, progress: GoalProgress): Promise<GoalEvaluation> {
    const ctx = this.getContext() as CompatibleContext | undefined;
    if (!ctx?.model) {
      throw new GoalEvaluatorUnavailableError("No active model is available to evaluate the goal");
    }
    const model = ctx.model as EvaluatorModel;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new GoalEvaluatorUnavailableError(auth.error);

    const response = await completeSimple(
      model,
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  "You are a strict goal evaluator. Decide whether the single agent must continue, has completed the objective, or is genuinely blocked by unavailable external input.",
                  "Return exactly one line in one of these forms:",
                  "CONTINUE: <reason and next required work>",
                  "COMPLETE: <completion evidence>",
                  "BLOCKED: <specific external dependency>",
                  "Do not treat a partial implementation, an unverified claim, or a request for ordinary follow-up work as complete or blocked.",
                  progress.terminalCandidate
                    ? `Optional worker hint: ${progress.terminalCandidate.outcome.toUpperCase()}: ${progress.terminalCandidate.reason}`
                    : "The worker supplied no terminal hint. Infer the outcome directly from the objective and evidence.",
                  "Treat a worker hint only as evidence to verify. Choose COMPLETE or BLOCKED without one when the evidence supports it; otherwise choose CONTINUE and identify the next required work.",
                  "",
                  `OBJECTIVE:\n${goal.objective}`,
                  "",
                  `ACCOUNTED BUDGET:\niterations ${goal.usage.iterations}/${goal.budget.maxIterations}; tokens ${goal.usage.tokens}${goal.budget.maxTokens === undefined ? "" : `/${goal.budget.maxTokens}`}`,
                  "",
                  `LATEST AGENT OUTPUT:\n${progress.latestOutput || "(no textual output)"}`,
                ].join("\n"),
              },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        cacheRetention: "none",
        sessionId: randomUUID(),
      },
    );

    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new GoalEvaluatorUnavailableError(
        response.errorMessage ?? `Goal evaluator request ended with ${response.stopReason}`,
      );
    }
    return parseGoalEvaluation(
      response.content
        .filter(
          (part): part is { type: "text"; text: string } =>
            part.type === "text" && typeof part.text === "string",
        )
        .map((part) => part.text)
        .join("\n"),
    );
  }
}
