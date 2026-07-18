# Amp worker architecture (issue #946)

First-class cross-harness, cross-machine Pinet mesh support. The first
non-Pi harness is Amp (local CLI workers and Amp orbs); the boundaries are
designed so later adapters (Codex, Claude Code, ...) reuse the same seams.

## Decisions

### 1. Harness-neutral mesh boundary

The mesh client/runtime boundary must not know about Amp, and the Amp worker
must not import slack-bridge.

- `BrokerClient` moved verbatim to `pinet-core/broker-client.ts`
  (`@pinet/pinet-core/broker-client`). `slack-bridge/broker/client.ts` is a
  compatibility re-export, so existing imports and tests keep working.
- The control/steering wire contract (`pinet:control`
  interrupt/reload/exit envelopes, `pinet:steer` steering envelopes, legacy
  `/interrupt` `/steer` text forms) moved verbatim from
  `slack-bridge/helpers.ts` to `broker-core/mail-control.ts`
  (`@pinet/broker-core/mail-control`). Slack keeps only its Slack-specific
  scheduling behavior; the Amp worker consumes the same parsers, so every
  harness interprets control mail identically.
- The Amp worker itself lives in a new zero-runtime-dependency workspace
  package, `amp-worker/`, published as `@pinet/amp-worker` with the
  `pinet-amp-worker` CLI.

### 2. Encrypted remote transport: built-in Node TLS

Cross-machine workers need an encrypted transport. Amp orbs allow arbitrary
outbound TCP but only inbound HTTPS portals, so the worker always dials out
to the broker; the broker listens.

- `broker-core/tls.ts` adds TLS listen/connect support using `node:tls` only
  (no npm deps).
- Plain TCP remains loopback-only (`broker-core/raw-tcp-loopback.ts`),
  unchanged.
- A TLS server may bind non-loopback only when key/cert _and_ mesh
  authentication are configured. Fail closed.
- TLS clients must supply an explicit trust anchor: a CA bundle for chain +
  hostname verification and/or an exact SHA-256 leaf-certificate pin.
  Optional SNI override and mTLS client cert/key are supported. There is no
  insecure trust-all mode.
- Secrets, tokens, and message bodies are never logged.

### 3. Registration as first-class metadata

The worker registers with a stable ID plus structured metadata so brokers and
peers never guess what a harness supports:

- `role`, `harness: "amp"`, `adapter`, `adapterVersion`, `protocol`
  (`pinet-broker/jsonrpc2`), `runtime`, Amp CLI version, agent `mode`.
- Host identity: hostname, platform, transport kind, cwd, git repo/root/
  branch (re-probed on reload so branch moves are reflected).
- Executor identity: `executor: "local"` or `executor: "orb"` with decoded
  orb OIDC claims (issuer, audience, Amp thread/workspace/project IDs).
- `capabilities` (see below) and `tags` for discovery.

### 4. Durable execution loop

The broker inbox is the source of truth; the worker persists just enough to
recover without duplicate Amp execution or lost replies.

```
poll ─▶ execute (Amp) ─▶ persist "executed" ─▶ reply ─▶ persist "replied" ─▶ ack
```

- `amp-worker/state-store.ts` commits every transition copy-on-write: the
  next JSON snapshot is written to a temp file (0600), fsynced, renamed over
  the state file, and the directory fsynced _before_ the in-memory maps are
  replaced. A persistence failure therefore never leaves memory ahead of
  disk. Stale temp files from a crash are removed at startup and never read
  as state.
- Recovery on redelivery/restart: `executed` → send stored reply, ack;
  `replied` → ack only; no record → run Amp. At-least-once Amp execution is
  the documented floor: a crash during an unrecorded run re-runs it because
  Amp exposes no idempotency handle.
- Reply routing depends on the assignment's origin, and neither path can
  silently succeed with zero recipients:
  - Mesh agent threads (source `agent` / `a2a:*`): the reply is a durable
    direct agent message (`agent.message`) back to the originating agent.
    The broker persists an inbox row for the target, so a briefly
    disconnected recipient still receives it on reconnect; an unknown target
    fails loudly and the unacked assignment is retried on redelivery.
  - External transport threads (slack, imessage, …): the reply goes through
    the broker's adapter path (`message.send`), so success means the external
    transport accepted the delivery.
