# Remote Broker Following — Scoping/RFC

Date: 2026-06-13
Worktree: `remote-broker-following-1781364816`
Branch: `research/remote-broker-following-1781364816`
Issue anchor: https://github.com/gugu91/extensions/issues/821

## Question

Can a Pinet broker send messages to, and receive messages from, followers running on another host? If not, what is the safest/easiest path to get there?

## Current state

### What works today

- Pinet has a broker/follower architecture in `slack-bridge`.
- The broker owns Slack ingress/egress and deterministic routing through a broker DB/router.
- Followers connect to the broker, register, heartbeat, poll inbox, ack delivered inbox rows, send agent-to-agent messages, update status, manage lane/port lease state, and send outbound transport messages through the broker.
- The JSON-RPC protocol is newline-delimited JSON over Node sockets.
- Optional shared-secret mesh auth exists via `meshSecret` / `meshSecretPath` or `PINET_MESH_SECRET` / `PINET_MESH_SECRET_PATH`.
- Reconnect/backoff exists in `BrokerClient`.

### What does not work as a supported product path today

- Extension runtime startup does not expose remote broker host/port settings.
- Broker mode starts `startBroker()` with the default Unix socket; follower mode connects to `DEFAULT_SOCKET_PATH`.
- Raw TCP exists in lower-level broker APIs/tests, but both server and client assert loopback-only TCP hosts.
- There is no mTLS/TLS transport, SSH-tunnel orchestration, Tailscale-aware config, remote endpoint discovery, per-agent credentialing, nonce/challenge auth, or replay-resistant transport envelope.
- Public-IP following is intentionally blocked by loopback assertions.

Net: bidirectional broker/follower messaging is implemented for local sockets and can be made to work through a local-port tunnel, but remote following is not yet a first-class supported runtime mode.

## Code evidence

- `slack-bridge/broker-runtime.ts`: broker runtime calls `startBroker(...)` with mesh auth only; no listen target setting.
- `slack-bridge/follower-runtime.ts`: follower constructs `new BrokerClient({ path: DEFAULT_SOCKET_PATH, ...meshAuth })`; no host/port setting.
- `broker-core/raw-tcp-loopback.ts`: `assertLoopbackTcpHost` rejects non-loopback raw TCP until a secure remote transport exists.
- `slack-bridge/broker/index.ts` and `slack-bridge/broker/socket-server.ts`: TCP listen targets are supported only through lower-level options and guarded by loopback assertions.
- `slack-bridge/broker/client.ts`: host/port client connections are supported only for loopback hosts, then use JSON-RPC methods such as `auth`, `register`, `heartbeat`, `inbox.poll`, `inbox.ack`, `message.send`, `agent.message`, `lane.*`, `portLease.*`, and `adapter.capability`.
- `slack-bridge/README.md`: documents broker/follower over a local Unix socket and optional shared-secret mesh auth; no remote follow setup.
- `slack-bridge/broker/integration.test.ts`: tests mesh auth over loopback TCP, including correct secret, missing auth, and wrong secret.
- `slack-bridge/broker/helpers.test.ts`: verifies non-loopback raw TCP listen targets are rejected before broker artifacts are created.

## Transport/security options

### 1. SSH local port forwarding — recommended first slice

Shape:

- Broker continues to bind a loopback TCP socket on the broker host.
- Remote follower opens an SSH tunnel, e.g. remote `127.0.0.1:<local-port>` forwards to broker-host `127.0.0.1:<broker-port>`.
- Follower connects to local loopback `127.0.0.1:<local-port>`.
- Keep Pinet mesh shared-secret auth enabled inside the tunnel as defense-in-depth.

Pros:

- Preserves loopback-only safety posture.
- Avoids public listener and TLS/mTLS implementation in the first slice.
- Good NAT/firewall story: outbound SSH from follower to broker host or bastion.
- Uses existing OS/user SSH auth, audit logs, host-key verification, and key management.
- Smallest code change: config for TCP loopback target + docs/runbook; optional tunnel helper later.

Cons / risks:

- Need operational setup for SSH keys/host aliases and tunnel lifecycle.
- Need reconnect behavior that distinguishes broker down vs tunnel down.
- Shared-secret auth today is static and not replay-resistant if the tunnel is compromised.

### 2. Tailscale/private network + loopback tunnel or private listener

Preferred Tailscale variant for early slices: still use an SSH tunnel over Tailscale or Tailscale SSH so the broker binds only loopback.

A direct Tailscale-IP listener is possible later, but would require relaxing `assertLoopbackTcpHost` under a secure-transport mode and adding stronger auth.

Pros:

- Nice machine identity, NAT traversal, ACLs, device posture, and stable names.
- Better ergonomics than raw public IP.

Cons / risks:

- Direct private-IP listening still expands attack surface beyond loopback.
- Requires tailnet policy assumptions outside this repo.
- Without TLS/channel binding, static shared-secret auth is still the only app-layer auth.

### 3. mTLS/TLS broker endpoint

Shape:

- Add TLS server/client transport for broker JSON-RPC with mutual cert auth.
- Configure CA/client certs/key paths and expected broker identity.

Pros:

- Best app-owned remote security story for public or private networks.
- Enables real authenticated remote endpoints without relying on SSH.

Cons / risks:

- More implementation: TLS socket server/client, cert loading/rotation, SAN validation, error UX, tests.
- More operator burden for cert lifecycle.
- Still needs replay/spoofing hardening and rate limiting at the protocol boundary.

