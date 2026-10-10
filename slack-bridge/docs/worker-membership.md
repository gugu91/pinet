# Worker membership and local host runners

Workers join Pinet independently of Slack and independently of their launcher.
Only the broker/Slack adapter needs Slack bot/app tokens. `/pinet` is registered
without those tokens; `/pinet follow` retains the existing local socket and
settings/environment mesh-secret behavior. Slack-only modes report missing tokens.

## Provision a worker

Install/build `@pinet/slack-bridge`; `pinet-host --help` is the local operator CLI.
From a source checkout, replace `pinet-host` with
`node /absolute/checkout/slack-bridge/dist/host-cli.js` after `pnpm build:packages`.

On the **broker host**, issue a different credential for each logical worker:

```sh
pinet-host issue --db /path/to/broker.db --host worker-host --worker task-1067 \
  --cwd /path/on/worker/repo --out /secure/transfer/worker.json \
  --address 100.64.1.2 --port 9800
# For local-only use, replace --address/--port with --socket /path/to/broker.sock.
```

`--cwd` is the allowed repo path **on the worker**, not the broker. The generated
profile is 0600, exclusively created (never overwritten), and contains its
credential. Transfer it securely and keep it 0600 and owned by the worker user.
Do not commit, print, paste into prompts, or pass its contents as command arguments.
Issuance/revocation opens the broker's SQLite DB locally; it is not a network admin
API. SQLite remains broker-local; no shared filesystem is needed by a worker.

On the worker, any ordinary shell/terminal/SSH session can run:

```sh
env -u SLACK_BOT_TOKEN -u SLACK_APP_TOKEN pi --pinet-profile /secure/worker.json
```

An explicit profile joins automatically, including headless/RPC sessions.
`~/.pi/agent/pinet/join.json` is the optional default profile; otherwise
`PINET_JOIN_PROFILE` remains a compatible explicit path override. A profile is one
logical identity: do not share it between concurrently running workers. Reuse it
when the same worker reconnects or changes runtimes. An active duplicate stable
identity is rejected. Profile-based bootstrap takes precedence over legacy mesh
settings, which remain supported when no profile is selected.

## Private outbound transport

Unix sockets remain the default. To opt a **broker** into private TCP, create
`~/.pi/agent/pinet/broker.json` (0600), or select an equivalent file with
`PINET_BROKER_CONFIG`, then start/restart the broker:

```json
{ "privateNetwork": true, "listenTarget": { "type": "tcp", "host": "100.64.1.2", "port": 9800 } }
```

This binds only that literal address. Public addresses, wildcard binds and remote
DNS names are refused; RFC1918, CGNAT/Tailscale and IPv6 ULA literals require the
explicit opt-in. This is raw TCP **inside an operator-managed encrypted private
network**, normally Tailscale. Pinet does not configure Tailscale/firewalls, provide
TLS, or make unencrypted LAN use safe. Do not expose/forward this port publicly.
Workers dial out; no worker listener or Rex server exposure is required. This
initial implementation selects one listener, not simultaneous Unix and TCP.

Non-loopback connections cannot use the shared mesh secret: they require the
per-worker credential. The broker stores only its hash and issues an in-memory,
connection-bound session token (15-minute TTL: **agent-default, not a user rule**).
Each RPC checks expiry and revocation. Expired sessions reconnect/reauthenticate;
a revoked credential cannot renew. The existing prune interval also disconnects
revoked idle clients. Sessions are not durable and do not survive broker restart.
The 1 MiB request-buffer limit is an **agent-default, not a user rule**.

```sh
pinet-host revoke --db /path/to/broker.db --credential CREDENTIAL_ID
# Or revoke every credential issued for a host:
pinet-host revoke --db /path/to/broker.db --host worker-host
```

The principal binds registration to its host/worker stable ID, cannot become a
broker via metadata or administer shutdown, and cannot request broker-local file
attachments. Worker metadata cannot opt into local broker-managed PID reaping.
Workers otherwise retain existing trusted mesh messaging/adapter permissions:
this is not a sandbox or a fine-grained per-repository authorization system.

