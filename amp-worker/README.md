# @pinet/amp-worker

Amp harness worker for the Pinet mesh. It registers with a Pinet broker as a
first-class mesh agent, executes durable inbox assignments as
[Amp](https://ampcode.com) thread turns, replies through the broker, and only
acks after the reply is durable.

## What it does

- Connects to a Pinet broker over a Unix socket, loopback TCP, or TLS for
  remote (cross-machine / Amp orb) brokers.
- Registers with first-class metadata: harness (`amp`), adapter version,
  protocol, Amp CLI version, agent mode, host/platform, repo/branch identity,
  and capabilities.
- Maintains one Amp thread per Pinet thread, so follow-up messages continue
  the same Amp conversation.
- Persists per-message processing phases atomically so a crash or restart
  never re-runs Amp for an executed assignment and never drops a reply.
- Honors the shared Pinet mesh control contract (`pinet:control`
  interrupt/reload/exit) and steering messages (`pinet:steer`).
- Advertises what Amp cannot do instead of pretending parity: subtree
  spawning is capability-negotiated off (`subtree.spawn: false`) because Amp
  has no broker-callable child-thread API.

## Install

```sh
npm install -g @pinet/amp-worker
```

Requires the [Amp CLI](https://ampcode.com/manual) (`amp`) to be installed and
logged in on the worker host.

## Usage

Local broker over the default Unix socket:

```sh
pinet-amp-worker --cwd ~/src/my-repo --mode high
```

Remote broker over TLS with a pinned certificate and mesh secret:

```sh
PINET_MESH_SECRET=... pinet-amp-worker \
  --host broker.example.com --port 7433 \
  --tls-ca ./broker-ca.pem \
  --tls-pin "51:D7:CC:...:25:E0" \
  --cwd ~/src/my-repo
```

Inside an Amp orb (orbs allow outbound TCP; attach orb identity claims):

```sh
pinet-amp-worker \
  --host broker.example.com --port 7433 \
  --tls-ca ./broker-ca.pem \
  --mesh-secret-file ./mesh.secret \
  --orb-audience pinet-mesh
```

Start a real orb thread from a local Amp CLI with:

```sh
amp --orb-execute -m high -x "Clone the worker repository, provision the broker CA and mesh secret from the project secret store, then run the documented pinet-amp-worker command."
```

Orbs are thread-bound; Amp does not expose a CLI for creating a detached bare
orb. Pass `--no-archive-after-execute` when the launch turn must leave the orb
running: execute-mode auto-archive pauses the orb immediately and interrupts
background workers. For a supervised bridge that survives CLI updates and orb
pause/resume, declare it in `.amp/services.yaml` or run `amp orb service start`
inside the orb. Put idempotent restart/bootstrap work in `.agents/resume`. Use Amp project
secrets for the mesh secret and CA material; never put them in the repository,
prompt, service command line, or logs.

The broker side must enable `slack-bridge.brokerTls` (host, port, keyPath,
certPath) plus `meshSecretPath`; see `slack-bridge/README.md`. Verify firewall
and DNS reachability from the orb before starting the worker.

Run `pinet-amp-worker --help` for the full option list.

## Amp CLI contract

The worker drives the Amp CLI with exactly:

- `amp threads new` — create a thread; prints its ID.
- `amp threads continue <thread-id> -x --stream-json -m <mode>` — resume a
  thread. The user message is written to stdin (never argv, so prompts never
  appear in the process table); the final `result` stream-JSON event carries
  the reply.
- Modes: `low`, `medium`, `high`, `ultra` (`--mode`).
- Interrupt = SIGTERM of the locally owned `amp` child process. Amp has no
  external cancellation API.

## Trust model

- Plain TCP stays loopback-only (enforced by broker and client).
- Any non-loopback broker requires TLS with an explicit trust anchor: a CA
  bundle (`--tls-ca`) and/or an exact server-certificate SHA-256 pin
  (`--tls-pin`). There is no insecure trust-all mode.
- Mesh authentication uses the shared mesh secret (`PINET_MESH_SECRET` or
  `--mesh-secret-file`), never argv.
- `--orb-audience` decodes `amp orb id-token` claims (issuer
  `https://ampcode.com/api/workload-identity`) as registration _identity
  metadata_ only. The raw token is never logged, persisted, or forwarded, and
  local decoding is not treated as broker authentication.

## Durability

State lives in an atomically written JSON file
(`~/.pi/amp-worker/<stable-id>.state.json` by default):

```
poll ─▶ execute (Amp) ─▶ persist "executed" ─▶ reply ─▶ persist "replied" ─▶ ack
```

Every transition is committed to disk (temp file + fsync + rename) before
the in-memory state advances, so a persistence failure never leaves memory
ahead of disk. Corrupt or unsupported state files fail closed at startup
rather than risk duplicate executions.

On restart or redelivery: an `executed` job replays only the reply; a
`replied` job only acks. Replies carry a stable per-job idempotency key
(`externalId`) that the broker deduplicates on, so a reply retried after a
crash or lost response is committed exactly once. A crash during an
unrecorded Amp run re-runs it — at-least-once execution is the documented
floor because Amp offers no idempotency handle. Repeated startup failures
produce one bounded durable error reply instead of a redelivery loop. A
durable-state commit failure is terminal: the worker stops with
`StateCommitError` rather than risk re-running a completed Amp turn.

Replies route by assignment origin: mesh agent threads (`a2a:*`) get a
durable direct agent message back to the originating agent, while external
transport threads (Slack, iMessage, …) go through the broker's transport
adapter path — success always means an intended recipient or the external
transport actually accepted the reply.

## Architecture

See [`../plans/amp-worker-architecture.md`](../plans/amp-worker-architecture.md)
for the full design: transports, trust decisions, durability limits,
capability negotiation, and the adapter plan for future harnesses.

## Publishing

This package is part of the npm publish set in
[`../plans/npm-publish.md`](../plans/npm-publish.md).

Do not publish, tag, or bump versions without maintainer approval. Use the
GitHub Actions workflow for validation.
