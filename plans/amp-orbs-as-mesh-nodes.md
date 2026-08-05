# Amp Orbs as Pinet Mesh Nodes — Investigation Findings

Status: Phase 1 implemented (2026-07-18) in `orb-node/` (`@pinet/orb-node`):
`pinet-orb-node up` launches a broker orb; the `pinet-orb-node` Amp plugin
provides the webhook wake channel + keepAlive lease; the idempotent
`orb-node/setup/orb-broker-setup.sh` bootstraps pi + the supervised broker
service inside the orb. Phases 2 (Tailscale) and 3 (orb spawn target) are
design-only below. Companion to `amp-worker-architecture.md` (#946); orb
capabilities verified empirically where noted.

## Question

Can Amp orbs serve as general cloud VMs for Pinet — hosting `pinet-amp-worker`,
Pi sessions, or a broker — rather than only as vehicles for Amp threads? And is
there a machine-callable path to wake or message orb-hosted processes without
interactive authentication?

## Empirical probe results (verified)

Probe ran in orb thread `T-019f76c6-a5d9-738d-8885-2ac0d643cba0` (project
`tmustier/personal-plugins`), Amp CLI `0.0.1784398201-g14c7e6`.

| #   | Capability                               | Result                                                                                                                                                           |
| --- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Authenticated `amp` CLI inside orb       | PASS — `amp threads list` shows the user's private threads                                                                                                       |
| 2   | Run threads locally from orb shell       | PASS — `amp threads new` + `amp threads continue <id> -x`                                                                                                        |
| 3   | Spawn sibling orbs from orb shell        | PASS — `amp -ox "…"` created and completed a new orb thread                                                                                                      |
| 4   | Supervise arbitrary long-lived processes | PASS — `amp orb service start <name> --command '…'` creates a systemd transient unit; status/list/stop work; survives pause/resume per docs                      |
| 5   | Arbitrary outbound TCP                   | PASS — HTTPS 200, TCP 22 to github.com, TLS 1.3 to smtp.gmail.com:465                                                                                            |
| 6   | Workload identity (OIDC)                 | PASS — `amp orb id-token --audience <aud>`; iss `https://ampcode.com/api/workload-identity`; claims include `sub`, `user_id`, `thread_id`, `project_id`, `email` |
| 7   | Runtime                                  | Node v22.23.1, pnpm 11.1.3, tmux 3.3a, systemd 252, websocat, Linux 6.1 x86_64, user `user`                                                                      |
| 8   | Portals (inbound HTTPS)                  | PASS — `amp orb portal <port>` → `https://t-<thread-uuid>-p<port>.onamp.dev/`; requires interactive Amp sign-in; any request wakes a paused orb                  |
| 9   | Auto-pause                               | Platform-controlled (no local timer unit); docs: 15 min inactivity, immediate on thread archive; `amp-headless.service` binds the thread and restarts always     |

Conclusion from probe: an orb can host a Pinet worker, Pi session, or broker
process, supervised by `amp orb service`, with full outbound networking. The
constraints are inbound access (portals are sign-in gated) and auto-pause.

## Amp plugin APIs that close the gaps (from docs, both `@experimental`)

### `amp.createWebhook` — machine-callable inbound trigger

- A plugin registers a durable generic webhook "for this plugin and the owning
  Orb thread" and receives a capability URL
  (`https://ampcode.com/api/plugin-triggers/webhooks/<token>`). The URL is the
  credential — no interactive sign-in, unlike portals.
- Delivery is at-least-once with retries; `ctx.signal` aborts at the handler
  deadline and the event is retried. Events carry a stable server-owned `id`
  for idempotent handler effects. Payload is arbitrary JSON, surfaced as
  `event.payload.body.data` (stringified) with encoding metadata.
- The `key` is stable per plugin+thread: re-registering (including after
  plugin reload) returns the same URL.
- Registrations are managed in Amp settings → Triggers (pause blocks new
  delivery; delete revokes).
- Empirically verified (see below): registration requires an Amp-managed orb
  executor — standalone `amp plugins exec` cannot call `createWebhook`.

### `executor.keepAlive()` — defeat auto-pause from inside

- "Keep the current orb awake until the returned subscription is unsubscribed
  or the plugin process exits. The lease renews automatically and consumes orb
  runtime credits."
- Rejects outside an Amp-managed orb. Best-effort: manual pauses, insufficient
  credits, and provider runtime limits still pause the orb.

### No WebSocket / event-subscription API

Amp exposes no outbound event stream to external consumers. Event surfaces are:
plugin `amp.on(...)` (in-session only), CLI `--stream-json` (per-invocation
stdout), portals (inbound HTTPS, sign-in gated), and plugin webhooks (inbound
HTTPS, capability-URL gated). `websocat` in the orb image is just a client
tool.

## Webhook wake experiment (2026-07-18)

Setup: probe orb installed a user-wide system plugin at
`~/.config/amp/plugins/pinet-wake-probe.ts` calling
`amp.createWebhook({ key: 'pinet-wake-probe', … })`; handler appends
timestamp/event-id/payload to a log file. Plugin loaded by restarting
`amp-headless.service` (the managed executor); `amp plugins list` discovered
it but standalone exec could not register webhooks.

Verified:

1. Self-test while awake: POST to capability URL → HTTP 202
   `{"accepted":true}`; handler fired within seconds.
2. POST while orb paused (sent 20:23:23Z, orb idle since ~20:02Z, auto-pause
   ~20:17Z): ingress still returned **202 accepted** — events are queued
   durably server-side regardless of orb state.
3. Delivery with no agent turn active: the `wake-test-1` handler fired at
   20:23:23.846Z — ~0.5 s after the POST (20:23:23.3Z) and 3m26s before the
   next thread message arrived (~20:26:50Z). Webhook delivery does NOT wait
   for a thread turn or an incoming message; the plugin runtime handled it
   immediately.
4. First run was confounded: the journal showed a VM fork (pause/snapshot) at
   20:16:18 but a resume (chronyd forward-time-jump) at 20:20:14 — ~3 min
   before the POST — so the orb happened to be awake when the POST landed.
   Side-finding: `uptime -s` persists across pause/resume, so pause is
   VM-suspend, not reboot; in-memory process state survives.
5. **Clean rerun — PROVEN: a webhook POST resumes a paused orb.** With the
   orb verified paused in the ampcode.com UI (thread badge "Sandbox
   Executor" with no "Executor Connected", checked via authenticated browser
   session at ~21:06:45Z after 18 min idle), a POST at 21:06:52Z returned 202
   and by 21:07:19Z (27 s later) the badge flipped to "Executor Connected" —
   with zero messages sent to the thread. The only stimulus was the webhook
   POST. Internal corroboration from the orb's journal and handler log:

   | Time (UTC)   | Event                                     | Δ from POST |
   | ------------ | ----------------------------------------- | ----------- |
   | 21:06:52     | POST sent, 202 accepted                   | 0 s         |
   | 21:06:57     | chronyd "Forward time jump" (VM resume)   | +5 s        |
   | 21:07:05     | chronyd re-selected time source           | +13 s       |
   | 21:07:19     | UI badge shows "Executor Connected"       | +27 s       |
   | 21:07:30.262 | webhook handler fired (event `66cdae93…`) | +38 s       |

Summary: a webhook POST is always accepted (202) and durably queued, delivery
is immediate when the runtime is up, and a POST to a paused orb resumes it
within ~30 s. The capability URL is therefore a complete machine-callable
wake-and-signal path into an orb — no interactive auth, no thread message
needed.

Observation note for future tests: opening the thread page in the ampcode.com
web UI appears to connect the executor (and thus wake/keep-awake the orb) —
check pause state from the threads list page, not the thread page.

## Architecture implications for #946 / Pinet

Two viable topologies for orb-hosted mesh nodes:

1. **Always-on orb (simplest)**: plugin holds `keepAlive()`; the orb behaves
   like a plain cloud VM. Pinet worker/broker keeps its normal outbound
   connection to the broker; no inbound path needed. Costs continuous orb
   runtime credits.
2. **Pause/wake orb (cheaper)**: orb pauses when idle; broker signals it via
   the webhook capability URL. Verified: delivery is durable (202 while
   paused) and a POST resumes a paused orb in ~30 s. Messaging the thread
   (`send_message_to_thread` from another Amp thread) remains a fallback
   wake path.

Supporting facts either way:

- `amp orb service ensure` declared services survive pause/resume and CLI
  updates — right supervision primitive for the worker process.
- `.agents/resume` hook runs on every orb resume (≤10 s blocking) — right
  place for fast reconnect/repair (e.g. restart tunnels, re-register webhook).
- Orb OIDC (`amp orb id-token`) can bootstrap trust with external systems
  (e.g. Tailscale OIDC federation, broker auth) without baking in secrets.
- Orbs can create/drive sibling orbs via `amp -ox` / `amp threads` — an
  orb-hosted orchestrator can manage a fleet.

Caveats:

- `createWebhook` and `keepAlive` are `@experimental` — expect breakage.
- Capability URLs are bearer credentials: store like secrets, rotate by
  deleting the trigger (Settings → Triggers) and re-registering under a new
  key.
- Webhook registration is per plugin + per orb thread; a fresh orb thread
  means a fresh URL that must be reported to the broker (registration-time
  callback from the plugin, e.g. POST the URL to the broker on activation).

## Phase 1 live verification (2026-07-18)

Ran the real launch path end to end: `pinet-orb-node up` (built CLI) created
broker orb thread `T-019f7729-724b-75cd-998b-cd3556cb0f34`, and
`orb-node/setup/orb-broker-setup.sh` bootstrapped it on the first attempt —
no re-run needed after the `amp-headless.service` restart.

All five checks passed in the orb:

1. `~/.pinet/orb-node/webhook.json` exists with a capability URL (kept
   inside the thread, never echoed).
2. `~/.pinet/orb-node/status.json`:
   `{"role":"broker","executorKind":"remote","webhookKey":"pinet-orb-node","keepAlive":"held","startedAt":"2026-07-18T21:39:18.726Z"}`
3. `amp-svc-pinet-broker.service` active (running); tmux + pi processes
   present under the supervisor.
4. `tmux has-session -t pinet-broker` exit 0.
5. `pi --version` → `0.80.10`, installed via
   `curl -fsSL https://pi.dev/install.sh | sh`.

Caveats found during the live run:

- The launcher warned `No Amp project matches the Git remotes in the current
directory; running the orb without a repository` — this repo
  (`gugu91/pinet`) is not a joined Amp project, so the orb started with an
  empty workspace. Until the repo is joined as an Amp project (and `orb-node/`
  is merged), the setup files must be delivered into the orb some other way;
  this run used Amp's cross-thread file upload
  (`orb-node/plugin.ts`, `orb-node/setup/orb-broker-setup.sh`) followed by a
  message telling the orb to run the bootstrap.
- Follow-up for productionizing: join the repo as an Amp project so fresh
  orbs get a checkout, or teach the bootstrap prompt to fetch/reconstruct the
  two files when the checkout lacks them.

## Broker capability verification (2026-07-18, on the live a0.large broker)

All three broker-side capabilities confirmed from inside
`T-019f7729-724b-75cd-998b-cd3556cb0f34`:

1. **Sibling orb spawn** — `amp -ox` exit 0, new thread
   `T-019f773f-73dc-749b-8f66-92f851c8187a` replied `BROKER-SPAWN-OK`.
2. **Colocated pi worker spawn** — second pi session in tmux
   (`pinet-worker-test`) started, pane showed `pi v0.80.10` + prompt,
   cleaned up.
3. **Slack posting (Web API only, no Socket Mode)** — `auth.test` ok as bot
   `pinet` (team Nexcade); `chat.postMessage` ok to `C08E7UTTMNV`
   (`#a-random`), ts `1784412177.660549`. The bot token was delivered by
   cross-thread file upload and lives at `~/.pinet/orb-node/slack.env` 0600.

Slack caveats found:

- The bot (via this token) is **not** a member of the configured
  `defaultChannel` `C0AU0CKRFK8` and the token lacks `channels:join` scope,
  so it cannot self-join; posting there needs an `/invite @pinet` or a scope
  update. Until then the broker can post only to channels it is already in.
- Socket Mode was deliberately not tested from the orb: the app token allows
  a single socket, owned by whichever session runs the bridge.

## Actual Pinet broker launched in the orb (2026-07-18)

The bare-pi gap was closed: the real slack-bridge broker now runs inside
`T-019f7729-724b-75cd-998b-cd3556cb0f34`.

How the code got there (repo is private; orb has no git creds): source
tarball of the `feat/946-amp-cross-machine-mesh` worktree uploaded
cross-thread, extracted to `~/pinet-repo`, `pnpm install --frozen-lockfile`,
then `~/.pi/agent/settings.json` written with a local-path `packages` entry
(slack-bridge enabled; browser-playwright/neon-psql/nvim-bridge disabled)
and `slack-bridge: { runtimeMode: "broker", botToken, appToken,
defaultChannel: "C08E7UTTMNV" }`. Killing the tmux session let the
`amp orb service` supervisor recreate it — pi restarted, the extension
loaded, and the broker auto-started on `session_start` (no `/pinet start`
needed).

Verified:

- pane: `slack-bridge` in [Extensions]; `🦦 The Broker Otter — broker
started (U0AS1PCATT7)`; no trust prompt, no startup error.
- `~/.pi/pinet.sock` (unix socket) and `~/.pi/pinet-broker.db` exist.
- `/pinet status`: Mode broker, Connection connected, runtime + Slack tool
  health healthy, default channel C08E7UTTMNV, pending backlog 0.

Interactive access to the broker (discovered via the orb Terminal pane): the
web Terminal is itself a client of Amp's outer tmux session, so attaching to
the broker session is nested tmux. Use:

```bash
env -u TMUX tmux attach-session -t pinet-broker
```

and detach from the inner session with `Ctrl-b Ctrl-b d` (double prefix —
the outer tmux eats the first `Ctrl-b`). A plain `Ctrl-b d` detaches the
outer session and drops the Terminal pane instead.

Open configuration gaps (not failures):

- **Default-deny Slack access**: no `allowedUsers` configured, so the broker
  ignores all Slack users. Set `slack-bridge.allowedUsers` (or
  `allowAllWorkspaceUsers: true`) before it can be driven from Slack.
- No mesh secret configured → mesh auth disabled (fine colocated; required
  before any cross-orb TLS listener in Phase 2).
- No startup notification is posted to the default channel; status is
  visible via `/pinet status` in the session.
- Broker settings/tokens were hand-delivered; the durable path is Amp
  project secrets + committed `orb-node/` bootstrap.

## Amp project (2026-07-18)

Created via `amp projects create https://github.com/gugu91/pinet --personal`:

- Project: `tmustier/pinet`, ID `f27b9d35-b3db-480f-8110-86e088f56deb`,
  https://ampcode.com/@tmustier/pinet (personal, not workspace — broker
  threads contain the webhook capability URL, so keep sharing deliberate).
