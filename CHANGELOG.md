# Changelog

All notable changes to this repository are documented in this file.

## Release note policy

Readiness-only npm publishing workflow or documentation changes do not by
themselves create a new release entry, tag, or package version. Add a versioned
entry only when a maintainer approves a real release with intentional package
version bumps and publish scope.

## [0.2.19] - 2026-09-16

Pinet v0.2.19 lets `@pinet/model-aware-compaction` run compaction on a dedicated model instead of the active conversation model.

### Version verification

- `pi-extensions` — `0.2.19` (private repo package)
- `@pinet/transport-core` — `0.2.19`
- `@pinet/broker-core` — `0.2.19`
- `@pinet/pinet-core` — `0.2.19`
- `@pinet/imessage-bridge` — `0.2.19`
- `@pinet/slack-bridge` — `0.2.19`
- `@pinet/model-aware-compaction` — `0.2.19`
- `@pinet/agent-goal` — `0.2.19`

### Release highlights

- Adds a global `compactionModel` selector plus per-rule overrides and a session-only `/model-aware-compaction-model` picker, so manual, threshold, overflow, and proactive compaction can summarize with a cheaper or larger model while the active session model stays unchanged.
- Routes selected-model summarization through `ctx.modelRegistry.complete()`, preserving resolved credentials, dynamic endpoints, custom providers, and cancellation.
- Uses Pi 0.85.1's verbatim summarization prompts and request assembly, with parity tests that fail loudly if the installed SDK's prompts drift.
- Preserves compaction semantics across repeated compactions: previous summaries, split-turn prefixes, kept-entry boundaries, cumulative read/modified file metadata, custom instructions, and full usage accounting including optional `reasoning` and `cacheWrite1h`.
- Fails closed on unknown or unavailable models, missing credentials, unsupported thinking suffixes, oversized inputs, provider errors, and empty summary sections, and reports the reason even without a UI. Selection is model-only; the selected provider's default thinking level is used.
- Requires Pi `>=0.85.1` for `@pinet/model-aware-compaction`. Publishes the other six packages at the aligned version without additional functional changes.

### Notable pull requests

