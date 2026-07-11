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

Wake identity revival is fenced in independent layers. Successive wake attempts for one identity necessarily reuse the same lease id, fence token, and reserved generation (`runtime_generation + 1`, which does not advance until a runtime is accepted), so those three fields alone cannot tell a slow, timed-out earlier attempt's runtime apart from the current attempt's runtime. Each reservation therefore also mints a fresh **per-attempt nonce** (`reservation_nonce`, schema v20) that is threaded through the launch context into the runtime's registration; acceptance rejects a stale nonce (`nonce_mismatch`), fencing a superseded runtime out of a later reservation. Independently, a _launched-but-unaccepted_ runtime from a failed attempt is a possibly-leaked process, so before any retry the orchestrator best-effort stops it and only relaunches if it can **prove** the process is gone; otherwise it fails closed to `reap-candidate` (`wake_ambiguous_launch`) rather than risk two runtimes for one identity. That proof is addressed to the **attempt-bound handle** the launch returns (`RuntimeAttemptHandle`, keyed by the reservation nonce), never the durable spec: proving via the spec would target the pre-hibernation runtime's recorded PID generation — already dead — and so falsely "confirm stopped" while the freshly launched attempt kept running; a launch that yields no handle is unprovable and also fails closed. First, lifecycle **transitions** bind the _live, matching_ lease: a presented fence must equal the held lease's fence, and when the caller also binds lease identity (`leaseId` + `expectedOperation` + `now`) the DB additionally rejects an expired-but-unsuperseded lease and a wrong-operation lease. Lease fences are monotonic per agent (a re-acquisition after expiry bumps the fence), so a superseded holder is rejected on the fence; the identity binding closes the remaining "expired token still matches" and "hibernate lease drives a wake transition" holes. The orchestrator reads `now` fresh per transition, so a lease that expires mid-operation cannot authorize a later step. Second, socket registration into a durable identity is **state-gated then preflight-then-accept**: registration into a `hibernating` (mid-teardown), `reap-candidate` (quarantined), or `terminated` (closed) identity is rejected fail-closed regardless of any presented fence — only an exact fenced `waking`/`hibernated` revival is admissible. For that admissible case, `checkRuntimeGenerationAcceptable` validates the wake fence without mutating, and the registration mutation plus generation acceptance run **atomically in one broker transaction** (`registerAgentWithGenerationAcceptance`): if acceptance is rejected — e.g. the wake lease expires in the sub-millisecond window after the preflight — the whole registration mutation rolls back, so a refused revival never leaves the durable row with a mutated pid/metadata/connectivity. A later name conflict or registration failure therefore never advances the generation for a runtime that did not register, and the connection binds to the revived identity only on full success.

Because a legitimately long wake (process launch + runtime registration, retried across attempts) can outrun a single wake-lease TTL, the orchestrator **renews the lease per attempt** (`renewAgentLifecycleLease`) — extending the expiry without bumping the fence, and only while the lease is still held and unexpired, which preserves the crash-takeover guarantee. If renewal fails (ownership was lost to another broker), the wake fails closed. And the fail-closed **quarantine/abort transitions are deliberately unfenced administrative CAS transitions**: a recovery to `reap-candidate`/`active` must be able to fire even if our own lease expired mid-operation (otherwise the agent would be stranded in `waking`/`hibernating`), while the version CAS inside `transitionAgentLifecycle` still prevents clobbering a concurrent legitimate writer.

Two further **post-authority** transitions are also administrative, closing false-quarantine/strand windows on lease expiry:

- The final `waking -> live` promotion runs after generation acceptance has already bound the runtime to our exact lease/fence/reservation, so it is bookkeeping. If it stayed fenced, a lease that expired _after_ acceptance (e.g. a slow registration on the winning attempt) would throw and quarantine an already-live runtime; an administrative CAS promotes it correctly. This mirrors `recoverStrandedWakes`'s accepted→live completion.
- The pre-teardown hibernate **abort to `active`** (unsafe checkpoint, work-arrived, or a fault before `stopRuntime`) is a safety rollback. If it stayed fenced, a hibernate lease that expired during a slow checkpoint handshake would throw and leave the row stranded in `hibernating`; an administrative CAS rolls it back to `active`.

