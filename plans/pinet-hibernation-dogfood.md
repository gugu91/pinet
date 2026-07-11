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

Wake identity revival is fenced in independent layers. Successive wake attempts for one identity necessarily reuse the same lease id, fence token, and reserved generation (`runtime_generation + 1`, which does not advance until a runtime is accepted), so those three fields alone cannot tell a slow, timed-out earlier attempt's runtime apart from the current attempt's runtime. Each reservation therefore also mints a fresh **per-attempt nonce** (`reservation_nonce`, schema v20) that is threaded through the launch context into the runtime's registration; acceptance rejects a stale nonce (`nonce_mismatch`), fencing a superseded runtime out of a later reservation. Independently, a _launched-but-unaccepted_ runtime from a failed attempt is a possibly-leaked process, so before any retry the orchestrator best-effort stops it and only relaunches if it can confirm the process is gone; otherwise it fails closed to `reap-candidate` (`wake_ambiguous_launch`) rather than risk two runtimes for one identity. First, lifecycle **transitions** bind the _live, matching_ lease: a presented fence must equal the held lease's fence, and when the caller also binds lease identity (`leaseId` + `expectedOperation` + `now`) the DB additionally rejects an expired-but-unsuperseded lease and a wrong-operation lease. Lease fences are monotonic per agent (a re-acquisition after expiry bumps the fence), so a superseded holder is rejected on the fence; the identity binding closes the remaining "expired token still matches" and "hibernate lease drives a wake transition" holes. The orchestrator reads `now` fresh per transition, so a lease that expires mid-operation cannot authorize a later step. Second, socket registration into a durable identity is **state-gated then preflight-then-accept**: registration into a `hibernating` (mid-teardown), `reap-candidate` (quarantined), or `terminated` (closed) identity is rejected fail-closed regardless of any presented fence — only an exact fenced `waking`/`hibernated` revival is admissible. For that admissible case, `checkRuntimeGenerationAcceptable` validates the wake fence without mutating, and the registration mutation plus generation acceptance run **atomically in one broker transaction** (`registerAgentWithGenerationAcceptance`): if acceptance is rejected — e.g. the wake lease expires in the sub-millisecond window after the preflight — the whole registration mutation rolls back, so a refused revival never leaves the durable row with a mutated pid/metadata/connectivity. A later name conflict or registration failure therefore never advances the generation for a runtime that did not register, and the connection binds to the revived identity only on full success.

Because a legitimately long wake (process launch + runtime registration, retried across attempts) can outrun a single wake-lease TTL, the orchestrator **renews the lease per attempt** (`renewAgentLifecycleLease`) — extending the expiry without bumping the fence, and only while the lease is still held and unexpired, which preserves the crash-takeover guarantee. If renewal fails (ownership was lost to another broker), the wake fails closed. And the fail-closed **quarantine/abort transitions are deliberately unfenced administrative CAS transitions**: a recovery to `reap-candidate`/`active` must be able to fire even if our own lease expired mid-operation (otherwise the agent would be stranded in `waking`/`hibernating`), while the version CAS inside `transitionAgentLifecycle` still prevents clobbering a concurrent legitimate writer.

Two further **post-authority** transitions are also administrative, closing false-quarantine/strand windows on lease expiry:

- The final `waking -> live` promotion runs after generation acceptance has already bound the runtime to our exact lease/fence/reservation, so it is bookkeeping. If it stayed fenced, a lease that expired _after_ acceptance (e.g. a slow registration on the winning attempt) would throw and quarantine an already-live runtime; an administrative CAS promotes it correctly. This mirrors `recoverStrandedWakes`'s accepted→live completion.
- The pre-teardown hibernate **abort to `active`** (unsafe checkpoint, work-arrived, or a fault before `stopRuntime`) is a safety rollback. If it stayed fenced, a hibernate lease that expired during a slow checkpoint handshake would throw and leave the row stranded in `hibernating`; an administrative CAS rolls it back to `active`.