### 4. Public IP + token/shared secret only

Not recommended.

The current protocol is raw JSON-RPC with static shared-secret auth and no TLS, nonce, replay protection, rate limiting, or per-agent authorization. Exposing it directly would risk credential capture, replay, brute force, and unaudited command/control access.

## Recommendation

Implement remote following in phases, starting with SSH/Tailscale-SSH tunnel support while keeping the broker endpoint loopback-only.

The easiest safe path is not “public broker socket”; it is “make local TCP loopback a supported runtime target, then document/support SSH or Tailscale SSH forwarding.” This keeps the existing security invariant intact while giving remote followers bidirectional messaging.

## Phased plan

### Phase 0 — Product decision / issue anchor

- Create/confirm a GitHub issue for remote Pinet following.
- Decide whether first slice is manual tunnel docs only, a config-only runtime slice, or an integrated tunnel manager.
- Decide whether remote following belongs in published `slack-bridge` settings or a future `pinet-core` runtime settings namespace.

### Phase 1 — Loopback TCP runtime config + docs

Expected files/components:

- `slack-bridge/helpers.ts`: settings shape and validation for broker listen/connect target, e.g. `brokerListen` and `brokerConnect`.
- `slack-bridge/broker-runtime.ts`: pass a validated loopback `listenTarget` to `startBroker`.
- `slack-bridge/follower-runtime.ts`: construct `BrokerClient` with either Unix socket path or loopback host/port.
- `slack-bridge/README.md`: remote-following runbook using SSH/Tailscale SSH local forwarding.
- Tests beside changed files for settings precedence, loopback-only rejection, follower connect target, and docs examples if applicable.

Acceptance:

- Broker can listen on `127.0.0.1:<port>` by explicit config.
- Follower can connect to `127.0.0.1:<port>` by explicit config.
- Non-loopback hosts remain rejected.
- Mesh secret works and fails closed.
- A manual SSH tunnel enables a remote follower without exposing broker to a public/private interface.

### Phase 2 — Tunnel ergonomics and reliability

Expected files/components:

- Add diagnostics to `/pinet status` / follower diagnostic output for connect target, auth mode, reconnect state, and last tunnel-ish connection error without leaking secrets.
- Optional helper docs/commands for `ssh -L` and Tailscale SSH.
- Improve reconnect UX around tunnel restarts and broker restarts.
- Add audit-safe activity log entries for remote follower connect/disconnect/auth failure.

### Phase 3 — Strong remote transport

Expected files/components:

- `broker-core` or future `pinet-core`: transport abstraction for Unix, loopback TCP, TLS/mTLS.
- TLS/mTLS cert settings with file-mode checks and explicit server identity verification.
- Per-agent credentials or certificate identity mapping.
- Replay-resistant authentication if any token-based auth survives beyond TLS-only deployments.
- Rate limiting / connection caps / structured security logging.

### Phase 4 — Daemon / core ownership alignment

Remote following overlaps with the daemonized control-plane direction in `plans/420-broker-daemon-prd.md` and package split direction in `plans/slack-split-proposal.md`.

- `extensions/slack-bridge`: short-term runtime wiring, Slack adapter docs, Pinet command/status UX.
- `broker-core`: JSON-RPC server/client transport/auth primitives and low-level tests.
- Future `pinet-core`: broker/follower orchestration and remote runtime settings, once split proceeds.

## Test plan

- Unit:
  - settings normalization rejects non-loopback broker listen/connect host unless a future secure transport mode is selected;
  - mesh auth precedence remains settings over env, inline over path;
  - missing follower secret file fails before connecting;
  - diagnostics redact secret values and private file contents.
- Integration:
  - broker loopback TCP + follower loopback TCP: register, heartbeat, list agents;
  - broker-to-follower: route/direct agent message, follower polls, marks delivered/acks;
  - follower-to-broker-to-Slack-adapter substitute: `message.send` reaches a test adapter and records outbound;
  - reconnect after server restart / tunnel drop;
  - wrong/no mesh secret fails closed.
- Manual smoke:
  - Broker host: start broker on `127.0.0.1:<port>` with `meshSecretPath`.
  - Remote host: establish SSH or Tailscale SSH local forward to broker loopback port.
  - Remote follower: connect to local forwarded port with same secret path/secret.
  - Verify `pinet action=agents`, `pinet action=send`, `pinet action=read`, `slack_send` via transferred thread.

## Blockers / open questions

- Need a maintainer-approved GitHub issue/PR anchor before implementation.
- Decide whether first slice should support config only or include an SSH tunnel manager.
- Decide settings names and whether they live under `slack-bridge` temporarily or under a transport/core namespace.
- Decide how broker port discovery is shared with remote hosts without leaking private details in Slack/Pinet logs.
- Decide minimum auth requirement: recommend requiring `meshSecretPath` for any TCP mode, even loopback, when used for remote tunnels.
- Decide whether remote followers should be visually marked in agent metadata/status.
- Decide whether remote follower file/worktree metadata needs privacy filtering before broker/RALPH summaries.

## Bottom line

Pinet already has the protocol shape needed for bidirectional remote following, but productized remote follow is missing. The safest near-term path is SSH/Tailscale-SSH tunnel + explicit loopback TCP runtime config + required mesh auth, not public raw TCP. Public/private-IP listeners should wait for mTLS or equivalent secure transport work.
