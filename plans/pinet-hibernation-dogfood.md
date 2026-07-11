# Pinet hibernation dogfood (#923)

> Status: behaviour implemented and proven in isolation; **not activated**. The
> orchestrator (cooperative checkpoint, graceful teardown, fenced cold wake,
> tmux/session restore, queued exactly-once ordered delivery), accepted-generation
> registration fencing in the real socket server, and lifecycle telemetry are
> covered by unit tests plus an isolated end-to-end test that runs a real SQLite
> DB and a real `BrokerSocketServer` over loopback while faking only the
> process/tmux adapters. No live broker/mesh reload, real hibernation, or real
> wake has been performed. Do not activate against a live broker until the draft
> PR has exact-head review and a separate activation approval.

## Safety model

Hibernation is reversible and distinct from `exit`/`reap`. A hibernated row retains stable identity, routing ownership, inbox, threads, lanes, tasks, scheduled wakes, runtime mapping, and tmux identity. Ambiguous evidence transitions to `reap-candidate`; it never guesses, reroutes affinity work, or kills a PID based on PID alone.

The durable identity survives a _graceful_ worker shutdown. During teardown the broker stops the worker process, whose shutdown path may send an `unregister`. For agents in a hibernation lifecycle state (`hibernating`/`hibernated`/`waking`), `BrokerDB.unregisterAgent` performs a soft disconnect — it records `disconnected_at` but preserves the inbox, owned threads, and resumability — instead of the ordinary full teardown (which deletes the inbox and releases threads). This keeps hibernation teardown correct regardless of whether the runtime exits abruptly or unregisters cleanly.

Crucially, that soft-disconnect is also protected from **routine maintenance**. A hibernated row is intentionally `disconnected` (no live socket), which would otherwise make it eligible for the ordinary disconnect-driven reapers. `pruneStaleAgents`, `purgeDisconnectedAgents`, and `repairThreadOwnership` all exclude the preserved lifecycle states (`hibernating`, `hibernated`, `waking`, and quarantined `reap-candidate`) via a fixed `lifecycle_state NOT IN (…)` predicate, so a maintenance pass never releases a hibernated identity's owned threads, requeues its inbox, or deletes the row. `terminated` remains ordinarily purgeable, and non-hibernation disconnected agents are still pruned/purged/repaired as before — the exclusion is targeted, not a blanket bypass.

Wake identity revival is fenced in independent layers. First, lifecycle **transitions** bind the _live, matching_ lease: a presented fence must equal the held lease's fence, and when the caller also binds lease identity (`leaseId` + `expectedOperation` + `now`) the DB additionally rejects an expired-but-unsuperseded lease and a wrong-operation lease. Lease fences are monotonic per agent (a re-acquisition after expiry bumps the fence), so a superseded holder is rejected on the fence; the identity binding closes the remaining "expired token still matches" and "hibernate lease drives a wake transition" holes. The orchestrator reads `now` fresh per transition, so a lease that expires mid-operation cannot authorize a later step. Second, socket registration into a durable identity is **state-gated then preflight-then-accept**: registration into a `hibernating` (mid-teardown), `reap-candidate` (quarantined), or `terminated` (closed) identity is rejected fail-closed regardless of any presented fence — only an exact fenced `waking`/`hibernated` revival is admissible. For that admissible case, `checkRuntimeGenerationAcceptable` validates the wake fence without mutating, and the registration mutation plus generation acceptance run **atomically in one broker transaction** (`registerAgentWithGenerationAcceptance`): if acceptance is rejected — e.g. the wake lease expires in the sub-millisecond window after the preflight — the whole registration mutation rolls back, so a refused revival never leaves the durable row with a mutated pid/metadata/connectivity. A later name conflict or registration failure therefore never advances the generation for a runtime that did not register, and the connection binds to the revived identity only on full success.

Because a legitimately long wake (process launch + runtime registration, retried across attempts) can outrun a single wake-lease TTL, the orchestrator **renews the lease per attempt** (`renewAgentLifecycleLease`) — extending the expiry without bumping the fence, and only while the lease is still held and unexpired, which preserves the crash-takeover guarantee. If renewal fails (ownership was lost to another broker), the wake fails closed. And the fail-closed **quarantine/abort transitions are deliberately unfenced administrative CAS transitions**: a recovery to `reap-candidate`/`active` must be able to fire even if our own lease expired mid-operation (otherwise the agent would be stranded in `waking`/`hibernating`), while the version CAS inside `transitionAgentLifecycle` still prevents clobbering a concurrent legitimate writer. Forward-progress transitions remain fully fenced.

