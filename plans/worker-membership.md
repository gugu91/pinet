# Worker membership: per-worker keys over the existing socket

Status: accepted after review. Replaces the approach in #1068. Step 1 (token-free followers) is #1093.

## What we want

Pinet has one broker that holds the Slack app and many workers that do the work. We want four things:

1. **Workers need no Slack tokens.** Done in #1093: a follower without tokens makes its Slack API calls through the broker. Followers that do hold tokens still call Slack directly, and file downloads still need a local token.
2. **A worker can be started by anything.** Rex, tmux, Herdr, a plain shell, or a script on another machine. The membership layer should not know which.
3. **Workers can run on another machine.** For example a second Mac in the office or a cloud box, joining the broker on Thomas's Mac.
4. **Each remote worker has its own Pinet credential that we can revoke**, without rotating the secret every other worker uses.

The broker already starts workers by running shell commands and stops them by sending `/exit` over the mesh, so those stay as they are.

## Trust model

Workers are **trusted collaborators with individually revocable credentials**. This is not a sandbox for hostile workers. A worker with a valid key keeps the broad powers every follower has today: it can message other agents, change shared lanes, and make Slack API calls within the bot's scopes through the broker.

On top of that, a worker connection is blocked from a small, explicit list of things that would let it control the broker process or reach the broker's machine (see "What a worker connection may not do").

Revoking a key stops that key from authorising further requests or reconnecting. It does not cancel work already in progress (such as a Slack call already sent), stop the worker's process, or remove any SSH access the worker host has.

## What exists today

- The broker listens on a Unix socket (`~/.pi/pinet.sock`).
- An optional shared mesh secret protects the socket. Anyone holding it is fully trusted, including calling `admin.shutdown`. With no mesh secret, every connection is trusted without logging in (`socket-server.ts` `handleAuth`).
- A worker chooses its own stable ID when it registers. Live duplicates and fenced lifecycle identities are rejected, but nothing ties an ID to a credential.
- Heartbeats replace the agent's whole metadata object. Some broker decisions read that metadata: the ghost reaper's "broker-managed" check (alongside ownership, disconnection, command and start-time checks), and the role check on `agent.sessions.search`.
- The broker acts on control commands (`/exit`, `/reload`, `/interrupt`, structured control envelopes) found in its own inbox, whichever route delivered them: `agent.message`, the legacy `send` broadcast, or `message.send` document recipients (`broker-runtime.ts`, `extractPinetControlCommand`).
- `message.send` accepts `files: [{ path }]`. The broker reads those paths from its own disk and uploads them.
- Port leases default to host `127.0.0.1`, so leases from different machines would collide.

## Why not #1068's approach

#1068 delivers all four goals, but builds three things Pinet does not need to own:

| #1068 builds                                                                     | Problem                                                                                                                                                                                | This design                                                                                                                              |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A TCP listener for private networks, with IP-range checks                        | There is no application-level encryption. #1068's docs require an encrypted overlay network, but the code cannot enforce that, and a private IP range is not an authenticated network. | No new externally reachable listener. Remote workers reach the Unix socket through OpenSSH, which provides encryption and machine login. |
| Session tokens attached to every request, with expiry and polling for revocation | A token sent back over the same connection that issued it proves nothing new. Polling exists only because revocation writes to the database from another process.                      | Identity is bound to the connection at login. Revocation goes through the running broker, which closes the connection immediately.       |
| A host runner (`pinet-host start/send/read/stop/attach`) for shell, tmux and Rex | It duplicates what the mesh already does (stop via `/exit`, status via the agent list) and is the largest, riskiest part of the PR.                                                    | The membership layer knows nothing about launchers. Anything that can run `pi --pinet-join <file>` works.                                |

#1068 also changed the broker's default prompt policy. That is a product decision and should be its own PR.

## Design

### 1. Keys

The broker stores worker keys in a new table:

```
worker_keys(id TEXT PRIMARY KEY, host_id TEXT NOT NULL, worker_id TEXT NOT NULL,
            secret_sha256 TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT)
UNIQUE (host_id, worker_id) WHERE revoked_at IS NULL
```

- `host_id` and `worker_id` are slugs: 1 to 63 characters of `a-z`, `0-9` and `-`, starting with a letter or digit. No colons, so the stable ID `<host_id>:worker:<worker_id>` always parses with kind `worker`, which no existing stable ID uses.
- A key is `pnw_<id>_<secret>`. The ID is 24 lowercase hex characters; the secret is 32 random bytes in base64url (43 characters, which may include `_` and `-`). Parsing takes the fixed-length ID and treats the rest as the secret. Only the secret's SHA-256 is stored. A slow hash is unnecessary because the secret is random, not a password.
- Issuing a key for an identity revokes its previous key in the same transaction, and closes any connection that used the old key. There is at most one live key per identity, so rotation is "issue again".
- No expiry. Revocation covers the lost-machine case.

