import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatGoalDashboard, formatGoalStatus } from "./dashboard.js";
import { GoalWindow, parseDuration, type GoalWindowAction } from "./goal-window.js";
import type {
  GoalBudget,
  GoalContinuation,
  GoalContinuationKind,
  GoalEvaluator,
  GoalEventSink,
  GoalRetryPolicy,
  GoalStorage,
  GoalWakeScheduler,
} from "./domain.js";
import { PiGoalEvaluator } from "./pi-evaluator.js";
import {
  countGoalProgressTokens,
  formatGoalProgress,
  type GoalProgressMessage,
} from "./progress.js";
import { GoalRuntime } from "./runtime.js";
import { SqliteGoalStorage } from "./sqlite-storage.js";

export type {
  AgentGoal,
  GoalBudget,
  GoalContinuation,
  GoalContinuationClaim,
  GoalContinuationKind,
  GoalContinuationRequest,
  GoalContinuationResult,
  GoalDeleteResult,
  GoalEvaluation,
  GoalEvaluationRecord,
  GoalEvaluator,
  GoalEvent,
  GoalEventSink,
  GoalPendingEvaluation,
  GoalProgress,
  GoalRetryPolicy,
  GoalStatus,
  GoalStorage,
  GoalTerminalCandidate,
  GoalTerminalCandidateRecord,
  GoalUsage,
  GoalWakeScheduler,
} from "./domain.js";
export { displayGoalText, formatGoalDashboard, formatGoalStatus } from "./dashboard.js";
export { GoalWindow, parseDuration, type GoalWindowAction } from "./goal-window.js";
export { MemoryGoalStorage } from "./memory-storage.js";
export { parseGoalEvaluation, PiGoalEvaluator } from "./pi-evaluator.js";
export {
  countGoalProgressTokens,
  formatGoalProgress,
  type GoalProgressMessage,
} from "./progress.js";
export { GoalRuntime, type GoalRuntimeOptions } from "./runtime.js";
export { SqliteGoalStorage } from "./sqlite-storage.js";
export { TimerGoalWakeScheduler } from "./wake-scheduler.js";

export interface AgentGoalExtensionOptions {
  storage?: GoalStorage;
  evaluator?: GoalEvaluator;
  continuation?: GoalContinuation;
  eventSink?: GoalEventSink;
  defaultBudget?: GoalBudget;
  retryPolicy?: GoalRetryPolicy;
  databasePath?: string;
  /** @deprecated Every settled run is evaluated. Retained for configuration compatibility. */
  evaluationInterval?: number;
  wakeScheduler?: GoalWakeScheduler;
}

interface CompatibleContext extends ExtensionContext {
  sessionManager: ExtensionContext["sessionManager"] & { getSessionId(): string };
  ui: ExtensionContext["ui"] & {
    setWidget(
      key: string,
      content: string[] | undefined,
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ): void;
  };
  isIdle(): boolean;
  hasPendingMessages(): boolean;
}

interface CompatibleAPI extends ExtensionAPI {
  sendMessage(
    message: { customType: string; content: string; display: boolean },
    options?: { deliverAs?: "followUp"; triggerTurn?: boolean },
  ): void;
}

interface AgentEndEvent {
  messages: GoalProgressMessage[];
}

const STATUS_KEY = "agent-goal";
const WIDGET_KEY = "agent-goal";