- [#1050](https://github.com/gugu91/pinet/pull/1050) — choose a dedicated compaction model (closes [#1047](https://github.com/gugu91/pinet/issues/1047))

See the [full change set since v0.2.18](https://github.com/gugu91/pinet/compare/v0.2.18...v0.2.19).

## [0.2.18] - 2026-09-16

Pinet v0.2.18 stops durable goals from stalling when the evaluator model is unavailable and makes goals stranded in closed sessions visible.

### Version verification

- `pi-extensions` — `0.2.18` (private repo package)
- `@pinet/transport-core` — `0.2.18`
- `@pinet/broker-core` — `0.2.18`
- `@pinet/pinet-core` — `0.2.18`
- `@pinet/imessage-bridge` — `0.2.18`
- `@pinet/slack-bridge` — `0.2.18`
- `@pinet/model-aware-compaction` — `0.2.18`
- `@pinet/agent-goal` — `0.2.18`

### Release highlights

- Goal evaluation tolerates a reasoning preamble before the `CONTINUE|COMPLETE|BLOCKED:` verdict line and classifies provider, auth, and transport failures separately from malformed verdicts.
- Evaluator retries back off for about a minute (2s, 4s, 8s, 16s, 30s) instead of ~3s; when evaluation is still unavailable the goal stays active with a `Goal evaluation unavailable` note and re-evaluates on the next settle, pausing only after consecutive unavailable settlements. Goal budgets are enforced on that path. `blocked` now means the objective is blocked, never the evaluator.
- Adds `/goal list` and a session-start notice for unfinished goals held by other sessions, with `pi --session <id>` resume hints.
- Adds an opt-in append-only JSONL goal event log via `PI_AGENT_GOAL_EVENT_LOG=<path>` for diagnosing stalls.
- Publishes the other six packages at the aligned version without additional functional changes.

### Notable pull requests

- [#1049](https://github.com/gugu91/pinet/pull/1049) — keep goals alive through evaluator outages and surface orphaned goals (closes [#1048](https://github.com/gugu91/pinet/issues/1048))

See the [full change set since v0.2.17](https://github.com/gugu91/pinet/compare/v0.2.17...v0.2.18).

## [0.2.17] - 2026-09-14

Pinet v0.2.17 keeps users informed during durable goal work and makes goal progress immediately readable in both model and terminal interfaces.

### Version verification

- `pi-extensions` — `0.2.17` (private repo package)
- `@pinet/transport-core` — `0.2.17`
- `@pinet/broker-core` — `0.2.17`
- `@pinet/pinet-core` — `0.2.17`
- `@pinet/imessage-bridge` — `0.2.17`
- `@pinet/slack-bridge` — `0.2.17`
- `@pinet/model-aware-compaction` — `0.2.17`
- `@pinet/agent-goal` — `0.2.17`

### Release highlights

- Prompts agents to use `checkpoint_goal` after meaningful progress so users stay in the loop.
- Returns durable checkpoint history from `get_goal` and labels completed work, remaining work, evidence, and blockers as `DONE`, `TODO`, `EVIDENCE`, and `BLOCKED` in model-visible and terminal presentations.
- Adds status-specific emoji and safely truncates compact goal text for ASCII, CJK, and emoji content.
- Keeps every interactive goal UI mode within narrow terminal widths.
- Publishes the other six packages at the aligned version without additional functional changes.

### Notable pull requests

- [#1045](https://github.com/gugu91/pinet/pull/1045) — improve agent-goal checkpoint visibility and compact status

See the [full change set since v0.2.16](https://github.com/gugu91/pinet/compare/v0.2.16...v0.2.17).

## [0.2.16] - 2026-09-14

Pinet v0.2.16 makes durable goal lifecycle transitions explicit to agents and adds safe agent-driven goal clearing.

### Version verification

- `pi-extensions` — `0.2.16` (private repo package)
- `@pinet/transport-core` — `0.2.16`
- `@pinet/broker-core` — `0.2.16`
- `@pinet/pinet-core` — `0.2.16`
- `@pinet/imessage-bridge` — `0.2.16`
- `@pinet/slack-bridge` — `0.2.16`
- `@pinet/model-aware-compaction` — `0.2.16`
- `@pinet/agent-goal` — `0.2.16`

### Release highlights

- Distinguishes newly started, updated, and continuing goals with concise model-visible lifecycle tags so agents stop superseded work and interpret ongoing work correctly.
- Persists unconsumed lifecycle intent across retries, restarts, pauses, snoozes, and concurrent evaluation commits, consuming it only after the matching continuation is acknowledged.
- Adds the explicit `clear_goal` tool for user-requested goal removal, with identity-and-version-fenced deletion that distinguishes missing goals from conflicts and protects replacement goals from ABA races.
- Cascades successful goal clearing through pending evaluations, terminal candidates, continuation claims, and checkpoints while refreshing the session UI.
- Publishes the other six packages at the aligned version without additional functional changes.

### Notable pull requests

- [#1042](https://github.com/gugu91/pinet/pull/1042) — distinguish durable goal lifecycle prompts and add safe explicit clearing

See the [full change set since v0.2.15](https://github.com/gugu91/pinet/compare/v0.2.15...v0.2.16).

## [0.2.15] - 2026-09-12

Pinet v0.2.15 improves goal lifecycle controls, live status, guided setup, and checkpoint navigation.

### Version verification

- `pi-extensions` — `0.2.15` (private repo package)
- `@pinet/transport-core` — `0.2.15`
- `@pinet/broker-core` — `0.2.15`
- `@pinet/pinet-core` — `0.2.15`
- `@pinet/imessage-bridge` — `0.2.15`
- `@pinet/slack-bridge` — `0.2.15`
- `@pinet/model-aware-compaction` — `0.2.15`
- `@pinet/agent-goal` — `0.2.15`

### Release highlights

- Clears the current goal after verified completion or `/goal close`, and restores `/goal clear`.
- Refreshes elapsed runtime live and serializes status polling to prevent stale UI restoration.
- Adds interactive `/goal update`, wrapped objectives, and consistent Escape controls.
- Makes `/goal <idea>` discuss scope before creation and adds a guided `/goal demo`; both protect existing goals from unrelated discussion turns.
- Keeps continuation prompts concise and adds Tab/Shift+Tab checkpoint selection, Enter details, and scrollable evidence.
- Publishes the other six packages at the aligned version without additional functional changes.

### Known issue

- The reported immediate “No goal” result after Enter-save remains unresolved. Requiring a new run after an objective edit is follow-up work and is not included in this release.

### Notable pull requests

- [#1033](https://github.com/gugu91/pinet/pull/1033) — improve goal lifecycle testing, guided setup, and checkpoint navigation

See the [full change set since v0.2.14](https://github.com/gugu91/pinet/compare/v0.2.14...v0.2.15).

## [0.2.14] - 2026-09-10

Pinet v0.2.14 makes the single-session goal loop easier to control from Pi with a terminal-native overlay, editable goal metadata, durable progress checkpoints, timed snoozes, and opt-in continuation limits.

### Version verification

- `pi-extensions` — `0.2.14` (private repo package)
- `@pinet/transport-core` — `0.2.14`
- `@pinet/broker-core` — `0.2.14`
- `@pinet/pinet-core` — `0.2.14`
- `@pinet/imessage-bridge` — `0.2.14`
- `@pinet/slack-bridge` — `0.2.14`
- `@pinet/model-aware-compaction` — `0.2.14`
- `@pinet/agent-goal` — `0.2.14`

### Release highlights

- Adds a terminal-native `/goal` overlay for creating goals and editing names, objectives, continuation limits, snoozes, and lifecycle actions without leaving the session.
- Reduces the persistent running indicator to `🎯 name elapsed`, with detailed state available on demand in the overlay.
- Adds durable agent-written progress checkpoints with evidence, next steps, and blockers; the overlay shows the newest three before offering the full scrollable history.
- Adds timed snoozes that resume automatic continuation when due, including restart-safe scheduling and duplicate-wake protection.
- Makes turn and runtime continuation limits opt-in and editable while preserving accounted usage, and keeps closing available in every lifecycle state.
- Adds matching `/goal update name`, `/goal update objective`, `/goal update budget`, `/goal snooze`, and `/goal close` commands with optimistic concurrency protections for edits and stale evaluations.

### Notable pull requests

- [#1028](https://github.com/gugu91/pinet/pull/1028) — improve the goal overlay, lifecycle controls, checkpoints, and command parity

See the [full change set since v0.2.13](https://github.com/gugu91/pinet/compare/v0.2.13...v0.2.14).

## [0.2.13] - 2026-08-28

Pinet v0.2.13 extends contextual threads to normal tracked Neovim buffers and introduces broker-owned, transport-neutral document ownership and subscriptions shared across Neovim and Slack.

### Version verification

- `pi-extensions` — `0.2.13` (private repo package)
- `@pinet/transport-core` — `0.2.13`
- `@pinet/broker-core` — `0.2.13`
- `@pinet/pinet-core` — `0.2.13`
- `@pinet/imessage-bridge` — `0.2.13`
- `@pinet/slack-bridge` — `0.2.13`
- `@pinet/model-aware-compaction` — `0.2.13`
- `@pinet/agent-goal` — `0.2.13`

### Release highlights

- Enables `:PinetComment` in normal tracked buffers with revision-aware schema-v2 anchors that do not invent diff sides, while preserving schema-v1 diff anchors.
- Adds broker-persisted documents, aliases, one authoritative owner, and deduplicated subscribers without introducing transport-specific ownership stores.
- Adds Neovim ownership and subscription commands plus explicit `:PinetBindSlack <thread_id>` binding so Slack and Git-file aliases resolve to one canonical document.
- Preserves delivery to durable resumable or hibernated owners and subscribers even when they are not in the live process roster.
- Migrates BrokerDB from schema v24 to v25 while preserving existing threads and validates restart persistence, ownership transfer, fanout, alias resolution, and legacy anchors.

### Notable pull requests

- [#1023](https://github.com/gugu91/pinet/pull/1023) — add normal-buffer contextual threads and shared document ownership/subscriptions

See the [full change set since v0.2.12](https://github.com/gugu91/pinet/compare/v0.2.12...v0.2.13).

## [0.2.12] - 2026-08-26

Pinet v0.2.12 replaces the dormant PiComms review store with Pinet-native, revision-aware contextual threads for single-file Neovim diffs.

### Version verification

- `pi-extensions` — `0.2.12` (private repo package)
- `@pinet/transport-core` — `0.2.12`
- `@pinet/broker-core` — `0.2.12`
- `@pinet/pinet-core` — `0.2.12`
- `@pinet/imessage-bridge` — `0.2.12`
- `@pinet/slack-bridge` — `0.2.12`
- `@pinet/model-aware-compaction` — `0.2.12`
- `@pinet/agent-goal` — `0.2.12`

### Release highlights

- Adds persisted line/range-anchored contextual threads to existing single-file Fugitive and native Neovim diffs without introducing a review-specific service or second database.
- Stores comments, replies, resolution state, and revision-aware anchors as ordinary Pinet threads/messages in BrokerDB, restoring matching open and resolved signs after restarts.
- Routes explicit Neovim comments through normal Pinet agent inboxes, supports generic agent thread replies, and hydrates a bounded summary of relevant unresolved threads into later agent turns.
- Preserves `open_in_editor` and editor-context sync through the broker-owned Unix socket with canonical worktree-relative paths, including subdirectory sessions and native old-side snapshots.
- Removes the legacy PiComms SQLite/filesystem persistence, RPC surface, and canonical `ctx:<file>:<range>` identities.

### Notable pull requests

- [#1019](https://github.com/gugu91/pinet/pull/1019) — add Pinet-native Neovim contextual threads and replace the dormant PiComms subsystem

See the [full change set since v0.2.11](https://github.com/gugu91/pinet/compare/v0.2.11...v0.2.12).

## [0.2.11] - 2026-08-25

Pinet v0.2.11 adds safe mutable budgets and reliable operator-driven initiation to the standalone single-session goal loop.

### Version verification

- `pi-extensions` — `0.2.11` (private repo package)
- `@pinet/transport-core` — `0.2.11`
- `@pinet/broker-core` — `0.2.11`
- `@pinet/pinet-core` — `0.2.11`
- `@pinet/imessage-bridge` — `0.2.11`
- `@pinet/slack-bridge` — `0.2.11`
- `@pinet/model-aware-compaction` — `0.2.11`
- `@pinet/agent-goal` — `0.2.11`

### Release highlights

- Adds atomic, bounded goal turn/token budget updates for operators and agents without recreating a goal or losing accounted usage.
- Rebinds pending evaluations and continuation claims across budget-version changes, including deterministic memory and SQLite race coverage.
- Adds turn/token budget editing to the interactive `/goal` overlay with in-place validation and refresh.
- Starts operator-created goals when Pi is idle even if pending delivery is reported, while preserving one charge per `agent_settled` run.

### Notable pull requests

- [#1011](https://github.com/gugu91/pinet/pull/1011) — add mutable goal budgets and close concurrent settlement/continuation races
- [#1013](https://github.com/gugu91/pinet/pull/1013) — edit goal budgets from the interactive overlay
- [#1015](https://github.com/gugu91/pinet/pull/1015) — prevent idle operator-created goals from stalling on pending delivery

See the [full change set since v0.2.10](https://github.com/gugu91/pinet/compare/v0.2.10...v0.2.11).

## [0.2.10] - 2026-08-23

Pinet v0.2.10 prevents model-aware proactive compaction from racing Pi's native auto-compaction lifecycle.

### Version verification

- `pi-extensions` — `0.2.10` (private repo package)
- `@pinet/transport-core` — `0.2.10`
- `@pinet/broker-core` — `0.2.10`
- `@pinet/pinet-core` — `0.2.10`
- `@pinet/imessage-bridge` — `0.2.10`
- `@pinet/slack-bridge` — `0.2.10`
- `@pinet/model-aware-compaction` — `0.2.10`
- `@pinet/agent-goal` — `0.2.10`

### Release highlights

- Moves proactive model-aware compaction from `agent_end` to the terminal `agent_settled` lifecycle event.
- Skips compaction when the current session branch already ends in a compaction entry.
- Treats Pi's `Already compacted` callback as an idempotent success instead of surfacing duplicate errors.
- Adds regression coverage for native-compaction-first races, duplicate callbacks, in-flight guards, and trigger re-arming.

### Notable pull requests

- [#1006](https://github.com/gugu91/pinet/pull/1006) — avoid duplicate compaction after native auto-compaction

See the [full change set since v0.2.9](https://github.com/gugu91/pinet/compare/v0.2.9...v0.2.10).

## [0.2.9] - 2026-08-23

Pinet v0.2.9 turns the standalone single-agent goal window into an actionable control surface while reducing the persistent goal display to compact status.

### Version verification

- `pi-extensions` — `0.2.9` (private repo package)
- `@pinet/transport-core` — `0.2.9`
- `@pinet/broker-core` — `0.2.9`
- `@pinet/pinet-core` — `0.2.9`
- `@pinet/imessage-bridge` — `0.2.9`
- `@pinet/slack-bridge` — `0.2.9`
- `@pinet/model-aware-compaction` — `0.2.9`
- `@pinet/agent-goal` — `0.2.9`

### Release highlights

- Adds keyboard-accessible pause, resume, complete, clear, and close actions to the interactive `/goal` modal.
- Requires explicit confirmation before complete and clear actions.
- Refreshes detailed goal information in the modal after lifecycle changes.
- Removes the duplicated verbose persistent widget and retains compact footer status.
- Preserves detailed textual `/goal` output for headless contexts and strict narrow-width rendering.

### Notable pull requests

- [#1002](https://github.com/gugu91/pinet/pull/1002) — make the goal window actionable and compact the passive UI

See the [full change set since the v0.2.8 release commit](https://github.com/gugu91/pinet/compare/aff1cb6e6d10a2b3c96f1e24dd004e3196223f66...v0.2.9).

## [0.2.8] - 2026-08-23

Pinet v0.2.8 makes independent validation automatic for every settled single-agent goal run while keeping the coordinated seven-package release set aligned.

### Version verification

- `pi-extensions` — `0.2.8` (private repo package)
- `@pinet/transport-core` — `0.2.8`
- `@pinet/broker-core` — `0.2.8`
- `@pinet/pinet-core` — `0.2.8`
- `@pinet/imessage-bridge` — `0.2.8`
- `@pinet/slack-bridge` — `0.2.8`
- `@pinet/model-aware-compaction` — `0.2.8`
- `@pinet/agent-goal` — `0.2.8`

### Release highlights

- Invokes the independent evaluator exactly once for every settled active-goal run, even when the worker does not call `update_goal`.
- Treats `update_goal` as an optional completion or blocker hint rather than a prerequisite for validation.
- Evaluates goals created during the current run without charging work that may have happened before goal creation.
- Preserves projected and concurrent settlement accounting through the durable compare-and-swap evaluation path.
- Defers busy-session continuation attempts without consuming the bounded failure retry budget.
- Retains the compatibility `goal.auto_continued` event for no-hint continuation decisions.

### Notable pull requests

- [#998](https://github.com/gugu91/pinet/pull/998) — validate every settled goal run automatically

See the [full change set since the v0.2.7 release commit](https://github.com/gugu91/pinet/compare/a4f95bcdd32754fcef83cc13189d8ccadb8e93f6...v0.2.8).

## [0.2.7] - 2026-08-22

Pinet v0.2.7 adds a focused Pi-native goal window to the standalone single-agent goal loop while keeping the coordinated seven-package release set aligned.

### Version verification

- `pi-extensions` — `0.2.7` (private repo package)
- `@pinet/transport-core` — `0.2.7`
- `@pinet/broker-core` — `0.2.7`
- `@pinet/pinet-core` — `0.2.7`
- `@pinet/imessage-bridge` — `0.2.7`
- `@pinet/slack-bridge` — `0.2.7`
- `@pinet/model-aware-compaction` — `0.2.7`
- `@pinet/agent-goal` — `0.2.7`

### Release highlights

- Opens a centered Pi-native goal window from `/goal` in interactive sessions without requiring tmux or a separate process.
- Shows the objective, lifecycle state, iteration/token/runtime budgets, latest evaluator guidance, and continuation state in one focused view.
- Supports Escape, Enter, `q`, and Ctrl+C dismissal while retaining the passive footer/widget status.
- Preserves textual behavior in non-interactive contexts through Pi's real `ui.custom()` capability contract.
- Enforces Pi's strict render-width contract, including bounded output for terminal widths below eight columns.

### Notable pull requests

- [#994](https://github.com/gugu91/pinet/pull/994) — add the minimal Pi-native goal window

See the [full change set since v0.2.6](https://github.com/gugu91/pinet/compare/v0.2.6...v0.2.7).

## [0.2.6] - 2026-08-22

Pinet v0.2.6 adds the standalone durable single-agent goal loop and tightens Slack bridge startup, mode boundaries, and dependency/release hygiene. It expands the coordinated npm release set to seven `@pinet/*` packages.

### Version verification

- `pi-extensions` — `0.2.6` (private repo package)
- `@pinet/transport-core` — `0.2.6`
- `@pinet/broker-core` — `0.2.6`
- `@pinet/pinet-core` — `0.2.6`
- `@pinet/imessage-bridge` — `0.2.6`
- `@pinet/slack-bridge` — `0.2.6`
- `@pinet/model-aware-compaction` — `0.2.6`
- `@pinet/agent-goal` — `0.2.6` (initial release)

### Release highlights

- Adds `@pinet/agent-goal`, a standalone Pi extension for one durable, bounded goal per agent session. Agents can create and inspect goals, request independently evaluated completion or blocking decisions, and continue ordinary settled work without an evaluator call.
- Persists goal state, terminal candidates, evaluator work, continuation claims, usage accounting, and recovery state through replaceable memory and SQLite adapters.
- Adds bounded iteration, token, runtime, checkpoint, evaluator-retry, and continuation-retry policies with a Pi-native dashboard and headless command fallback.
- Atomically preserves every settlement that arrives during in-flight evaluation and schedules process-local recovery for deferred or orphaned continuations without requiring Pinet, Slack, a broker, RALPH, tmux, subagents, or spawned Pi processes.
- Gates Slack runtime guidance and tools by the active mode, reducing irrelevant prompt/tool surface outside Pinet operation.
- Speeds up and simplifies Slack bridge startup while removing stale startup support and fixing a broker reload lifecycle test race.
- Replaces ESLint with Oxlint across the workspace and delays newly released dependencies during automated updates.
- Removes the obsolete browser Playwright extension from the repository.

### Notable pull requests

- [#990](https://github.com/gugu91/pinet/pull/990) — add the standalone single-agent goal loop
- [#986](https://github.com/gugu91/pinet/pull/986) — fix the broker reload lifecycle test race
- [#985](https://github.com/gugu91/pinet/pull/985) — simplify Slack bridge startup support
- [#984](https://github.com/gugu91/pinet/pull/984) — speed up Slack bridge startup
- [#981](https://github.com/gugu91/pinet/pull/981) — replace ESLint with Oxlint
- [#980](https://github.com/gugu91/pinet/pull/980) — gate Slack runtime guidance and tools by mode
- [#979](https://github.com/gugu91/pinet/pull/979) — remove the browser Playwright extension
- [#977](https://github.com/gugu91/pinet/pull/977) — delay newly released dependencies

See the [full change set since v0.2.5](https://github.com/gugu91/pinet/compare/v0.2.5...v0.2.6).

## [0.2.5] - 2026-07-30

Pinet v0.2.5 adds Herdr-backed subtree workers, broker-managed hibernation and safer worker recovery. It keeps the coordinated `@pinet/*` package set aligned.

### Version verification

- `pi-extensions` — `0.2.5` (private repo package)
- `@pinet/transport-core` — `0.2.5`
- `@pinet/broker-core` — `0.2.5`
- `@pinet/pinet-core` — `0.2.5`
- `@pinet/imessage-bridge` — `0.2.5`
- `@pinet/slack-bridge` — `0.2.5`
- `@pinet/model-aware-compaction` — `0.2.5`

### Release highlights

- Adds Herdr as a subtree worker runtime. Runtime kinds and locators now flow through persistence, registration, lifecycle controls and session search.
- Migrates existing tmux runtime records without changing tmux as the default. Older clients remain compatible with session-search responses.
- Adds broker-managed hibernation and wake flows with fenced lifecycle transitions, live runtime adapters and default-off activation.
- Hardens subtree startup, retries and teardown. Pinet now serialises startup, returns durable spawn handles, rolls back incomplete launches and recovers orphaned Herdr panes after restart.
- Improves broker recovery. Pinet can replace stranded brokers, preserve workers across broker reloads and reconnect disconnected followers safely.
- Fixes a Slack Socket Mode reconnect race and holds inbound delivery while Pi compaction is active.
- Enforces read-only lane rules and classifies `pinet:spawn` as a write operation.
- Replaces loose JSON and configuration boundaries with named data transfer objects across the transport, broker and bridge packages. The new agent-standards lint prevents these type escapes returning.
- Adds shared timeout, sleep and backoff primitives to `@pinet/transport-core`, while preserving public declaration compatibility.
- Adds the Pinet website and improves dispatcher handling for oversized output.

### Notable pull requests

- [#972](https://github.com/gugu91/pinet/pull/972) — add the Herdr launch backend for subtree workers
- [#973](https://github.com/gugu91/pinet/pull/973) — preserve workers across broker reloads
- [#971](https://github.com/gugu91/pinet/pull/971) — fix the Slack Socket Mode reconnect race
- [#969](https://github.com/gugu91/pinet/pull/969) — add the runtime-kind schema and worker launch seam
- [#968](https://github.com/gugu91/pinet/pull/968) — block lane mutations under read-only guardrails
- [#964](https://github.com/gugu91/pinet/pull/964) — serialise subtree startup and return durable spawn handles
- [#956](https://github.com/gugu91/pinet/pull/956) — reconnect disconnected Pinet followers
- [#954](https://github.com/gugu91/pinet/pull/954) — hold inbound delivery while Pi compaction runs
- [#952](https://github.com/gugu91/pinet/pull/952) — recover stranded brokers safely
- [#930](https://github.com/gugu91/pinet/pull/930) — add default-off hibernation runtime activation
- [#927](https://github.com/gugu91/pinet/pull/927) — add live hibernation runtime adapters
- [#871](https://github.com/gugu91/pinet/pull/871) — preserve transport payload declaration compatibility
- [#864](https://github.com/gugu91/pinet/pull/864) — extract shared async transport primitives
- [#863](https://github.com/gugu91/pinet/pull/863) — add the Pinet website
- [#861](https://github.com/gugu91/pinet/pull/861) — add the agent coding standards lint

See the [full change set since the 0.2.4 release commit](https://github.com/gugu91/pinet/compare/45314342b36c8c2c29087fbc0b9ca1634c40d5e3...9a42f8eb6a191c430a204efc43594226734c7c28).

## [0.2.4] - 2026-07-06

Pinet v0.2.4 keeps the coordinated `@pinet/*` package set aligned and ships the Slack-bridge thread-ownership hardening merged after the v0.2.3 release prep.

### Version verification

- `pi-extensions` — `0.2.4` (private repo package)
- `@pinet/transport-core` — `0.2.4`
- `@pinet/broker-core` — `0.2.4`
- `@pinet/pinet-core` — `0.2.4`
- `@pinet/imessage-bridge` — `0.2.4`
- `@pinet/slack-bridge` — `0.2.4`
- `@pinet/model-aware-compaction` — `0.2.4`

### Release highlights

- Stops followers from taking over Slack threads they do not own by refusing the direct-Slack `chat.postMessage` fallback in `deliverSlackMessage` whenever Pinet is enabled but the broker is unavailable.
- Refuses cross-owner `slackProxy chat.postMessage` at the broker before the Slack API is called, closing the first-responder-wins claim race between `applyAdapterCapabilityEffects` and `router.claimThread`.
- Requires a registered caller on `adapter.capability` and legacy `slack.proxy` (matching every other ownership-sensitive broker RPC) and keeps a defense-in-depth refusal for threaded `chat.postMessage` from unregistered callers.
- Updates in-agent Slack guidance so agents wait for the broker or ask for a transfer on `broker is unavailable` / `already owned by another agent` instead of retrying via `post_channel`.
- Freezes the clock in the `pinet-tools` schedule formatter test so CI stays deterministic past hardcoded fire-at timestamps.

### Included pull requests since the v0.2.3 repo release prep

- [#856](https://github.com/gugu91/extensions/pull/856) — fix(slack-bridge): stop workers taking over Slack threads they don't own (#855)
- [#853](https://github.com/gugu91/extensions/pull/853) — docs: rewrite Pinet READMEs

## [0.2.3] - 2026-06-30

Pinet v0.2.3 re-synchronizes the coordinated `@pinet/*` package set after the partial v0.2.2 npm publish, and includes the Slack/Pinet fixes merged after the v0.2.2 release prep.

### Version verification

- `pi-extensions` — `0.2.3` (private repo package)
- `@pinet/transport-core` — `0.2.3`
- `@pinet/broker-core` — `0.2.3`
- `@pinet/pinet-core` — `0.2.3`
- `@pinet/imessage-bridge` — `0.2.3`
- `@pinet/slack-bridge` — `0.2.3`
- `@pinet/model-aware-compaction` — `0.2.3`

### Release highlights

- Requires explicit Pinet invocation before guarded Slack-context routing so uninvoked guarded Slack messages do not start unintended assistant work.
- Fixes Slack mrkdwn bold rendering by preserving `*bold*` output instead of converting it to unsupported double-asterisk Markdown.
- Adds Pinet worker session lookup support so broker/operator tooling can resolve worker sessions more reliably.

### Included pull requests since the v0.2.2 repo release prep

- [#837](https://github.com/gugu91/extensions/pull/837) — Add Pinet worker session lookup
- [#838](https://github.com/gugu91/extensions/pull/838) — Require explicit Pinet invocation in guarded Slack contexts
- [#840](https://github.com/gugu91/extensions/pull/840) — Fix Slack Markdown bold rendering

## [0.2.2] - 2026-06-26

Pinet v0.2.2 keeps the coordinated `@pinet/*` package set aligned and fixes proactive compaction interrupting active model/tool loops.

### Version verification

- `pi-extensions` — `0.2.2` (private repo package)
- `@pinet/transport-core` — `0.2.2`
- `@pinet/broker-core` — `0.2.2`
- `@pinet/pinet-core` — `0.2.2`
- `@pinet/imessage-bridge` — `0.2.2`
- `@pinet/slack-bridge` — `0.2.2`
- `@pinet/model-aware-compaction` — `0.2.2`

### Release highlights

- Defers model-aware proactive compaction until `agent_end`, after the complete model/tool loop has settled.
- Prevents manual compaction from aborting the model continuation that consumes a completed tool result.
- Adds lifecycle regression coverage without injecting a synthetic continuation message.

### Included pull requests since v0.2.1

- [#846](https://github.com/gugu91/extensions/pull/846) — fix: compact after agent loop settles

## [0.2.1] - 2026-06-26

Pinet v0.2.1 keeps the coordinated `@pinet/*` package set aligned and adds `@pinet/model-aware-compaction` as its sixth package.

### Version verification

- `pi-extensions` — `0.2.1` (private repo package)
- `@pinet/transport-core` — `0.2.1`
- `@pinet/broker-core` — `0.2.1`
- `@pinet/pinet-core` — `0.2.1`
- `@pinet/imessage-bridge` — `0.2.1`
- `@pinet/slack-bridge` — `0.2.1`
- `@pinet/model-aware-compaction` — `0.2.1` (initial release)

### Release highlights

- Adds model-aware proactive compaction with ordered exact or wildcard model rules and active-context token limits.
- Prevents duplicate compactions while one is in flight and adds optional diagnostics plus `/model-aware-compaction-status`.
- Keeps the existing Pinet libraries and bridges version-aligned on `0.2.1`.
- Includes the compact Pinet read-help refinements merged after `0.2.0`.

### Included pull requests since v0.2.0

- [#842](https://github.com/gugu91/extensions/pull/842) — docs(pinet): make compact read defaults explicit
- [#844](https://github.com/gugu91/extensions/pull/844) — feat: add model-aware compaction extension

## [0.2.0] - 2026-06-17

Pinet v0.2.0 is the first coordinated `@pinet/*` package release cut from the current `main` branch. It intentionally includes only work already merged through PR #829 and aligns all publishable Pinet packages on the same version.

### Version verification

- `pi-extensions` — `0.2.0` (private repo package)
- `@pinet/transport-core` — `0.2.0`
- `@pinet/broker-core` — `0.2.0`
- `@pinet/pinet-core` — `0.2.0`
- `@pinet/imessage-bridge` — `0.2.0`
- `@pinet/slack-bridge` — `0.2.0`

### Release highlights

- Adds worker-owned Pinet subtree broker support for safer distributed worker coordination.
- Improves Slack/Pinet operator surfaces: raw Slack file access, channel-post file handling, compact dispatcher output by default, expanded human-readable Pinet tables, send previews, and the app-name agents slash command.
- Hardens Slack reaction-trigger routing, including ignoring reaction triggers by default, denying uninvoked-thread reaction routing, and canonicalizing guarded delete actions from resolved targets.
- Guards npm package GitHub metadata for the public package set.
- Preserves Slack/external requeue affinity so disconnected-owner follow-ups do not drift to unrelated idle workers.
- Tightens broker cleanup prompt policy for safer maintenance behavior.

### Included pull requests since v0.1.2

- [#766](https://github.com/gugu91/extensions/pull/766) — feat(pinet): support worker-owned subtree brokers
- [#807](https://github.com/gugu91/extensions/pull/807) — feat(slack): support raw Slack file access
- [#808](https://github.com/gugu91/extensions/pull/808) — fix(slack): support files on channel posts
- [#810](https://github.com/gugu91/extensions/pull/810) — fix(slack-bridge): ignore Slack reaction triggers by default
- [#813](https://github.com/gugu91/extensions/pull/813) — fix(slack-bridge): deny reaction routing in uninvoked threads
- [#815](https://github.com/gugu91/extensions/pull/815) — fix(slack-bridge): canonicalize guarded delete actions from resolved targets
- [#826](https://github.com/gugu91/extensions/pull/826) — fix: guard npm package GitHub metadata
- [#825](https://github.com/gugu91/extensions/pull/825) — fix(pinet): keep dispatcher output compact by default
- [#823](https://github.com/gugu91/extensions/pull/823) — feat(pinet): human-readable expanded agents table + send preview (#763, #762)
- [#805](https://github.com/gugu91/extensions/pull/805) — feat(slack): add app-name agents slash command
- [#828](https://github.com/gugu91/extensions/pull/828) — fix(pinet): preserve Slack requeue affinity
- [#829](https://github.com/gugu91/extensions/pull/829) — Tighten broker cleanup prompt policy

## [0.1.4] - 2026-04-23

Pinet v0.1.4 is a focused patch release for `@gugu910/pi-slack-bridge` that fixes Slack external file-upload requests to use the form encoding Slack expects. The runtime behavior change is intentionally narrow: `slack_upload` should stop failing with `invalid_arguments` when it calls `files.getUploadURLExternal` and `files.completeUploadExternal`.

### Version verification

- `pi-extensions` — `0.1.4` (private repo package)
- `@gugu910/pi-slack-bridge` — `0.1.4`
- `@gugu910/pi-nvim-bridge` — `0.1.0` (unchanged)
- `@gugu910/pi-neon-psql` — `0.1.0` (unchanged)
- `@gugu910/pi-slack-api` — `0.2.0` (unchanged)

### Release highlights

- Form-encodes `files.getUploadURLExternal` and `files.completeUploadExternal` in the shared Slack request helper so Slack file uploads no longer send JSON to endpoints that expect URL-encoded form bodies.
- Adds focused regression coverage for both external upload methods, including structured payload serialization for the completion request.

## [0.1.3] - 2026-04-08

Pinet v0.1.3 is a narrow follow-up patch for `@gugu910/pi-slack-bridge` after `0.1.2` was published with real Slack identifiers in the package README settings example. Because published npm tarballs are immutable, this release corrects the npm-visible package surface with scrubbed example placeholders while leaving the runtime behavior unchanged.

### Version verification

- `pi-extensions` — `0.1.3` (private repo package)
- `@gugu910/pi-slack-bridge` — `0.1.3`
- `@gugu910/pi-nvim-bridge` — `0.1.0` (unchanged)
- `@gugu910/pi-neon-psql` — `0.1.0` (unchanged)
- `@gugu910/pi-slack-api` — `0.2.0` (unchanged)

### Release highlights

- Scrubs the npm-facing `slack-bridge/README.md` settings example so `allowedUsers` and `defaultChannel` use obviously fake placeholders instead of real Slack identifiers.
- Keeps the publish surface otherwise aligned with `0.1.2`; this is a release-docs correction patch before the next publish.

## [0.1.2] - 2026-04-08

Pinet v0.1.2 is a refreshed patch release for `@gugu910/pi-slack-bridge` cut from current `main`. The earlier `0.1.1` repo prep never shipped to npm, so this release supersedes that unpublished cut while keeping the release surface intentionally focused: the Slack bridge package bumps to `0.1.2`, the private monorepo package moves to `0.1.2` for repo-level version tracking, and the other workspace packages stay at their current versions.

### Version verification

- `pi-extensions` — `0.1.2` (private repo package)
- `@gugu910/pi-slack-bridge` — `0.1.2`
- `@gugu910/pi-nvim-bridge` — `0.1.0` (unchanged)
- `@gugu910/pi-neon-psql` — `0.1.0` (unchanged)
- `@gugu910/pi-slack-api` — `0.2.0` (unchanged)

### Release highlights

- Carries forward the unpublished `0.1.1` prep surface already on `main`: mesh-auth hardening, structured control messages, Home tab/dashboard work, stable-ID thread binding, backlog recovery, and `slack_project_create`.
- Finishes publish-surface polish for the public Slack bridge package, including MIT license packaging, runtime TypeBox dependency placement, and dry-run pack verification improvements.
- Fixes several operator-facing Pinet reliability gaps that landed after the original `0.1.1` prep: closeout ack echo loops, stale worker-status residue, broker-targeted backlog recovery during inbox sync, top-level Slack tool recovery after reload, bogus operator-update task residue, and Slack thread reply routing / durable explicit takeover handling.
- Includes the merged helper-only skin-voice guidance refresh that shipped on `main` after the earlier prep.

### Included pull requests since the unpublished `0.1.1` prep

- [#302](https://github.com/gugu91/extensions/pull/302) — chore: adopt MIT license for repo and workspace packages
- [#303](https://github.com/gugu91/extensions/pull/303) — fix: stop Pinet closeout acknowledgement echo loops (#299)
- [#305](https://github.com/gugu91/extensions/pull/305) — fix: finish slack-bridge 0.1.1 publish hygiene
- [#306](https://github.com/gugu91/extensions/pull/306) — fix: stop stale worker status residue
- [#308](https://github.com/gugu91/extensions/pull/308) — fix: recover broker-targeted backlog during inbox sync (#307)
- [#310](https://github.com/gugu91/extensions/pull/310) — fix: recover top-level Slack tools after reload (#279)
- [#311](https://github.com/gugu91/extensions/pull/311) — fix: stop operator update task residue (#309)
- [#313](https://github.com/gugu91/extensions/pull/313) — feat: enrich Pinet skin voice guidance (#270)
- [#321](https://github.com/gugu91/extensions/pull/321) — fix: keep Slack thread replies on the right worker (#319)

## [0.1.1] - 2026-04-08

Pinet v0.1.1 was the original unpublished release-prep cut for `@gugu910/pi-slack-bridge`. It is kept here for historical context because `0.1.2` supersedes it as the first publish-ready patch cut after `0.1.0`.

### Version verification

- `pi-extensions` — `0.1.1` (private repo package)
- `@gugu910/pi-slack-bridge` — `0.1.1`
- `@gugu910/pi-nvim-bridge` — `0.1.0` (unchanged)
- `@gugu910/pi-neon-psql` — `0.1.0` (unchanged)
- `@gugu910/pi-slack-api` — `0.2.0` (unchanged)

### Release highlights

- Hardened Pinet coordination with configurable shared-secret mesh auth, structured control messages, reconnect refresh, and headless-subagent isolation.
- Documented the v0.1.1 mesh-auth behavior now visible on `main`: optional auth when unset, `meshSecret` / `meshSecretPath` settings and `PINET_MESH_SECRET` / `PINET_MESH_SECRET_PATH` env fallbacks, friendly missing-secret-file failures for configured followers, and explicit older/no-auth broker compatibility errors with no silent downgrade.
- Added the Pinet Home tab dashboard, an end-user README refresh, and broker routing fixes such as stable-ID thread binding.
- Fixed targeted backlog recovery so stale targeted A2A backlog no longer remains stranded after purge and maintenance.
- Fixed broker-targeted startup backlog recovery so persisted post-restart pending backlog is rebound during startup instead of waiting for a later maintenance pass.
- Included Slack bridge package surface updates that shipped in the same cut, including `slack_project_create` and channel canvas dedup.

### Included pull requests

- [#231](https://github.com/gugu91/extensions/pull/231) — feat: add Pinet Home tab dashboard
- [#243](https://github.com/gugu91/extensions/pull/243) — fix: auto-refresh Pinet registration on reconnect
- [#244](https://github.com/gugu91/extensions/pull/244) — fix: stop headless subagents from joining Pinet
- [#250](https://github.com/gugu91/extensions/pull/250) — feat: structure Pinet control messages
- [#257](https://github.com/gugu91/extensions/pull/257) — feat: add pinet mesh authentication with local shared secret
- [#258](https://github.com/gugu91/extensions/pull/258) — feat: add slack_project_create tool
- [#268](https://github.com/gugu91/extensions/pull/268) — fix: thread binding uses stable IDs first, fuzzy name as fallback
- [#272](https://github.com/gugu91/extensions/pull/272) — fix: drop stale targeted backlog after purge
- [#289](https://github.com/gugu91/extensions/pull/289) — fix: make Pinet mesh secret config-driven and optional
- [#292](https://github.com/gugu91/extensions/pull/292) — fix: clarify Pinet auth method mismatch
- [#298](https://github.com/gugu91/extensions/pull/298) — fix: recover broker-targeted backlog during startup

## [0.1.0] - 2026-04-02

First public release prep for the Pi extensions monorepo. This cut rolls up 66 pull requests merged on 2026-04-02 and aligns with the publish-ready package metadata landed in [#222](https://github.com/gugu91/extensions/pull/222).

> Note: issue #196 was originally filed as `v0.0.1`, but the publish-ready package versions on `main` are already `0.1.0`, so this changelog follows the versions actually present in the repo.

### Version verification

- `pi-extensions` — `0.1.0`
- `@gugu910/pi-slack-bridge` — `0.1.0`
- `@gugu910/pi-nvim-bridge` — `0.1.0`
- `@gugu910/pi-neon-psql` — `0.1.0`
- `@gugu910/pi-slack-api` — `0.1.0`
- `@gugu910/pi-ext-types` — `0.1.0`

### Release highlights

- Slack Bridge grew into a much broader operator surface: scheduling, uploads, canvases, Block Kit, bookmarks, pinning, exports, modals, presence, deploy tooling, and broker observability.
- Pinet broker/worker coordination was hardened across routing, reconnects, stale agent cleanup, RALPH reporting, wake-ups, inbox delivery, worktree enforcement, and broadcast/delegation flows.
- Packaging and workspace infrastructure were prepared for public npm distribution with publish metadata, generated Slack API packaging, shared types, and expanded automated coverage.

### Features (24)

- [#116](https://github.com/gugu91/extensions/pull/116) — ralph loop nudge followUp delivery + agent observability (#102, #103)
- [#152](https://github.com/gugu91/extensions/pull/152) — expose agent PIDs in pinet_agents tool output (#117)
- [#180](https://github.com/gugu91/extensions/pull/180) — add pinet-unfollow command (#176)
- [#181](https://github.com/gugu91/extensions/pull/181) — report worker task completion status in RALPH loop
- [#187](https://github.com/gugu91/extensions/pull/187) — add pinet reload and exit controls (#118)
- [#189](https://github.com/gugu91/extensions/pull/189) — steer delegation through Pinet
- [#190](https://github.com/gugu91/extensions/pull/190) — enforce main-checkout worktree rule
- [#193](https://github.com/gugu91/extensions/pull/193) — add Pinet broadcast channels
- [#194](https://github.com/gugu91/extensions/pull/194) — add scheduled Pinet wake-ups
- [#200](https://github.com/gugu91/extensions/pull/200) — add Slack canvas tools (#26)
- [#201](https://github.com/gugu91/extensions/pull/201) — add Slack file upload tool (#34)
- [#204](https://github.com/gugu91/extensions/pull/204) — add Slack manifest deploy command
- [#206](https://github.com/gugu91/extensions/pull/206) — add agent-name personalities
- [#208](https://github.com/gugu91/extensions/pull/208) — add generated Slack API workspace package
- [#213](https://github.com/gugu91/extensions/pull/213) — add Slack scheduled message tool (#33)
- [#216](https://github.com/gugu91/extensions/pull/216) — add Slack pinning and bookmarks tools (#25)
- [#218](https://github.com/gugu91/extensions/pull/218) — add pinet idle/free signal (#214)
- [#219](https://github.com/gugu91/extensions/pull/219) — add reaction-triggered Slack actions
- [#220](https://github.com/gugu91/extensions/pull/220) — add Slack thread export tool (#29)
- [#221](https://github.com/gugu91/extensions/pull/221) — add Slack Block Kit support (#27)
- [#224](https://github.com/gugu91/extensions/pull/224) — add Slack presence awareness
- [#225](https://github.com/gugu91/extensions/pull/225) — add broker control plane canvas dashboard (#217)
- [#229](https://github.com/gugu91/extensions/pull/229) — add Slack modal workflows
- [#230](https://github.com/gugu91/extensions/pull/230) — add broker activity log channel (#30)

### Fixes (34)

- [#113](https://github.com/gugu91/extensions/pull/113) — allow Ralph loop follow-up repeats after cooldown
- [#115](https://github.com/gugu91/extensions/pull/115) — deliver pinet messages to broker's own inbox
- [#145](https://github.com/gugu91/extensions/pull/145) — enforce single-broker lock to prevent split-brain (#119)
- [#146](https://github.com/gugu91/extensions/pull/146) — add color entropy to agent names (issue #120)
- [#148](https://github.com/gugu91/extensions/pull/148) — broker routing regression + worker reply tool rules (#121, #122)
- [#150](https://github.com/gugu91/extensions/pull/150) — clean up stale agent rows and orphaned threads on purge (issue #140)
- [#151](https://github.com/gugu91/extensions/pull/151) — cap Slack API retry at 3 attempts to prevent infinite recursion (#124)
- [#153](https://github.com/gugu91/extensions/pull/153) — add hard broker guardrails to prevent coding (#107)
- [#154](https://github.com/gugu91/extensions/pull/154) — make claimThread atomic to prevent TOCTOU race (#125)
- [#155](https://github.com/gugu91/extensions/pull/155) — bound in-memory caches with TTL + max-size eviction (#129)
- [#159](https://github.com/gugu91/extensions/pull/159) — clean unregister inbox rows and requeue a2a work (#137)
- [#160](https://github.com/gugu91/extensions/pull/160) — add proper types for activeBroker and brokerClient (Issue #126)
- [#161](https://github.com/gugu91/extensions/pull/161) — clear broken reconnect state after re-register failure (#139)
- [#162](https://github.com/gugu91/extensions/pull/162) — remove blocking execSync from agent metadata lookup (#133)
- [#163](https://github.com/gugu91/extensions/pull/163) — harden broker JSON-RPC request validation (#147)
- [#166](https://github.com/gugu91/extensions/pull/166) — remove dead code client-extension.ts
- [#167](https://github.com/gugu91/extensions/pull/167) — centralize hardcoded socket and database paths
- [#168](https://github.com/gugu91/extensions/pull/168) — warn when SQLite WAL mode falls back (#142)
- [#169](https://github.com/gugu91/extensions/pull/169) — keep local subagents out of the Pinet mesh (#156)
- [#170](https://github.com/gugu91/extensions/pull/170) — share TypeBox through workspace package (#144)
- [#177](https://github.com/gugu91/extensions/pull/177) — stop replaying stale RALPH ghost alerts
- [#178](https://github.com/gugu91/extensions/pull/178) — abort in-flight Slack API calls on shutdown (#135)
- [#179](https://github.com/gugu91/extensions/pull/179) — keep follower a2a traffic out of the Slack inbox (#175)
- [#183](https://github.com/gugu91/extensions/pull/183) — tighten broker client typing (#126)
- [#184](https://github.com/gugu91/extensions/pull/184) — expire stale Slack confirmation state
- [#185](https://github.com/gugu91/extensions/pull/185) — detect psql binary path across platforms (#141)
- [#186](https://github.com/gugu91/extensions/pull/186) — harden follower inbox delivery across restart
- [#192](https://github.com/gugu91/extensions/pull/192) — keep broker db authoritative for thread tracking (#131)
- [#195](https://github.com/gugu91/extensions/pull/195) — add timestamp to RALPH loop messages (#191)
- [#198](https://github.com/gugu91/extensions/pull/198) — report initial RALPH task status (#197)
- [#205](https://github.com/gugu91/extensions/pull/205) — use broker-specific generated names (#202)
- [#209](https://github.com/gugu91/extensions/pull/209) — timestamp all RALPH loop messages (#191)
- [#211](https://github.com/gugu91/extensions/pull/211) — route direct-addressed Slack threads (#207)
- [#226](https://github.com/gugu91/extensions/pull/226) — dedup retried Slack Socket Mode events

### Infrastructure & Quality (6)

- [#171](https://github.com/gugu91/extensions/pull/171) — consolidate duplicate Slack API wrappers (Issue #130)
- [#173](https://github.com/gugu91/extensions/pull/173) — extract Slack API and tool registrations from slack-bridge index (#127)
- [#174](https://github.com/gugu91/extensions/pull/174) — add nvim-bridge coverage (#134)
- [#188](https://github.com/gugu91/extensions/pull/188) — cover neon-psql core query helpers (#149)
- [#212](https://github.com/gugu91/extensions/pull/212) — cover neon-psql query execution path (#149)
- [#222](https://github.com/gugu91/extensions/pull/222) — prep packages for npm publish readiness

### Docs (2)

- [#210](https://github.com/gugu91/extensions/pull/210) — refresh repo README
- [#228](https://github.com/gugu91/extensions/pull/228) — add Pinet philosophy section