### 2. Logging in

Each connection has one authentication state:

```ts
type ConnectionAuth =
  | { kind: "pending" }
  | { kind: "trusted" }
  | { kind: "worker"; keyId: string; hostId: string; workerId: string }
  | { kind: "revoked" };
```

- With a mesh secret configured, a connection starts `pending`. `auth { secret }` makes it `trusted` (today's full trust). `auth { workerKey }` checks the key's hash in constant time and that it is not revoked, then makes it `worker` and replies with the assigned `stableId`.
- Without a mesh secret, connections start `trusted`, as today. Worker keys then make no sense, so:
  - issuing a key requires a configured mesh secret, and
  - the broker refuses to start if the database holds live worker keys but no mesh secret is configured.
- A connection cannot log in twice. A worker key never falls back to the mesh secret or to no login.
- The mesh-secret comparison also becomes constant-time.
- There are no session tokens. The connection is the session.

### 3. What a worker connection may not do

Everything else stays as for any follower. Each block is enforced in one place:

- **Identity:** `register` must use the assigned stable ID, checked before the registration resolver or wake fences run. The worker's registration and ownership token use the `stableId` from the login reply.
- **Metadata:** on `register` and on every `heartbeat` (including `metadata: null`), the broker rewrites the worker's metadata: `role` is `worker`, `capabilities.role` is removed, `brokerManaged`, `brokerManagedBy` and `pinetBrokerManaged` are removed, and `pinetWorker: { hostId, workerId }` is set by the broker.
- **Process ID:** the broker records `pid: 0` for worker connections. The ghost reaper already refuses PIDs of 0 or 1, and a worker's process is never broker-owned, even when it runs on the same machine.
- **Broker control:** when the broker finds a control command in its inbox, it ignores it if the message's broker-recorded sender is a worker connection's agent. This one check covers every delivery route. Ordinary messages and reports to the broker are still delivered. (The broker must use the stored sender ID, not `metadata.senderAgent`, which callers can set on some routes.)
- **Admin:** `admin.*` requires a `trusted` connection.
- **Files:** `message.send` with a non-empty `files` list is refused for every adapter. Those are paths on the broker's disk. A worker can upload its own files through the Slack proxy, which sends the bytes from the worker.
- **Session search:** `agent.sessions.search` is refused, whatever role the metadata claims.
- **Adapter capabilities:** a worker may call the Slack adapter's `api.call` (which `slack.proxy` also uses), but not other or future adapter capabilities.
- **Port leases:** a worker's leases are recorded under its `host_id`, not the caller-supplied host, so leases from different machines do not collide.

### 4. Managing keys

Admin RPCs that require a `trusted` connection and a configured mesh secret:

- `admin.workerKey.issue { hostId, workerId }` rotates and returns the new key once.
- `admin.workerKey.revoke { hostId, workerId }` marks the live key revoked, sets matching connections to `revoked` (so requests already buffered are refused), then closes them.
- `admin.workerKey.list` returns each identity, creation and revocation times, and whether it is connected. It never returns secrets.

A small CLI wraps these:

```sh
pinet-worker issue --host studio --worker w1 --join-socket /Users/me/.pi/pinet-remote/broker.sock --out w1.join.json
pinet-worker revoke --host studio --worker w1
pinet-worker list
```

- It connects to the broker with the mesh secret, like a local follower. `--broker-socket` overrides the default broker socket path; `--join-socket` is the path the worker will use, which differs when forwarding.
- `issue` writes the join file owner-only and refuses to overwrite an existing file. It never prints the key. If writing fails after issuing, run `issue` again: that rotates to a new key.

Because these go through the running broker, there is one writer and revocation takes effect at once.

### 5. Joining

A join file holds what the worker needs:

```json
{ "version": 1, "socket": "/Users/me/.pi/pinet-remote/broker.sock", "key": "pnw_..." }
```

- The worker gets it only through `pi --pinet-join <file>`. There is no environment variable: it would be inherited by every child `pi` the agent starts, and those children would join under the parent's identity.
- The file must be owner-only (no group or other permissions). Otherwise the worker refuses it.
- A valid join file means the session follows the broker at startup, including headless sessions the subagent guard would otherwise skip. The file is read and checked before the guard is bypassed. Without the flag nothing changes.
- When the broker rejects the key (unknown or revoked), the worker stops reconnecting and reports it. Other disconnects reconnect as today.

### 6. Remote transport

There is no new externally reachable Pinet listener. A remote worker host forwards a local Unix socket to the broker's socket with OpenSSH:

```sh
mkdir -m 700 -p ~/.pi/pinet-remote
ssh -N -o ExitOnForwardFailure=yes -o StreamLocalBindUnlink=yes \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -L ~/.pi/pinet-remote/broker.sock:/Users/thomas/.pi/pinet.sock thomas-mac
```

- Keep it running with launchd or `autossh`. Use one tunnel per socket path: `StreamLocalBindUnlink` removes an existing socket, so two tunnels on one path disrupt each other.
- `ExitOnForwardFailure` only covers the local bind; it does not check that the broker is up. When the broker restarts, the worker reconnects through the same tunnel.
- OpenSSH over Tailscale is the simplest setup between Macs. Tailscale's own SSH server is a different implementation with its own prerequisites; this design does not rely on it.
- The broker must have a mesh secret (enforced, see section 2).
- **SSH access is broader than Pinet access.** An SSH key that can forward to the broker socket can also forward to any other local socket or port the broker's user can reach. `restrict,port-forwarding,command="/usr/bin/false"` in `authorized_keys` prevents a shell but does not limit forwarding to one socket. `permitopen` only applies to TCP. Ordinary SSH access as the broker's user can also read the mesh secret. Revoking a Pinet key does not revoke SSH access. A dedicated account can narrow this but needs its own socket permissions.

### 7. Launching and stopping workers

No new code. The broker's launch command becomes, for example:

```sh
rex run --focus=false --cwd <repo> -- pi --pinet-join ~/.pi/agent/pinet/w1.join.json
ssh studio 'rex run --focus=false --cwd <repo> -- pi --pinet-join ~/.pi/agent/pinet/w1.join.json'
```

The broker stops a worker with the existing `pinet action=exit` and sees status in the existing agent list. A hung worker is killed in its own terminal by the operator, as today.

## Limits

- Keys are bearer credentials. Anyone who copies a join file can use it. Anything running as the worker's OS user on that host can read it. Host and worker IDs are labels the broker assigned, not proof of where a connection comes from.
- Authentication is per key, but Slack calls through the proxy are not attributed per action: the Slack adapter does not receive the caller's identity.
- Workers keep broad collaboration powers: messaging, lanes, threads and bot-scoped Slack calls. A misbehaving worker can mislead or disrupt other agents until revoked.
- This membership layer does not know about launchers. Other parts of Pinet (subtree spawning, hibernation) still do.

## What this drops from #1068

The TCP listener and `broker.json` network config, private-IP validation, session tokens and their expiry, the `worker_connections` table, the host runner and `pinet-host start/send/read/status/stop/attach`, host reports in heartbeat metadata, and the default prompt change. A frame-size cap is also left out: it is not needed for these goals and needs care to do properly.

## Implementation plan

One PR stacked on #1093:

1. `broker/worker-keys.ts`: table with the partial unique index, issue (transactional rotation), verify (constant time), revoke, list, label and key parsing.
2. `broker/socket-server.ts`: the `ConnectionAuth` state, `auth { workerKey }` with the `stableId` reply, refusal to start with live keys and no mesh secret, the blocks in section 3, and the admin RPCs.
3. `broker-runtime.ts`: ignore inbox control commands whose stored sender is a worker connection.
4. `broker/client.ts`: `workerKey` login, assigned `stableId`, stop reconnecting on a rejected key.
5. `join-file.ts`, `index.ts`, `follower-runtime.ts`: `--pinet-join`, permission check, follow at startup, guard bypass after validation.
6. `pinet-session-formatting.ts`: recognise the `worker` kind.
7. `pinet-worker` CLI and its package `bin` entry.
8. User docs: `slack-bridge/docs/worker-membership.md`.

Tests use public interfaces against a real `BrokerSocketServer`: key login, wrong and revoked keys, double login, impersonating another stable ID, metadata rewritten on heartbeat, `/exit` and a structured control envelope from a worker ignored by the broker (and a trusted follower's still honoured), `admin.*`, `files` and session-search refusals, revoke and rotation closing live connections, refusal to start with keys and no mesh secret, port-lease host.

End to end: issue a key with the CLI against a scratch broker; start a real `pi` in Rex with `--pinet-join` through an SSH-forwarded socket (`ssh localhost`), with no Slack tokens; run a real model prompt that uses the `slack` and `pinet` tools; check the broker sees the assigned identity; revoke the key and check the connection drops and does not rejoin.

## Review record

Reviewed by `openai-codex/gpt-6-astra` (xhigh) on 2026-10-15. The trust model above was chosen during that review (trusted collaborators, not hostile-worker isolation). Its answers to the earlier open questions, all adopted:

1. **SSH or a TLS listener?** SSH (ordinary OpenSSH, optionally over Tailscale) for now, with its broader access documented. No TLS.
2. **Restrict Slack methods for workers?** No method allowlist under this trust model. Keep existing thread-ownership checks, and do not grant future adapter capabilities by default.
3. **One live key per identity, no expiry?** Yes, with transactional rotation, a unique live key per identity, immediate connection invalidation and strict key parsing.
4. **Key management through the broker or direct database writes?** Through the broker: one writer and immediate revocation without polling.