export function registerAgentGoal(pi: ExtensionAPI, options: AgentGoalExtensionOptions = {}): void {
  const api = pi as CompatibleAPI;
  let activeContext: CompatibleContext | undefined;
  let latestProgress = "";
  let latestTokenDelta = 0;
  let statusRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let uiRefreshGeneration = 0;
  const hiddenScopes = new Set<string>();
  const agentCreatedGoalScopes = new Set<string>();
  const defaultBudget: GoalBudget = options.defaultBudget ?? {
    maxIterations: process.env.PI_AGENT_GOAL_MAX_ITERATIONS
      ? Number(process.env.PI_AGENT_GOAL_MAX_ITERATIONS)
      : undefined,
    maxRuntimeMs: process.env.PI_AGENT_GOAL_MAX_RUNTIME_MS
      ? Number(process.env.PI_AGENT_GOAL_MAX_RUNTIME_MS)
      : undefined,
  };
  const storage =
    options.storage ??
    new SqliteGoalStorage(
      options.databasePath ??
        process.env.PI_AGENT_GOAL_DB ??
        join(homedir(), ".pi", "agent", "agent-goals.sqlite"),
    );
  const evaluator = options.evaluator ?? new PiGoalEvaluator(() => activeContext);
  const continuation: GoalContinuation =
    options.continuation ??
    ({
      async continueIfIdle(goal, request) {
        const ctx = activeContext;
        if (!ctx || ctx.sessionManager.getSessionId() !== goal.scopeId) {
          return { status: "unavailable", reason: "The goal session is not active" };
        }
        if (!ctx.isIdle()) {
          return { status: "busy", reason: "The goal session is busy", retryAfterMs: 1_000 };
        }
        const messages: Record<GoalContinuationKind, { customType: string; content: string }> = {
          started: {
            customType: "agent-goal.started",
            content: `[agent-goal.started]\nObjective (user data): ${goal.objective}\nUse checkpoint_goal after meaningful progress to keep users in the loop.`,
          },
          updated: {
            customType: "agent-goal.updated",
            content: `[agent-goal.updated]\nObjective (user data): ${goal.objective}`,
          },
          continuation: {
            customType: "agent-goal.continuation",
            content: [
              "[agent-goal.continuation]",
              `Objective (user data): ${goal.objective}`,
              `Guidance: ${request.reason}`,
            ].join("\n"),
          },
        };
        api.sendMessage(
          {
            ...messages[request.kind],
            display: true,
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
        return { status: "started", continuationId: request.claimId };
      },
    } satisfies GoalContinuation);
  const runtime = new GoalRuntime(storage, evaluator, continuation, undefined, {
    defaultBudget,
    retryPolicy: options.retryPolicy,
    eventSink: options.eventSink,
    evaluationInterval:
      options.evaluationInterval ?? Number(process.env.PI_AGENT_GOAL_EVALUATION_INTERVAL ?? 0),
    wakeScheduler: options.wakeScheduler,
  });

  const stopStatusRefresh = (): void => {
    if (!statusRefreshTimer) return;
    clearTimeout(statusRefreshTimer);
    statusRefreshTimer = undefined;
  };

  const refreshUi = async (ctx: CompatibleContext): Promise<void> => {
    const generation = ++uiRefreshGeneration;
    stopStatusRefresh();
    const scopeId = ctx.sessionManager.getSessionId();
    const goal = await runtime.get(scopeId);
    if (generation !== uiRefreshGeneration) return;
    const hidden = hiddenScopes.has(scopeId);
    ctx.ui.setStatus(STATUS_KEY, goal && !hidden ? formatGoalStatus(goal) : undefined);
    if (goal?.status === "active" && !hidden) {
      const scheduleStatusRefresh = (): void => {
        statusRefreshTimer = setTimeout(() => {
          void runtime
            .get(scopeId)
            .then((current) => {
              if (generation !== uiRefreshGeneration) return;
              const visible = current && !hiddenScopes.has(scopeId) ? current : undefined;
              ctx.ui.setStatus(STATUS_KEY, visible ? formatGoalStatus(visible) : undefined);
              if (current?.status === "active" && visible) scheduleStatusRefresh();
              else stopStatusRefresh();
            })
            .catch((error) => {
              console.error(
                `[agent-goal] elapsed refresh failed: ${error instanceof Error ? error.message : String(error)}`,
              );
              if (generation === uiRefreshGeneration) scheduleStatusRefresh();
            });
        }, 1_000);
        statusRefreshTimer.unref();
      };
      scheduleStatusRefresh();
    }
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  };

  const applyGoalAction = async (
    scopeId: string,
    action: Exclude<GoalWindowAction, "close">,
  ): Promise<void> => {
    if (action === "closeGoal") {
      await runtime.closeGoal(scopeId);
      if (!(await runtime.clear(scopeId))) throw new Error("This session has no goal");
      return;
    }
    if (action === "pause" || action === "resume") {
      await runtime.setStatus(scopeId, action === "pause" ? "paused" : "active");
      if (action === "resume")
        await runtime.start(scopeId, "Resume the goal from current state.", "continuation");
      return;
    }
    switch (action.type) {
      case "create":
        await runtime.create(
          scopeId,
          action.objective,
          {
            ...defaultBudget,
            ...(action.maxIterations === undefined ? {} : { maxIterations: action.maxIterations }),
            ...(action.maxRuntimeMs === undefined ? {} : { maxRuntimeMs: action.maxRuntimeMs }),
          },
          action.name,
        );
        await runtime.start(scopeId);
        break;
      case "edit":
        await runtime.updateDetails(scopeId, action);
        break;
      case "budget":
        await runtime.updateBudget(scopeId, action);
        break;
      case "snooze":
        await runtime.snooze(scopeId, action.durationMs);
        break;
    }
  };

  pi.on("session_start", async (_event, rawCtx) => {
    const ctx = rawCtx as CompatibleContext;
    activeContext = ctx;
    latestProgress = "";
    latestTokenDelta = 0;
    const scopeId = ctx.sessionManager.getSessionId();
    const goal = await runtime.get(scopeId);
    if (goal?.status === "complete") await runtime.clear(scopeId);
    await runtime.recover(scopeId);
    const recoveredGoal = await runtime.get(scopeId);
    if (recoveredGoal?.status === "complete") await runtime.clear(scopeId);
    await refreshUi(ctx);
  });

  pi.on("agent_start", async (_event, rawCtx) => {
    const ctx = rawCtx as CompatibleContext;
    activeContext = ctx;
    const scopeId = ctx.sessionManager.getSessionId();
    agentCreatedGoalScopes.delete(scopeId);
    await runtime.acknowledgeContinuation(scopeId);
    await refreshUi(ctx);
  });

  pi.on("agent_end", (rawEvent, rawCtx) => {
    const event = rawEvent as AgentEndEvent;
    activeContext = rawCtx as CompatibleContext;
    latestProgress = formatGoalProgress(event.messages);
    latestTokenDelta = countGoalProgressTokens(event.messages);
  });

  pi.on("agent_settled", async (_event, rawCtx) => {
    const ctx = rawCtx as CompatibleContext;
    activeContext = ctx;
    try {
      const scopeId = ctx.sessionManager.getSessionId();
      const agentCreatedGoal = agentCreatedGoalScopes.has(scopeId);
      try {
        await runtime.settle(
          scopeId,
          {
            latestOutput: latestProgress,
            tokenDelta: latestTokenDelta,
          },
          { accountUsage: !agentCreatedGoal },
        );
      } finally {
        if (agentCreatedGoal) agentCreatedGoalScopes.delete(scopeId);
      }
      const settledGoal = await runtime.get(scopeId);
      if (settledGoal?.status === "complete") await runtime.clear(scopeId);
      await refreshUi(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[agent-goal] evaluation failed: ${message}`);
      if (ctx.hasUI) ctx.ui.notify(`Goal evaluation failed: ${message}`, "error");
    }
  });

  pi.on("session_shutdown", () => {
    activeContext = undefined;
    uiRefreshGeneration += 1;
    stopStatusRefresh();
    runtime.close(!options.storage);
  });

  pi.registerTool({
    name: "create_goal",
    label: "Create goal",
    description:
      "Create one durable bounded goal for this agent session. Use when the user's full requested outcome requires continued work across runs. Never broaden or replace the user's requested scope.",
    promptSnippet: "Create a durable single-session goal for multi-run work.",
    promptGuidelines: [
      "Create a goal only to preserve and complete the user's requested outcome across runs.",
      "Do not invent a broader objective, create background work unrelated to the request, or replace an existing goal.",
      "Keep the objective concrete and verifiable; ordinary settled work continues automatically.",
    ],
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short terminal-friendly goal name." },
        objective: { type: "string", description: "The complete user-aligned outcome to achieve." },
      },
      required: ["objective"],
      additionalProperties: false,
    },
    async execute(_toolCallId, rawParams, _signal, _onUpdate, rawCtx) {
      const params = rawParams as {
        name?: string;
        objective: string;
      };
      const ctx = rawCtx as CompatibleContext;
      const scopeId = ctx.sessionManager.getSessionId();
      const goal = await runtime.create(scopeId, params.objective, defaultBudget, params.name);
      agentCreatedGoalScopes.add(scopeId);
      await refreshUi(ctx);
      return {
        content: [
          {
            type: "text",
            text: `Created active goal ${goal.id}. Continue working normally; when this run settles, the same session will continue automatically.`,
          },
        ],
        details: { goal },
      };
    },
  });

  pi.registerTool({
    name: "update_goal_budget",
    label: "Update goal limits",
    description:
      "Set optional turns/runtime continuation limits, or turn limits off. Limits never interrupt in-flight work and changes preserve accounted usage.",
    promptSnippet: "Adjust the active session goal's optional continuation limits.",
    promptGuidelines: [
      "Only change a goal budget when more or less capacity is genuinely needed for the existing user-aligned objective.",
      "Never use budget changes to broaden the objective or evade configured hard limits.",
      "Inspect the current goal first and keep requested capacity proportionate to the remaining work.",
    ],
    parameters: {
      type: "object",
      properties: {
        maxTurns: {
          type: "integer",
          minimum: 1,
          ...(defaultBudget.maxIterations === undefined
            ? {}
            : { maximum: defaultBudget.maxIterations }),
          description: "New total settled-turn ceiling, including turns already accounted.",
        },
        maxRuntimeMs: {
          type: "number",
          exclusiveMinimum: 0,
          description: "New total runtime ceiling in milliseconds.",
        },
        off: { type: "boolean", description: "Disable all continuation limits." },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, rawParams, _signal, _onUpdate, rawCtx) {
      const params = rawParams as { maxTurns?: number; maxRuntimeMs?: number; off?: boolean };
      const ctx = rawCtx as CompatibleContext;
      const goal = await runtime.updateBudget(ctx.sessionManager.getSessionId(), {
        maxIterations: params.maxTurns,
        maxRuntimeMs: params.maxRuntimeMs,
        disabled: params.off,
      });
      await refreshUi(ctx);
      return {
        content: [
          {
            type: "text",
            text: `Updated goal limits: ${goal.budget.maxIterations ?? "unlimited"} turns, ${goal.budget.maxRuntimeMs ?? "unlimited"}ms runtime.`,
          },
        ],
        details: { goal },
      };
    },
  });

  pi.registerTool({
    name: "get_goal",
    label: "Get goal",
    description: "Read the durable goal, budget state, and checkpoints for this agent session.",
    promptSnippet: "Inspect the active session goal, remaining budget, and checkpoint history.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_toolCallId, _params, _signal, _onUpdate, rawCtx) {
      const ctx = rawCtx as CompatibleContext;
      const scopeId = ctx.sessionManager.getSessionId();
      const goal = await runtime.get(scopeId);
      const checkpoints = goal ? await runtime.listCheckpoints(scopeId) : [];
      return {
        content: [
          {
            type: "text",
            text: goal
              ? JSON.stringify(
                  {
                    goal,
                    checkpoints: checkpoints.map((checkpoint) => ({
                      at: checkpoint.createdAt,
                      DONE: checkpoint.summary,
                      ...(checkpoint.nextStep ? { TODO: checkpoint.nextStep } : {}),
                      ...(checkpoint.evidence ? { EVIDENCE: checkpoint.evidence } : {}),
                      ...(checkpoint.blocker ? { BLOCKED: checkpoint.blocker } : {}),
                    })),
                  },
                  null,
                  2,
                )
              : "This session has no goal.",
          },
        ],
        details: { goal: goal ?? null, checkpoints },
      };
    },
  });

  pi.registerTool({
    name: "clear_goal",
    label: "Clear goal",
    description:
      "Permanently remove the durable goal from this agent session. Use only when the user asks to stop tracking it or replace it with a separate objective.",
    promptSnippet: "Clear the active session goal when the user explicitly requests it.",
    promptGuidelines: [
      "Clear a goal only on an explicit user request to stop tracking it or replace it.",
      "Record any progress the user still needs before clearing because the durable goal and its checkpoints are removed.",
      "Do not clear a goal merely because it is complete or blocked unless the user asks.",
    ],
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_toolCallId, _params, _signal, _onUpdate, rawCtx) {
      const ctx = rawCtx as CompatibleContext;
      const scopeId = ctx.sessionManager.getSessionId();
      if (!(await runtime.clear(scopeId))) {
        return {
          content: [{ type: "text", text: "This session has no goal to clear." }],
          details: { cleared: false },
          isError: true,
        };
      }
      agentCreatedGoalScopes.delete(scopeId);
      hiddenScopes.delete(scopeId);
      await refreshUi(ctx);
      return {
        content: [{ type: "text", text: "Cleared the durable goal for this session." }],
        details: { cleared: true },
      };
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update goal",
    description:
      "Optionally provide a complete or blocked hint with concrete evidence. Every settled run is independently evaluated even when this tool is not called.",
    promptSnippet: "Optionally provide terminal evidence for the automatic settled-run evaluator.",
    promptGuidelines: [
      "update_goal is optional; every settled active goal run is evaluated automatically.",
      "Use complete only after verifying the full objective against authoritative evidence.",
      "Use blocked only for a genuine external impasse, not because work is difficult or incomplete.",
    ],
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["complete", "blocked"] },
        reason: {
          type: "string",
          description:
            "Concrete completion evidence or the specific unavailable external dependency.",
        },
      },
      required: ["status", "reason"],
      additionalProperties: false,
    },
    async execute(_toolCallId, rawParams, _signal, _onUpdate, rawCtx) {
      const params = rawParams as { status: "complete" | "blocked"; reason: string };
      const ctx = rawCtx as CompatibleContext;
      const scopeId = ctx.sessionManager.getSessionId();
      const goal = await runtime.get(scopeId);
      if (!goal || goal.status !== "active") {
        return {
          content: [{ type: "text", text: "No active goal can receive a terminal claim." }],
          details: { accepted: false },
          isError: true,
        };
      }
      const reason = params.reason.trim();
      if (!reason) {
        return {
          content: [{ type: "text", text: "A concrete reason is required." }],
          details: { accepted: false },
          isError: true,
        };
      }
      await runtime.requestTerminalCandidate(scopeId, { outcome: params.status, reason });
      return {
        content: [
          {
            type: "text",
            text: `Recorded ${params.status} as a candidate. An independent evaluator will verify it after this run settles.`,
          },
        ],
        details: { accepted: true, candidate: params.status },
      };
    },
  });

  pi.registerTool({
    name: "checkpoint_goal",
    label: "Checkpoint goal",
    description: "Record durable agent-reported progress, evidence, and the next step or blocker.",
    promptSnippet: "Record a concise durable progress checkpoint for the active goal.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string" },
        evidence: { type: "string" },
        nextStep: { type: "string" },
        blocker: { type: "string" },
      },
      required: ["summary"],
      additionalProperties: false,
    },
    async execute(_toolCallId, rawParams, _signal, _onUpdate, rawCtx) {
      const checkpoint = await runtime.addCheckpoint(
        (rawCtx as CompatibleContext).sessionManager.getSessionId(),
        rawParams as { summary: string; evidence?: string; nextStep?: string; blocker?: string },
      );
      return {
        content: [{ type: "text", text: `Checkpoint recorded: ${checkpoint.summary}` }],
        details: { checkpoint },
      };
    },
  });

  pi.registerCommand("goal", {
    description:
      "Discuss or inspect a goal; update its name, objective, or limits; snooze, close, show, or hide it",
    handler: async (args, rawCtx) => {
      const ctx = rawCtx as CompatibleContext;
      activeContext = ctx;
      const scopeId = ctx.sessionManager.getSessionId();
      const input = args.trim();
      const command = input.toLowerCase();

      try {
        if (command === "demo") {
          if (await runtime.get(scopeId))
            throw new Error(
              "Use a session without a goal for /goal demo; your current goal is unchanged.",
            );
          api.sendMessage(
            {
              customType: "agent-goal.demo",
              content:
                "Walk me through goals: agree a tiny example, create it, record a checkpoint, inspect /goal, then verify completion. Ask before changing any goal; preserve existing work.",
              display: true,
            },
            { triggerTurn: true },
          );
          return;
        }
        if (!input || command === "update") {
          let openedWindow = false;
          let actionError: string | undefined;
          let initialMode: "details" | "edit" = command === "update" ? "edit" : "details";
          while (true) {
            const goal = await runtime.get(scopeId);
            if (initialMode === "edit" && !goal) throw new Error("This session has no goal");
            const claim = await runtime.getContinuationClaim(scopeId);
            const checkpoints = await runtime.listCheckpoints(scopeId);
            const action = await ctx.ui.custom<GoalWindowAction>(
              (tui, theme, _keybindings, done) => {
                openedWindow = true;
                return new GoalWindow(
                  goal,
                  claim,
                  theme,
                  done,
                  () => tui.requestRender(),
                  Date.now,
                  actionError,
                  checkpoints,
                  initialMode,
                );
              },
              {
                overlay: true,
                overlayOptions: {
                  anchor: "center",
                  width: 66,
                  minWidth: 36,
                  maxHeight: "80%",
                  margin: 1,
                },
              },
            );
            if (!openedWindow) {
              api.sendMessage(
                {
                  customType: "agent-goal.status",
                  content: goal
                    ? formatGoalDashboard(goal, claim, checkpoints).join("\n")
                    : "This session has no goal.",
                  display: true,
                },
                { triggerTurn: false },
              );
              return;
            }
            initialMode = "details";
            if (!action || action === "close") return;
            try {
              await applyGoalAction(scopeId, action);
              actionError = undefined;
              await refreshUi(ctx);
            } catch (error) {
              actionError = error instanceof Error ? error.message : String(error);
            }
          }
        }

        if (command.startsWith("update name ")) {
          await runtime.updateDetails(scopeId, { name: input.slice("update name ".length) });
        } else if (command.startsWith("update objective ")) {
          await runtime.updateDetails(scopeId, {
            objective: input.slice("update objective ".length),
          });
        } else if (command === "update budget off") {
          await runtime.updateBudget(scopeId, { disabled: true });
        } else if (command.startsWith("update budget turns ")) {
          await runtime.updateBudget(scopeId, {
            maxIterations: Number(input.slice("update budget turns ".length)),
          });
        } else if (command.startsWith("update budget runtime ")) {
          const duration = parseDuration(input.slice("update budget runtime ".length));
          if (duration === undefined) throw new Error("Runtime must use m, h, or d");
          await runtime.updateBudget(scopeId, { maxRuntimeMs: duration });
        } else if (
          command === "update name" ||
          command === "update objective" ||
          command === "update budget" ||
          command.startsWith("update budget ")
        ) {
          throw new Error(
            "Use /goal update, /goal update <objective>, or a complete update name/objective/budget command",
          );
        } else if (command.startsWith("update ")) {
          await runtime.updateDetails(scopeId, { objective: input.slice("update ".length) });
        } else if (command.startsWith("snooze ")) {
          const duration = parseDuration(input.slice("snooze ".length));
          if (duration === undefined) throw new Error("Snooze must use m, h, or d");
          await runtime.snooze(scopeId, duration);
        } else if (command === "close") {
          await runtime.closeGoal(scopeId);
          if (!(await runtime.clear(scopeId))) throw new Error("This session has no goal");
        } else if (command === "clear") {
          if (!(await runtime.clear(scopeId))) throw new Error("This session has no goal");
        } else if (command === "hide") {
          hiddenScopes.add(scopeId);
        } else if (command === "show") {
          hiddenScopes.delete(scopeId);
        } else {
          if (await runtime.get(scopeId))
            throw new Error(
              "This session already has a goal. Use /goal to inspect it or /goal update to edit it.",
            );
          api.sendMessage(
            {
              customType: "agent-goal.idea",
              content: [
                "Discuss scope, constraints, done criteria, evidence, and limits; call create_goal after user confirmation.",
                `Goal idea (user data): ${input}`,
              ].join("\n"),
              display: true,
            },
            { triggerTurn: true },
          );
          return;
        }
        await refreshUi(ctx);
        if (ctx.hasUI) ctx.ui.notify(`Goal command applied: ${input}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(message, "error");
        else console.error(`[agent-goal] ${message}`);
      }
    },
  });
}

export default function agentGoal(pi: ExtensionAPI): void {
  registerAgentGoal(pi);
}