Forward-progress transitions that still hold real authority (`idle -> hibernating`, `hibernated -> waking`, and `hibernating -> hibernated`) remain fully fenced.

Wake **fault handling is atomic around the launched runtime and the acceptance boundary**, so no code path can leak a runtime or quarantine a live one. A launch fault (`respawnRuntime` throws), a registration-wait fault (`awaitRuntimeRegistration` rejects), or a prove-stop probe fault are each caught within the attempt rather than falling through to the generic fault path with a still-running process: the launched attempt is prove-stopped through its attempt-bound handle and, if it cannot be confirmed gone (including a launch that produced no handle at all), the wake fails closed to `reap-candidate` (`wake_ambiguous_launch`) instead of leaking it.

The stop-vs-accept decision is made **race-free** by a single transactional settle (`finalizeWakeAttempt`), not a plain read. Because the socket accepts a generation atomically, an acceptance can commit in the window between the orchestrator's last waiter read and its decision to stop the attempt — a plain "did it register?" read would then prove-stop and quarantine an already-live runtime. `finalizeWakeAttempt` runs in one transaction: if the reserved generation was already accepted it reports `accepted` (and the runtime is promoted, never stopped); otherwise it consumes **only this attempt's exact-nonce reservation**, so any later registration by the launched runtime can no longer be accepted (`no_reservation`) — which makes the subsequent prove-stop safe. Every path that is about to stop or quarantine a launched attempt (the per-attempt failure path, the respawn-throw path, and the outer fault backstop) settles first, so an acceptance that lands late is always promoted rather than killed.

Symmetrically, generation **acceptance is an irreversible phase**: once the socket layer atomically accepts the generation the runtime is live and connected, so any subsequent bookkeeping fault (the `waking -> live` promotion, the queue-depth read, or wake completion) must never quarantine it. The promotion is guarded — on fault the identity is left in `waking` for `recoverStrandedWakes` to complete to `live` (it classifies an accepted-but-stranded wake by the consumed reservation and advanced generation), and the wake reports the material outcome (`woken_recovery_pending`) rather than moving an awake worker to `reap-candidate`.

Acceptance also survives a **crash between the acceptance commit and the socket bind/response**. The socket accepts+commits (advancing the generation, consuming the reservation) before it binds the connection and returns the register RPC; a broker crash in that window would otherwise leave an accepted generation whose runtime still holds — and, on reconnect, replays — its single-use wake fence, only to be rejected because the reservation is gone (or the row is now `live`). The acceptance therefore writes an **acceptance receipt** (`agent_wake_acceptance_receipts`, schema v21) recording the exact accepting fence, atomically with the generation advance. After a restart, `recoverStrandedWakes` promotes the accepted-but-stranded wake to `live`; a replayed registration that presents a fence **exactly** matching the receipt for a `live` identity whose generation already equals the reserved generation is then re-bound idempotently — without accepting a new generation — instead of stranding a legitimately accepted runtime. This is fail-closed: only an exact receipt match on a `live` row qualifies (a live duplicate connection is already rejected earlier by the stable-id conflict check, so it never double-binds), and the receipt is cleared by the next wake reservation so a stale fence can never rebind during a fresh wake window. For this to be race-free, crash recovery (`recoverStrandedWakes`) must run at broker startup **before the socket begins accepting registrations**.

Finally, the socket wake fence is checked **before** the ordinary-registration fast path: `enforceWakeFence` computes whether any fence field was presented up front and rejects a fence presented with no `stableId` (`fence_without_stable_id`), so a malformed wake runtime cannot omit its stable identity, present its broker-issued fence, and register as a fresh authorized agent during the wake window.

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

Schema v19–v21 is additive (v20 adds an `agent_wake_reservations.reservation_nonce` column, defaulted for existing rows; v21 adds the `agent_wake_acceptance_receipts` table — one row per agent recording the exact fence that accepted a generation, for idempotent crash-recovery replay). Existing rows remain `live`; old disconnected rows are not inferred as hibernated. New lifecycle tables hold sanitized runtime specs, one fenced active lease per logical agent, and append-only structured events. Event retention is bounded to the newest 10,000 rows. No prompt/message body, token, credential, or unrestricted environment is stored.