- The worktree now matches it (`amp projects status`), so future
  `pinet-orb-node up` launches get a repository checkout of the default
  branch instead of an empty workspace.
- Remaining web-UI settings to configure on the project page: orb size
  (recommend `a0.small` — default `a0.large` is $1.66/h and the broker holds
  keepAlive), and project secrets/env vars `PINET_SLACK_BOT_TOKEN` /
  `PINET_SLACK_APP_TOKEN` plus `PINET_SLACK_ALLOWED_USERS` (comma-separated
  Slack user IDs; Thomas is `U0AF5S3LQ5C`) so `orb-broker-setup.sh` wires
  Slack and the access allowlist automatically. Without the allowlist the
  broker starts default-deny and ignores all Slack users (verified live —
  fixed on the running broker by adding `allowedUsers` and hot-reloading via
  `/pinet start`).

## Scratch threads (not archived)

- Probe / webhook host: `T-019f76c6-a5d9-738d-8885-2ac0d643cba0`
- Local CLI test: `T-019f76c7-de4e-706f-9e4e-41194751ee68`
- Sibling orb test: `T-019f76c7-b55a-7571-be94-e8e309948727`
- Phase 1 live broker orb (keepAlive held, pi broker running):
  `T-019f7729-724b-75cd-998b-cd3556cb0f34`