Forward-progress transitions that still hold real authority (`idle -> hibernating`, `hibernated -> waking`, and `hibernating -> hibernated`) remain fully fenced.

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

Schema v19–v20 is additive (v20 adds an `agent_wake_reservations.reservation_nonce` column, defaulted for existing rows). Existing rows remain `live`; old disconnected rows are not inferred as hibernated. New lifecycle tables hold sanitized runtime specs, one fenced active lease per logical agent, and append-only structured events. Event retention is bounded to the newest 10,000 rows. No prompt/message body, token, credential, or unrestricted environment is stored.

Downgrade leaves additive columns/tables in place. Roll back application code by disabling hibernation first, waking and draining all hibernated identities, then using the prior binary. Do not rewrite hibernated rows as disconnected ghosts.

## Controlled activation (future, separate approval)

1. Back up the broker DB and record exact extension commit. On broker startup (before dispatching any wakes), call `HibernationOrchestrator.recoverStrandedWakes()` once to reconcile crash-stranded state. It repairs three classes: (a) agents left in `waking` — completed to `live` when the generation was already accepted (reservation consumed, `runtime_generation` advanced past the checkpoint generation), otherwise failed closed to `reap-candidate`; (b) agents left in `hibernating` — the runtime's liveness is unknown so they fail closed to `reap-candidate` rather than risk a double launch on the next wake; (c) wake-queue rows orphaned in `dispatching` — returned to `queued` for a fresh dispatch pass (they also block the unique active-agent index until reclaimed). Reconciliation is **owner-aware**: it skips a row only when the lifecycle lease is unexpired **and owned by this live broker instance** (an operation we are actively driving). A lease owned by a _different_ instance is orphaned from a prior, now-dead broker — a crash normally leaves precisely such an unexpired-but-orphaned lease — so it is reconciled immediately (and the orphaned lease released) rather than skipped until its TTL elapses, which is what makes the ordinary quick-restart case recover instead of stranding forever. The finalize/safety writes that run outside a crash (the pre-teardown hibernate abort, the accepted `waking->live` promotion, and each dispatch-loop queue finalization) always release the lifecycle lease in a `finally` and are wrapped so a transient DB-write failure cannot crash the drain pass; any row left `dispatching`/`waking`/`hibernating` by such a failure carries no held lease and is therefore reclaimed by the next `recoverStrandedWakes` pass. A graceful `unregister` from a runtime that is still exiting after a quarantine preserves `reap-candidate` (alongside `hibernating`/`hibernated`/`waking`) as a soft disconnect, so the inbox, thread ownership, and runtime spec an operator needs to review the quarantine are never destroyed.
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
rather than emitted verbatim.

Runtime-authored `checkpoint.reason` is **redacted by construction**. Because the
reason is authored by the worker runtime, heuristic path-stripping is not enough —
it could still smuggle argv, env assignments (`TOKEN=secret`), CLI flags
(`--api-key x`), or extensionless relative paths onto an operator surface. So
`sanitizeCheckpointReasonCode` allowlists by _shape_: only a short single-token
machine code (`active_port_lease`, `checkpoint_timeout`, …) passes through;
anything else collapses to the static code `unspecified`. This runs where the
orchestrator composes an abort reason **and** where it persists the durable
checkpoint receipt, so no runtime-authored prose reaches the operator, command
JSON, telemetry, or the durable receipt.

