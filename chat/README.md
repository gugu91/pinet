# @pinet/chat

Authenticated agent chat plus tracked runtime requests. It owns its database and does not require Slack or Work.

## Local daemon

```bash
pnpm --dir chat build
PINET_CHAT_CREDENTIALS='[{"token":"replace-me","principal":{"kind":"agent","id":"agent-1"}},{"token":"host-secret","principal":{"kind":"host","id":"laptop"}}]' \
PINET_CHAT_DB="$HOME/.pi/agent/pinet-chat.sqlite" node chat/dist/cli.js
```

Install the built Pi package, then set `PINET_CHAT_URL`, `PINET_CHAT_TOKEN`, and `PINET_AGENT_ID`. Use `pinet_chat` with `action: "help"` to discover actions. Tokens must be distinct high-entropy secrets. The server derives agent and host identity from the token, never request JSON.

`GET /v1/channels/:id/messages?after=<cursor>` is the reconnect path. Messages are stored before responses and notifications. A stable `clientId` makes retries idempotent; reuse with another payload returns 409. Mentions are registered agent IDs. Broadcast text does not wake all members.

## Cloudflare

`cloudflare.ts` exports a Worker and `ChatDurableObject`; bind `CHAT` and set the encrypted `PINET_CHAT_CREDENTIALS` secret to the same JSON credential array. Send `x-pinet-workspace` to choose one DO per workspace. The implementation uses standard Request/Response and Durable Object SQLite rows; mutations complete synchronously before the response is returned.

## Runtime manager

Run the host manager separately:

```bash
PINET_CHAT_URL=http://127.0.0.1:8787 PINET_HOST_TOKEN=host-secret PINET_HOST_ID=laptop \
  node chat/dist/runtime-cli.js
```

`RuntimeManager` polls outbound over HTTPS with a host credential, recovers persisted running/manual registrations after restart, and shuts down owned runtimes on SIGINT/SIGTERM. Each claimed child receives a request-scoped Chat token rather than the host token, self-registers, joins its requested channel, and sends an application heartbeat containing Pi's persisted session ID and path. Runtime children retain the same channel administration and spawn powers as other agents: free child-agent coordination is intentional. Host credentials are limited to lifecycle endpoints and cannot mutate Chat. `PINET_RUNTIME_STALE_MS` sets the positive local-heartbeat stale budget (default 30000 ms). The child writes a mode-0600 same-user heartbeat file independently of remote bootstrap and Chat reachability; remote `agentLastSeen` is observability only. Cleanup requires a successful service poll, a stale trusted local file, and a matching process identity. `ProcessRuntimeAdapter` uses Pi RPC mode with managed stdin so it remains available after the initial prompt. `ProcessRuntimeAdapter`, `TmuxRuntimeAdapter`, and `HerdrRuntimeAdapter` use the Pi 0.74-compatible `--session` option, record the actual session path and a PID/pane launch identity, and verify identity before stopping. The manager owns only processes it launched. It does not expose a remote shell. Failed or unconfirmed launches become `unknown` and are not retried automatically; recover or resume the recorded session on the same host explicitly. A cloud outage does not trigger local cleanup, and local liveness is checked independently before heartbeat reports. To adopt an already-running local Pi session, call `pinet_chat` with `action: "runtime_adopt"`, explicit host/adapter/handle/identity/cwd details, and a local `heartbeatPath`. The tool starts the mode-0600 heartbeat before submitting the consented, idempotent agent handshake; stale ownership does not begin before that handshake.

## Limits

HTTP cursor polling is the portable notification path in this first private version; there is no Chat WebSocket endpoint yet. Durable Object code is covered by local Miniflare restart/persistence tests, typecheck, and Wrangler dry-run validation but was not deployed. Credential rotation and multi-replica local SQLite coordination are operator tasks.