## Local host runner

The exported `HostRunner`/`RuntimeAdapter` API implements
`start | send | read | status | stop | attachCommand`. The CLI persists owned runtime
handles under an owner-only root so another local CLI invocation can address them:

```sh
pinet-host start --root /secure/pinet-runs --capacity 3 --runtime shell \
  --profile /secure/worker.json --cwd /path/on/worker/repo -- \
  pi --mode rpc --extension /absolute/slack-bridge/dist/index.js
# stdout: {"handle":".../handle.json","runtime":"shell","id":"..."}
pinet-host send --root /secure/pinet-runs --handle /returned/handle.json \
  --text '{"type":"prompt","message":"Report your worker identity"}
'
pinet-host read --root /secure/pinet-runs --handle /returned/handle.json
pinet-host status --root /secure/pinet-runs --handle /returned/handle.json
pinet-host attach --root /secure/pinet-runs --handle /returned/handle.json
pinet-host stop --root /secure/pinet-runs --handle /returned/handle.json
```

Use `--runtime tmux` or `--runtime rex` with the **same profile and command**.
The runner strips Slack tokens from child environment, sets the profile path,
checks cwd against the profile's repos, and advertises its runtime handle. It
never adds inherited Slack secrets to scripts. Other operator environment and
Pi model credentials remain available. Configure token-free Pi settings too
when proving complete Slack credential absence.

- Shell: detached pipe/FIFO-backed process, tail output, PID-start-time fenced
  stop. No terminal attachment exists (`attach` returns null); use send/read.
  `send` is synchronous and throws on backpressure or incomplete writes, reporting
  bytes written. Partial input may already be present: recover/restart the input
  stream rather than blindly resending the whole message.
- tmux: dedicated socket under this runner root, recorded session only.
- Rex: `rex run --focus=false --shell=none`; only its returned block is controlled
  and closed, never a user's shared session. `attach` returns an argv array.
- Herdr is **not implemented in this new runner**: it requires a verified Herdr
  control environment. Existing subtree tmux/Herdr spawning is unchanged.
- SSH is an operator-invoked join path, **not an implemented runtime adapter**.

Capacity defaults to one worker (**agent-default, not a user rule**); callers can
configure it. One local start lock serializes allocation; after a host-runner
crash, inspect the recorded PID in `.start.lock` before manually clearing a stale
lock. Shell output reads return the last 128 KiB (**agent-default, not a user
rule**); disk log retention is operator-owned. Host reports advertise hostname,
configured repos/worktrees, available runtime binaries, capacity, health and the
worker's runtime handle through its outbound registration/heartbeat. Available
binaries are discovery, not proof of server health or support on another host.
If persisting a new runtime handle fails, the runner stops the exact newly
created process/session/block before deleting its directory. If cleanup also
fails, it retains the directory for operator recovery and refuses new starts
while an incomplete runtime record remains. No remote arbitrary-command
dispatch/scheduler is exposed.

## Durable-ready, not a durable Pi runtime

`worker_credentials` persists revocation independently of sessions.
`worker_connections` records stable worker identity, agent ID, connection ID,
lease expiry, runtime kind/handle and disconnection separately. Old connection
close events cannot disconnect a replacement connection. Existing broker tables
continue to own lanes, message delivery/read/ack and lifecycle fences; changing
launcher does not replace those contracts. Ack delivery remains at-least-once
across failure windows, not a claim of exactly-once model execution.

No Pi-durable suspend/resume engine, distributed database, remote scheduler,
remote attachment transport or new Herdr/SSH adapter is claimed here. Future
runtimes can preserve the profile's stable identity while replacing a runtime
handle and connection lease; the existing hibernation engine still supports only
its existing verified tmux/Herdr manifests.

The packaged broker **default** is runtime-agnostic. Explicit `tmux` policy and
legacy local `tmux.md` overrides are retained as opt-in compatibility; an existing
user override is not silently rewritten.