Operator-authored reasons are a different trust class (a human wrote them) but
are still hardened by `sanitizeOperatorReason` at the orchestrator boundary
before any lifecycle row/event is written. It runs two composed passes:
`redactSecretAssignments` strips secret-bearing NON-path shapes — env/CLI
assignments (`TOKEN=deadbeef` → `TOKEN=<redacted>`) and CLI flag values
(`--api-key secret` / `--api-key=secret` → `--api-key <redacted>`), keeping the
non-secret key/flag name so the reason stays actionable — and then
`redactPathLikeTokens` redacts path-like tokens, now fail-closed on ambiguous
relative paths (any single-separator token that is not a small allowlisted prose
connective such as `and/or` is redacted, so `accounts/acme` is caught). The
`redactSecretAssignments` pass is a **whole-string, quote- and punctuation-aware,
fail-closed scanner** rather than a whitespace tokenizer, closing the earlier
bypasses where a quoted value (`TOKEN="dead beef"`), a spaced assignment
(`TOKEN = deadbeef`), or a punctuation-wrapped flag (`(--api-key=sk-123)`) leaked
part of the secret: quoted spans are redacted wholesale (that is exactly where a
space-separated secret hides), `key=value`/`key = value` keeps only the key name,
and a flag followed by a separate value token redacts the value. The
telemetry rollup redacts reason keys defense-in-depth. An _unresolved_ command
target is never echoed at all — not even redacted: `unknownHibernationTarget`
emits a stable, non-reversible `target:#<fingerprint>` so an operator can
correlate repeated failures of the same input without any content reaching a
surface.

Repo-allowlist authorization trusts **only** the broker-authored durable runtime
spec's `repoRoot` (captured at spawn). Mutable, worker-declared
`agent.metadata.repoRoot` is never used as a fallback, so a worker cannot
self-declare its way into an allowlisted repository; when no trusted spec exists
the identifier is null and the fail-closed gate refuses. Matching is **exact
identity, with no basename collapse**: the broker-derived `owner/repo` identifier
must equal an allowlist entry exactly (after normalizing Windows `\` separators
and trailing slashes), so a bare `extensions` entry never admits a different root
that merely shares the basename, and an `owner/repo` entry never admits a
different owner. Operators must therefore allowlist the exact broker-derived
identity.

Wake-trigger contention is disambiguated so a queued trigger is never silently
lost: only a _matching, unexpired wake lease_ resolves as a benign
`wake_in_progress` no-op (a real in-flight wake will drain the queue); any other
held lease (e.g. a lingering `hibernate` lease around a crash) resolves as a
distinct, retryable `wake_lease_contended` refusal, and the dispatcher requeues
the row (deferring that agent for the rest of the pass so the held lease cannot
spin the loop) rather than consuming it.

Command-result **retryability is classified by reason, not only by state**, so an
operator is never sent into a futile retry loop. A quarantine (`reap-candidate`)
needs manual review; a `missing_runtime_spec` failure (the durable launch
manifest is gone, so no relaunch can reconstruct it — re-spawn instead), an
`unknown_agent`, and a `not_hibernated:<state>` race are all **terminal
non-retryable** refusals carrying corrective guidance. Only a genuinely transient
safe-state failure (or the `wake_lease_contended` requeue above) is marked
retryable. In the dispatch drain loop, both the `wake()`-throws path and the
result path route their queue-row finalization through guarded writes: if the
`completeWakeQueueEntry` cancel/complete write itself throws, the row is left
`dispatching` (holding no lease) for `recoverStrandedWakes` to requeue rather than
crashing the pass and stranding every other queued agent.

Both the `agents` and `sessions` reads surface the redacted lifecycle
projection: a scannable per-agent tag in compact output, a compact redacted
summary array in compact structured (`json`) `data`, and the full redacted status
block in full output — durable hibernated/quarantined identities remain visible
even though they are disconnected from the live roster.

## Stop/rollback conditions

Immediately disable new hibernations on any duplicate accepted generation, affinity reroute/drop, queue order violation, stale-fence acceptance, ambiguous PID/tmux ownership, missing worktree, incompatible config drift, wake timeout beyond retry policy, or secrets/private message content in telemetry. Preserve DB evidence, wake/drain safely where ownership is proven, and quarantine ambiguous identities as `reap-candidate`.

## Known limits

V1 is same-host/same-user, broker-managed root workers only. It does not snapshot child processes or in-memory tool state, hibernate supervised subtrees/private tmux sockets, wake broadcast subscribers, migrate across hosts, or claim exactly-once message execution. SQLite transport remains durable at-least-once; fencing guarantees one accepted runtime generation, not exactly-once side effects.