Configuration defaults to **disabled** and observe-only:

```json
{
  "slack-bridge": {
    "hibernation": {
      "enabled": false,
      "mode": "observe",
      "allowedRepos": ["gugu91/extensions"],
      "graceMs": 3600000,
      "idleDebounceMs": 120000,
      "handshakeTimeoutMs": 30000,
      "wakeLeaseMs": 90000,
      "maxConcurrentWakes": 2,
      "maxConcurrentWakesPerRepo": 1
    }
  }
}
```

`enabled=false` stops new hibernations. It must not disable wake/drain for identities already hibernated.

## Migration

Schema v19 is additive. Existing rows remain `live`; old disconnected rows are not inferred as hibernated. New lifecycle tables hold sanitized runtime specs, one fenced active lease per logical agent, and append-only structured events. Event retention is bounded to the newest 10,000 rows. No prompt/message body, token, credential, or unrestricted environment is stored.

Downgrade leaves additive columns/tables in place. Roll back application code by disabling hibernation first, waking and draining all hibernated identities, then using the prior binary. Do not rewrite hibernated rows as disconnected ghosts.

## Controlled activation (future, separate approval)

1. Back up the broker DB and record exact extension commit. On broker startup (before dispatching any wakes), call `HibernationOrchestrator.recoverStrandedWakes()` once to reconcile crash-stranded state. It repairs three classes: (a) agents left in `waking` — completed to `live` when the generation was already accepted (reservation consumed, `runtime_generation` advanced past the checkpoint generation), otherwise failed closed to `reap-candidate`; (b) agents left in `hibernating` — the runtime's liveness is unknown so they fail closed to `reap-candidate` rather than risk a double launch on the next wake; (c) wake-queue rows orphaned in `dispatching` — returned to `queued` for a fresh dispatch pass (they also block the unique active-agent index until reclaimed). Agents whose lifecycle lease is still held (unexpired) are skipped.
2. Run observe-only for 24 hours; inspect refusal reasons and verify no runtime exits.
3. Permit one broker-managed root worker in this repository, `mode=manual`.
4. Confirm no active lane, pending outbound/control operation, port lease, detached UI/tool state, child process, private tmux socket, or uncommitted in-memory-only work.
5. Manually hibernate; confirm the Pi PID generation is gone and the recorded tmux session remains attachable.
6. Trigger wake independently by direct A2A, known Slack thread, lane assignment, scheduled wake, and manual wake. Confirm one accepted generation and ordered inbox delivery.
7. Restart the broker at each protocol boundary before considering `mode=auto`.

## Telemetry and report query

Lifecycle events use stable `correlation_id`, agent id, state/version/fence, reason/source/actor/outcome, queue depth/age, duration, and optional RSS before/after. They exclude bodies and prompts.

```sql
SELECT
  date(created_at) AS day,
  SUM(to_state = 'hibernated' AND outcome = 'accepted') AS hibernations,
  SUM(to_state = 'live' AND from_state = 'waking' AND outcome = 'accepted') AS wake_successes,
  SUM(outcome <> 'accepted') AS failures,
  ROUND(AVG(CASE WHEN from_state = 'waking' THEN duration_ms END), 1) AS mean_wake_ms,
  MAX(queue_depth) AS max_queue_depth,
  MAX(oldest_queue_age_ms) AS max_oldest_queue_age_ms,
  SUM(MAX(COALESCE(rss_bytes_before,0)-COALESCE(rss_bytes_after,0),0)) AS recovered_rss_bytes
FROM agent_lifecycle_events
GROUP BY date(created_at)
ORDER BY day;
```

For p95 wake latency, export `duration_ms` for accepted `waking -> live` events and compute the nearest-rank 95th percentile. Compare resident runtime count and measured RSS before/after each canary; estimates must be labelled estimates.