- Each reply carries a stable `externalId`
  (`amp-worker:<stable-id>:reply:<message-id>`). Committed broker and a2a
  retries deduplicate on `(source, externalId)`; a2a retries do not invoke the
  live dispatch callback again, and key collisions across thread/sender/body
  fail closed.
- External adapters have an unavoidable ambiguity when the provider accepts a
  send but the broker crashes before its DB commit. Without a provider-native
  idempotency key, retrying is at-least-once (possible duplicate) while
  suppressing the retry could silently lose a message. Pinet deliberately
  prefers durable delivery and documents this clear `executed`-phase state;
  adapters can close the window when their provider supports idempotency.
- A durable-state commit failure is terminal (`StateCommitError`): the worker
  stops instead of retrying, because polling on with a broken store could
  re-run a completed Amp turn whose `executed` record never persisted.
- The reply always goes out before the broker ack. A failed reply leaves the
  job durable and unacked; redelivery retries the reply without re-running
  Amp, on every poll interval, until it succeeds or the worker stops. The
  durable record is only removed after the ack succeeds.
- Repeated execution startup failures (bounded attempts, default 3) become
  one durable error reply instead of a redelivery loop.
- Unsupported or corrupt state files fail closed at startup rather than risk
  duplicate executions.
- Maintenance/context-only mail (via `@pinet/broker-core/mail-classification`)
  is acked without burning an Amp execution.

### 5. Amp CLI contract (verified live)

- `amp threads new` prints a new thread ID.
- `amp threads continue <id> -x --stream-json -m <mode>` resumes a thread;
  `-x/--execute [message]` reads the prompt from stdin when no argv value is
  given (verified against `amp --help`), so prompts never leak into the
  process table.
- Modes: `low | medium | high | ultra`.
- `--stream-json` emits one JSON event per line; the terminal
  `{"type":"result","result":...,"session_id":...,"is_error":...}` event
  carries the reply (`amp-worker/amp-stream.ts` parses incrementally and
  tolerates malformed lines).
- Cancellation: Amp has no external cancel API. Interrupt is SIGTERM of the
  locally owned child process only, escalating to SIGKILL after a short grace
  period if the child ignores it. A per-execution timeout (default 30 min)
  bounds runaway runs; a timeout kill is reported as an `error` outcome (the
  run overran its budget), while an operator/control kill is reported as
  `interrupted`. `amp threads new` is owned and bounded the same way (default
  2 min setup timeout).

### 6. Control, steering, and status

- `pinet:control` envelopes (gated on a2a threads/metadata, as in Pi):
  - `interrupt` → SIGTERM the owned Amp child.
  - `exit` → interrupt, unregister, stop.
  - `reload` → re-register with refreshed metadata (capability
    `reload: "reregister-metadata"`; there is no runtime to restart).
- While an Amp run is in flight, a side control-watcher polls the inbox for
  interrupt/exit only, so controls are not stuck behind the busy loop. Other
  mail stays unacked for the main loop.
- `pinet:steer` applies at the next safe boundary: the worker is sequential,
  so a steering message becomes the very next Amp turn for its thread with
  explicit steering framing (capability `steer: "next-safe-boundary"`).
  Amp's `--stream-json-input` mid-turn injection exists but is not used: the
  worker's turn-per-message model makes the next-turn boundary sound and
  simpler to make durable.
- `updateStatus("working"/"idle")` brackets each execution (advisory).

### 7. Capability-negotiated subtree fallback

Amp's cross-thread child tools are prompt-driven inside Amp itself; there is
no broker-callable child-thread API. Pretending subtree parity would be a
lie, so the worker advertises:

```json
"subtree": {
  "spawn": false,
  "reason": "Amp exposes no broker-callable child-thread API; ...",
  "adapter": "amp-worker",
  "adapterVersion": "..."
}
```

A future Amp plugin (running inside Amp, able to call Amp's own thread
tools) can flip `spawn` to `true` with the same adapter name — brokers only
ever branch on the capability, never on the harness name.

### 8. Orb identity (OIDC) status

`amp orb id-token --audience <aud>` mints a short-lived RS256 OIDC token
(issuer `https://ampcode.com/api/workload-identity`, exact audience,
`token_use=exchanged`) with `thread_id`/`workspace_id`/`project_id` claims.