Downgrade leaves additive columns/tables in place. Roll back application code by disabling hibernation first, waking and draining all hibernated identities, then using the prior binary. Do not rewrite hibernated rows as disconnected ghosts.

## Controlled activation (future, separate approval)

1. Back up the broker DB and record exact extension commit. On broker startup — **before the socket server begins accepting registrations** (and thus before dispatching any wakes) — call `HibernationOrchestrator.recoverStrandedWakes()` once to reconcile crash-stranded state. Running it before registrations are accepted is what lets a crash-stranded accepted runtime's fenced replay find the promoted `live` identity + its acceptance receipt and re-bind idempotently rather than race a still-`waking` row. It repairs three classes: (a) agents left in `waking` — completed to `live` when the generation was already accepted (reservation consumed, `runtime_generation` advanced past the checkpoint generation), otherwise failed closed to `reap-candidate`; (b) agents left in `hibernating` — the runtime's liveness is unknown so they fail closed to `reap-candidate` rather than risk a double launch on the next wake; (c) wake-queue rows orphaned in `dispatching` — returned to `queued` for a fresh dispatch pass (they also block the unique active-agent index until reclaimed). Reconciliation is **owner-aware**: it skips a row only when the lifecycle lease is unexpired **and owned by this live broker instance** (an operation we are actively driving). A lease owned by a _different_ instance is orphaned from a prior, now-dead broker — a crash normally leaves precisely such an unexpired-but-orphaned lease — so it is reconciled immediately (and the orphaned lease released) rather than skipped until its TTL elapses, which is what makes the ordinary quick-restart case recover instead of stranding forever. The finalize/safety writes that run outside a crash (the pre-teardown hibernate abort, the accepted `waking->live` promotion, and each dispatch-loop queue finalization) always release the lifecycle lease in a `finally` and are wrapped so a transient DB-write failure cannot crash the drain pass; any row left `dispatching`/`waking`/`hibernating` by such a failure carries no held lease and is therefore reclaimed by the next `recoverStrandedWakes` pass. A graceful `unregister` from a runtime that is still exiting after a quarantine preserves `reap-candidate` (alongside `hibernating`/`hibernated`/`waking`) as a soft disconnect, so the inbox, thread ownership, and runtime spec an operator needs to review the quarantine are never destroyed.
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
values, or filesystem/socket paths. The otherwise shape-unconstrained
adapter-authored facets (`configFingerprint`, `expectedHost`, and `launchSource`,
plus the mirrored `session.host`) are additionally passed through
`sanitizeSpecFacet`: only a strict machine token (hostname / hash / short machine
code — an alphanumeric-anchored run of `[A-Za-z0-9_.-]`) is emitted verbatim;
ANY other shape (a path, unix socket path, `KEY=value` assignment, `--flag`,
quoted span, or whitespace smuggled into one of those fields) collapses to an
opaque, non-reversible `#<fingerprint>`, so no such value can slip verbatim onto
an operator/JSON surface even if it was persisted into the spec.

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
(`TOKEN = deadbeef`), or a punctuation-wrapped flag (`(--api-key sk-123)`) leaked
part of the secret. It consumes each secret **value through its end** — a quoted
span whose closing quote is _optional_ (so an unterminated `--api-key "sk live 123`
is swallowed whole rather than leaking its spaced tail), otherwise a non-space
run: `key=value`/`key = value` keeps only the key name, and a flag followed by a
separate value (with any leading punctuation, e.g. `(--api-key sk-live-123)`)
redacts the value. The telemetry rollup redacts reason keys defense-in-depth.
Operator-authored command **targets** are redacted by the same construction:
`sanitizeOperatorTarget` passes through only a plain broker-safe identifier slug
and fingerprints anything else — a stable-id/`host:session:<ref>` target (whose
tail embeds the session-resume identity), a private worktree path, or a
`KEY=secret` shape — to an opaque `target:#<hash>` before it ever reaches the
confirmation-policy/prompt surface (the raw target still flows to the broker for
server-side resolution). An _unresolved_ target is likewise never echoed:
`unknownHibernationTarget` emits a stable, non-reversible `target:#<fingerprint>`
so an operator can correlate repeated failures of the same input without any
content reaching a surface.

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