The same rollup is available in-process without SQL via
`summarizeHibernationTelemetry(events, retention?)` and
`formatHibernationTelemetry(summary)` in `broker-core` (fed by
`getRecentAgentLifecycleEvents` / `getAgentLifecycleRetentionInfo`). Both are pure
derivations of already-sanitized events — headline counts, mean/nearest-rank-p95
wake latency, max queue depth/age, estimated recovered RSS, and top refusal
reasons — so they are safe to surface in a CLI, dashboard, or Slack status reply
and never emit prompts, message bodies, tokens, or environment values.

For a single agent, `buildAgentLifecycleStatus(input)` and
`formatAgentLifecycleStatus(status)` compose an operator-safe, actionable view
from already-fetched inputs (`getAllAgents` lifecycle fields,
`getLatestAgentCheckpointReceipt`, `getAgentRuntimeSpec`, `listWakeQueue`,
`countInflightWakes`): lifecycle state/generation/version/policy, checkpoint
presence/safety/age/pending-inbox, 1-based wake queue position + trigger/reason,
bounded wake capacity (global + per-repo, with at-capacity flags), the most
recent refusal/quarantine cause, and `reap-candidate` quarantine. The runtime
spec is reported through `redactRuntimeSpec` — the sanctioned
redaction-by-construction boundary that exposes only presence flags, counts, an
opaque session ref, and a path-free repo basename, and never raw argv, env
values, or filesystem/socket paths.

Free-form operator strings (hibernate/wake reasons, echoed unknown targets, and
the target/reason that enter the tool's confirmation policy) pass through
`sanitizeOperatorReason`, which control-strips, single-lines, length-bounds, and
— via `redactPathLikeTokens` — replaces filesystem-path-like tokens (absolute,
`~`, `./`/`../`, Windows drive, multi-segment, and single-separator _file-like_
paths such as `accounts/acme.md`) with `<path>` so no private path or unix socket
path leaks into operator, confirmation, or JSON output, while ordinary prose
(e.g. `and/or`, `Node.js`) is preserved. `redactRuntimeSpec` splits the repo root
on both `/` and `\`, so a Windows repo root is reduced to a path-free basename
rather than emitted verbatim. Runtime-authored `checkpoint.reason` text is
sanitized **at ingestion** (when the orchestrator composes an abort reason) and
again where the command layer copies an executor-produced reason into its result,
and the telemetry rollup redacts reason keys **defense-in-depth**, so a private
path embedded in a worker's checkpoint reason never reaches the operator, command
JSON, or telemetry surface. The `pinet hibernate`/`wake` command layer normalizes
Windows `\` separators before deriving the owner/repo slug and matching the
fail-closed repo allowlist, so path provenance is OS-agnostic.

Repo-allowlist authorization trusts **only** the broker-authored durable runtime
spec's `repoRoot` (captured at spawn). Mutable, worker-declared
`agent.metadata.repoRoot` is never used as a fallback, so a worker cannot
self-declare its way into an allowlisted repository; when no trusted spec exists
the identifier is null and the fail-closed gate refuses.

Wake-trigger contention is disambiguated so a queued trigger is never silently
lost: only a _matching, unexpired wake lease_ resolves as a benign
`wake_in_progress` no-op (a real in-flight wake will drain the queue); any other
held lease (e.g. a lingering `hibernate` lease around a crash) resolves as a
distinct, retryable `wake_lease_contended` refusal, and the dispatcher requeues
the row (deferring that agent for the rest of the pass so the held lease cannot
spin the loop) rather than consuming it.

Both the `agents` and `sessions` reads surface the redacted lifecycle
projection: a scannable per-agent tag in compact output, a compact redacted
summary array in compact structured (`json`) `data`, and the full redacted status
block in full output — durable hibernated/quarantined identities remain visible
even though they are disconnected from the live roster.

## Stop/rollback conditions

Immediately disable new hibernations on any duplicate accepted generation, affinity reroute/drop, queue order violation, stale-fence acceptance, ambiguous PID/tmux ownership, missing worktree, incompatible config drift, wake timeout beyond retry policy, or secrets/private message content in telemetry. Preserve DB evidence, wake/drain safely where ownership is proven, and quarantine ambiguous identities as `reap-candidate`.

## Known limits

V1 is same-host/same-user, broker-managed root workers only. It does not snapshot child processes or in-memory tool state, hibernate supervised subtrees/private tmux sockets, wake broadcast subscribers, migrate across hosts, or claim exactly-once message execution. SQLite transport remains durable at-least-once; fencing guarantees one accepted runtime generation, not exactly-once side effects.