Today the worker decodes the claims locally (fail-closed issuer/audience/
token*use/expiry checks) and attaches them as registration \_identity
metadata*. The raw token is never logged, persisted, or forwarded. Broker-side
signature verification against the issuer's JWKS would make orb OIDC a real
authentication factor; until then the shared mesh secret (plus TLS) remains
the authentication mechanism, and the decoded claims are location/identity
info only.

## Module map

```
broker-core/tls.ts                TLS listen/connect, pinning, fail-closed trust
broker-core/mail-control.ts       shared control/steering wire contract
pinet-core/broker-client.ts       harness-neutral BrokerClient (moved)
amp-worker/amp-stream.ts          --stream-json incremental parser
amp-worker/amp-runner.ts          owned Amp child processes, SIGTERM interrupt
amp-worker/state-store.ts         atomic durable phase store
amp-worker/capabilities.ts        explicit capability surface
amp-worker/orb-identity.ts        orb OIDC claim decoding (identity metadata)
amp-worker/config.ts              CLI args, endpoints, fail-closed TLS/secrets
amp-worker/worker.ts              poll loop, durability, control watcher
amp-worker/cli.ts                 wiring: config → client → runner → worker
```

## Adapter authoring (future harnesses)

A new harness adapter needs:

1. A runner implementing `AmpWorkerRunnerPort`-shaped semantics: create/
   continue a conversation, report a bounded result, interrupt an owned
   process.
2. A capability surface that is honest about steer/interrupt/subtree
   semantics.
3. The same durable phase machine (reuse the state store) and the shared
   `mail-control` contract.
4. Registration metadata naming the harness, adapter, and versions.

## Live end-to-end evidence (18 July 2026)

A real local Amp CLI worker and a real Amp-managed orb worker joined the same
broker mesh through the new TLS transport. The orb reached the Mac-hosted
broker over an outbound public raw-TCP relay; TLS certificate pinning and a
temporary mesh secret authenticated the connection end to end.

Observed roster and exchange:

- `e2e-local-amp`: `executor=local`, Darwin/arm64, TLS, Amp mode `low`.
- `e2e-orb-amp`: `executor=orb`, Linux/x64 host `e2b.local`, TLS, Amp mode
  `low`, OIDC issuer/audience and Amp thread identity present in metadata.
- Both were visible concurrently in one broker database with distinct agent
  IDs and healthy heartbeats.
- The broker delivered one durable a2a assignment to each worker. Replies were
  exactly `same mesh local passed` and `same mesh orb passed`, persisted in the
  broker inbox and acknowledged by the broker client.
- The orb advertised `steer=next-safe-boundary`,
  `interrupt=sigterm-owned-process`, graceful exit, and the explicit
  `subtree.spawn=false` capability with the Amp API limitation reason.

The proof also caught an Amp lifecycle edge: orb execute turns auto-archive by
default, which pauses the orb and interrupts a detached worker. Relaunching the
same thread with `--no-archive-after-execute` kept the orb live and the exchange
passed. The setup docs now call this out explicitly.

The automated TLS suite separately stops and restarts the real broker server,
then proves the stable worker reconnects and re-registers as one logical agent.
Existing stable-ID live-owner conflict checks remain green, covering the
no-duplicate-owner fence.

## Troubleshooting

- `Broker TLS certificate chain verification failed` / pin mismatch: the
  client's `--tls-ca`/`--tls-pin` does not match the broker's certificate.
  Re-fetch the CA or recompute the pin; never bypass verification.
- `mesh secret` auth errors: the broker requires a secret the worker did not
  present. Set `PINET_MESH_SECRET` or `--mesh-secret-file`.
- `Unsupported amp-worker state file`: the durable state file is from an
  incompatible version or corrupt. Move it aside to reset (accepting that
  in-flight jobs may re-run).
- Worker exits with `reconnection failed`: the broker stayed unreachable
  past the client's bounded reconnect; restart the worker once the broker is
  back (durable state makes this safe).
- Amp runs never finish: check `amp` is logged in on the worker host and the
  execution timeout (default 30 min); interrupted runs reply with an explicit
  interruption notice.
