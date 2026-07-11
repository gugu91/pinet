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

1. Back up the broker DB and record exact extension commit.
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

## Stop/rollback conditions

Immediately disable new hibernations on any duplicate accepted generation, affinity reroute/drop, queue order violation, stale-fence acceptance, ambiguous PID/tmux ownership, missing worktree, incompatible config drift, wake timeout beyond retry policy, or secrets/private message content in telemetry. Preserve DB evidence, wake/drain safely where ownership is proven, and quarantine ambiguous identities as `reap-candidate`.

## Known limits

V1 is same-host/same-user, broker-managed root workers only. It does not snapshot child processes or in-memory tool state, hibernate supervised subtrees/private tmux sockets, wake broadcast subscribers, migrate across hosts, or claim exactly-once message execution. SQLite transport remains durable at-least-once; fencing guarantees one accepted runtime generation, not exactly-once side effects.
