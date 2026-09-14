# @pinet/agent-goal

A standalone Pi extension that keeps one agent session working toward one durable goal. It does not require Pinet, the broker, RALPH, or Slack.

The worker runs normally. Every settled active-goal run is independently evaluated as `continue`, `complete`, or `blocked`. A continuation starts only while the goal remains active, unsnoozed, and within any operator-enabled limits.

## Install

```bash
pi install npm:@pinet/agent-goal
```

For local development: `pi -e ./agent-goal/index.ts`.

## Commands and terminal UI

```text
/goal <idea>                         Ask the agent to refine a possible goal with you
/goal demo                           Start an agent-guided walkthrough
/goal                                Open the create/details overlay
/goal update                         Open the edit form
/goal update <objective>             Apply a new objective to the next continuation
/goal update name <name>             Rename immediately
/goal update objective <objective>   Apply a new objective to the next continuation
/goal update budget turns <n>        Set an optional total-turn limit
/goal update budget runtime <2h>     Set an optional total-runtime limit
/goal update budget off              Disable continuation limits
/goal snooze <30m|2h|1d>             Snooze, then continue automatically
/goal close                          Complete and clear the current goal
/goal clear                          Clear the current goal immediately
/goal hide | /goal show              Hide or show compact status
```

`/goal <idea>` starts a normal agent turn to clarify the outcome, scope, constraints, completion evidence, and optional limits; it does not create anything until you confirm the resulting goal. The persistent row is deliberately compact: `🎯 name elapsed`. `/goal` opens a terminal-native overlay. An empty session gets a create form; an existing goal gets details and `e` edit, `b` limits, `s` timed snooze, and `x` close controls. Escape cancels a form or closes the details overlay; Ctrl+C also closes the overlay. Closing a goal requires confirmation and remains available for blocked and budget-limited goals.

`/goal demo` asks the agent to walk through a small example, checkpointing, inspection, and verified completion. Demo and idea discussions require a session without an existing goal; otherwise the command reports an error without starting a turn. The walkthrough asks for consent before creating its example goal.

Name changes are visible immediately. Objective changes are fenced from stale evaluations and are used by the next continuation. Snooze is timed only: there is no indefinite pause or manual resume action, and a compare-and-swap wake prevents duplicate continuation.

Only one current goal may exist per Pi session. A verified completion clears that current goal so another can be created; `/goal close` records completion before clearing, while `/goal clear` removes it immediately. Clearing removes its persisted checkpoints as well.

## Agent tools and checkpoints

The extension registers six model-visible tools:

- `create_goal` — create a user-aligned goal with a short name and objective
- `checkpoint_goal` — append progress with optional evidence, next step, or blocker
- `update_goal_budget` — set optional turn/runtime continuation limits or turn them off
- `get_goal` — inspect current durable state
- `clear_goal` — permanently remove the session goal when the user explicitly asks
- `update_goal` — attach a `complete` or `blocked` candidate for independent evaluation

Checkpoints are agent-reported progress records, not recovery snapshots. They persist with the goal. The overlay initially shows the newest three checkpoints. Tab/Shift+Tab selects across the full history; Enter opens the selected checkpoint's full summary, evidence, next step, and blocker. Use ↑/↓ to scroll and Escape to return. The headless dashboard shows the newest three and `… and X more`.

## Optional continuation limits

New goals are unlimited by default. Turns and runtime limits are opt-in and only decide whether a future continuation may start; they never interrupt in-flight work. Existing usage is preserved when limits change or are disabled. Configured environment values remain hard ceilings/defaults when present:

```text
PI_AGENT_GOAL_MAX_ITERATIONS=25
PI_AGENT_GOAL_MAX_RUNTIME_MS=14400000
```

Legacy token limits and accounted token usage remain readable and enforceable for stored goals, but token controls are omitted from the new UX because provider accounting is not reliably comparable.

The evaluator reviews every settled run, including the final allowed turn, before a goal becomes budget-limited. Increasing or disabling exhausted limits reactivates the same goal when continuation capacity exists.

## Persistence and recovery

SQLite storage defaults to `~/.pi/agent/agent-goals.sqlite`; set `PI_AGENT_GOAL_DB` to override it. Schema upgrades add nullable name/snooze fields and durable checkpoints without discarding legacy goals or token data. Legacy goals derive their display name from their objective.

Optimistic versions reject stale mutations. Metadata/limit edits atomically advance pending evaluation, candidate, and continuation-claim versions. Evaluation commit updates lifecycle and usage fields only, so an old result cannot overwrite a newer name, objective, limit, or snooze. Settlements arriving during evaluation are aggregated and charged exactly once.

Every continuation acquires a durable per-session claim. New-goal and objective-update intent is persisted independently of that delivery claim, survives pause, snooze, restart, and concurrent evaluation commits, and is consumed only when its corresponding turn starts. Busy sessions defer with an in-process wake. Timed snooze uses the same scheduler; expiry clears the snooze with compare-and-swap before continuation, so duplicate timer callbacks cannot produce duplicate wakes. Failures use bounded retries and eventually block with a diagnostic reason.

## Architecture

The runtime depends on ports for evaluation, continuation, events, wake scheduling, and storage. `GoalStorage` owns optimistic goal mutations, checkpoints, pending-settlement aggregation, terminal candidates, and continuation claims. The package exports `GoalRuntime`, memory/SQLite storage, `TimerGoalWakeScheduler`, `PiGoalEvaluator`, dashboard formatters, and `registerAgentGoal`.

```ts
import { registerAgentGoal } from "@pinet/agent-goal";

registerAgentGoal(pi, {
  storage: myStorage,
  evaluator: myEvaluator,
  continuation: myAtomicContinuationAdapter,
  eventSink: myEventSink,
  defaultBudget: { maxIterations: 20, maxRuntimeMs: 14_400_000 },
});
```

Pi's current API does not expose Codex's exact `start_turn_if_idle` primitive. The default adapter rechecks session identity, idle state, and pending messages immediately before follow-up submission. A Pinet adapter can replace these ports without changing `GoalRuntime`.

Lifecycle prompts treat the objective as user-provided task data, never as higher-priority instructions. The first turn is labeled `[agent-goal.started]`, an objective edit is labeled `[agent-goal.updated]`, and only unchanged follow-up work uses `[agent-goal.continuation]`. The lifecycle tag is included in model-visible content and carries the transition semantics; started and updated messages otherwise contain only the current objective, while continuations add evaluator guidance.
