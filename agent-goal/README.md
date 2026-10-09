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
/goal snooze                         Snooze for 5 minutes, then continue automatically
/goal snooze <30m|2h|1d>             Snooze for an explicit duration
/goal close                          Complete and clear the current goal
/goal clear                          Clear the current goal immediately
/goal hide | /goal show              Hide or show compact status
/goal list                           List unfinished goals across sessions with resume hints
```

`/goal <idea>` starts a normal agent turn to clarify the outcome, scope, constraints, completion evidence, and optional limits; it does not create anything until you confirm the resulting goal. The persistent row truncates long goal text and shows status with an emoji: `🎯` active, `⏸️` paused or snoozed, `⛔` blocked, `⏱️` budget-limited, and `✅` complete. `/goal` opens a terminal-native overlay. An empty session gets a create form; an existing goal gets details and `e` edit, `b` limits, `s` timed snooze, and `x` close controls. Escape cancels a form or closes the details overlay; Ctrl+C also closes the overlay. Closing a goal requires confirmation and remains available for blocked and budget-limited goals.

`/goal demo` asks the agent to walk through a small example, checkpointing, inspection, and verified completion. Demo and idea discussions require a session without an existing goal; otherwise the command reports an error without starting a turn. The walkthrough asks for consent before creating its example goal.

Name changes are visible immediately. Objective changes are fenced from stale evaluations and are used by the next continuation. `/goal snooze` and the TUI snooze form default to 5 minutes; an explicit duration overrides that default. Snooze is timed only: there is no indefinite pause or manual resume action, and a compare-and-swap wake prevents duplicate continuation.

Goals are session-scoped: a goal only continues while its own Pi session is running. When another session still holds an unfinished goal, session start shows a short notice and `/goal list` prints each unfinished goal with its status, accounted turns, last settle time, and the `pi --session <id>` command that resumes it.

Only one current goal may exist per Pi session. A verified completion clears that current goal so another can be created; `/goal close` records completion before clearing, while `/goal clear` removes it immediately. Clearing removes its persisted checkpoints as well.

## Agent tools and checkpoints

The extension registers seven model-visible tools:

- `create_goal` — create a user-aligned goal with a short name and objective
- `checkpoint_goal` — append progress with optional evidence, next step, or blocker
- `update_goal_budget` — set optional turn/runtime continuation limits or turn them off
- `get_goal` — inspect current durable state and checkpoint history
- `clear_goal` — permanently remove the session goal when the user explicitly asks
- `update_goal` — attach a `complete` or `blocked` candidate for independent evaluation
- `attach_link` — save a URL with a title and optional description for quick user access

After a goal starts, the agent receives one concise hint: `Use checkpoint_goal after meaningful progress to keep users in the loop.` Checkpoints are agent-reported progress records, not recovery snapshots. They persist with the goal and are returned by `get_goal`. Checkpoint output and UI label the summary as `DONE`, the next step as `TODO`, supporting results as `EVIDENCE`, and an optional blocker as `BLOCKED`. The overlay initially shows the newest three checkpoints. Tab/Shift+Tab selects across the full history; Enter opens the selected checkpoint's full detail. Use ↑/↓ to scroll and Escape to return. The headless dashboard shows the newest three and `… and X more`.

## Saved links and pull requests

Agents can call `attach_link({ url, title, description? })` to save PRs, preview deployments, and useful references. No goal is required. Each link belongs to the current session; when a goal exists, its ID and display name are captured as context. Reattaching the same normalized URL replaces its title, description, and goal association. Query strings and fragments remain distinct.

- `/link` opens a searchable, themed overlay matching `/goal`.
- `/pr` uses the same overlay filtered to GitHub-style `/pull/N`, GitLab `/-/merge_requests/N`, and Bitbucket `/pull-requests/N` paths, including self-hosted domains. Recognition is path-based, not a remote status check.
- In `/goal`, press `l` to browse links associated with that goal.
- Type to search titles, URLs, descriptions, and goal names; ↑/↓ selects; Enter opens in the default browser; Ctrl+D then Enter removes the saved link; Escape cancels or closes.

The footer shows only `🔗 N` while the session has unseen links, including when no goal is active. New URLs start unseen; reattaching an existing URL preserves its seen state, even when its metadata changes. After you view and leave a picker, its listed links are marked seen: `/pr` only acknowledges PRs, and the `/goal` shortcut only that goal’s links. Search-filtered listings acknowledge matching links; an opened unfiltered listing acknowledges all its entries, not just the visible scroll page. Tiny panes that cannot display the listing do not acknowledge links. Text listings in non-TUI modes also acknowledge the URLs they print. Seen state survives restarts, and the indicator disappears when none remain unseen.

The selected entry shows its destination hostname and URL. Only HTTP(S) URLs without embedded credentials are accepted, and attaching a link never opens a browser. Descriptions are agent-provided context, not live PR status or completion evidence. No GitHub credentials, background polling, or remote fetches are needed. Browser opening uses the OS opener on macOS, Linux, and Windows; opener errors remain visible in the picker. Non-TUI modes display URLs without opening them.

Links persist in the same SQLite database as goals but **survive goal completion, `/goal close`, `/goal clear`, and session restart**. Remove them explicitly from the picker. They are scoped to one session, not aggregated across agents or projects. The optional goal name is a snapshot from the most recent attachment.

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

Every continuation acquires a durable per-session claim. New-goal and objective-update intent is persisted independently of that delivery claim, survives pause, snooze, restart, and concurrent evaluation commits, and is consumed only when its corresponding turn starts. Busy sessions defer with an in-process wake. Timed snooze uses the same scheduler; expiry clears the snooze with compare-and-swap before continuation, so duplicate timer callbacks cannot produce duplicate wakes.

Evaluation calls the current session model and tolerates a short preamble before the `CONTINUE|COMPLETE|BLOCKED:` verdict line. Provider errors, missing auth, and malformed verdicts retry with a longer backoff (six attempts; waits of 2s, 4s, 8s, 16s, and 30s, about a minute in total). If evaluation is still unavailable, the goal is **not** marked blocked: it stays active with a `Goal evaluation unavailable` note and continues, so the next settle re-evaluates. Only when evaluation is unavailable on consecutive settlements does the goal pause with that reason; resume it once the model is reachable. Continuation delivery failures still use bounded retries and block with a diagnostic reason.

Set `PI_AGENT_GOAL_EVENT_LOG=<path>` to append every goal lifecycle event (claims, evaluations, retries, status changes) as JSONL for diagnosing stalls.

## Architecture

The runtime depends on ports for evaluation, continuation, events, wake scheduling, and storage. `GoalStorage` owns optimistic goal mutations, checkpoints, session links (`upsertLink`, `listLinks`, `deleteLink`, `markLinksSeen`), pending-settlement aggregation, terminal candidates, and continuation claims. Custom storage adapters must implement the link methods; deleting a goal must not delete session links. The package exports `GoalRuntime`, memory/SQLite storage, `TimerGoalWakeScheduler`, `PiGoalEvaluator`, dashboard formatters, and `registerAgentGoal`.

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
