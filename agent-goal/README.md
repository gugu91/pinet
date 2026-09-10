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
/goal <objective>                    Create and start a goal
/goal                                Open the create/details overlay
/goal update name <name>             Rename immediately
/goal update objective <objective>   Apply a new objective to the next continuation
/goal update budget turns <n>        Set an optional total-turn limit
/goal update budget runtime <2h>     Set an optional total-runtime limit
/goal update budget off              Disable continuation limits
/goal snooze <30m|2h|1d>             Snooze, then continue automatically
/goal close                          Close the goal in any lifecycle state
/goal hide | /goal show              Hide or show compact status
```

The persistent row is deliberately compact: `🎯 | name | elapsed`. `/goal` opens a terminal-native overlay. An empty session gets a create form; an existing goal gets details and `e` edit, `b` limits, `s` timed snooze, and `x` close controls. Escape cancels a form, while `q`, Escape, or Ctrl+C closes the overlay. Closing a goal requires confirmation and remains available for blocked and budget-limited goals.

Name changes are visible immediately. Objective changes are fenced from stale evaluations and are used by the next continuation. Snooze is timed only: there is no indefinite pause or manual resume action, and a compare-and-swap wake prevents duplicate continuation.

Only one goal may exist per Pi session. Closed goals remain durable history rather than being silently deleted.

## Agent tools and checkpoints

The extension registers five model-visible tools:

- `create_goal` — create a user-aligned goal with a short name and objective
- `checkpoint_goal` — append progress with optional evidence, next step, or blocker
- `update_goal_budget` — set optional turn/runtime continuation limits or turn them off
- `get_goal` — inspect current durable state
- `update_goal` — attach a `complete` or `blocked` candidate for independent evaluation

Checkpoints are agent-reported progress records, not recovery snapshots. They persist with the goal. The overlay and headless dashboard show the newest three and `… and X more`; `h` expands/collapses full history in the overlay.

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

Every continuation acquires a durable per-session claim. Busy sessions defer with an in-process wake. Timed snooze uses the same scheduler; expiry clears the snooze with compare-and-swap before continuation, so duplicate timer callbacks cannot produce duplicate wakes. Failures use bounded retries and eventually block with a diagnostic reason.

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

Continuation prompts treat the objective as user-provided task data, never as higher-priority instructions.
