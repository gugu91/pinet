# @pinet/orb-node

Run Pinet mesh nodes in [Amp orbs](https://ampcode.com/manual/orbs). Phase 1
of the orbs-as-mesh-nodes plan (`plans/amp-orbs-as-mesh-nodes.md`): one
command launches an orb that hosts a Pinet broker plus colocated workers.

## What it ships

- **`pinet-orb-node up`** — CLI that starts a fresh orb thread
  (`amp --orb-execute --no-archive-after-execute`) whose agent bootstraps the
  broker node. Run it from a checkout of this repository so the orb is created
  on the right Amp project.
- **`plugin.ts`** — a self-contained Amp system plugin, copied into the orb at
  `~/.config/amp/plugins/pinet-orb-node.ts`. On load it registers a durable
  Amp webhook and writes the capability URL to
  `~/.pinet/orb-node/webhook.json` (0600), holds an `executor.keepAlive()`
  lease for the broker role, logs delivered events to
  `~/.pinet/orb-node/webhook-events.jsonl` (idempotent on the server event
  id), and rewrites `~/.pinet/orb-node/wake-signal.json` per event.
- **`setup/orb-broker-setup.sh`** — idempotent orb-side bootstrap: installs
  the plugin, restarts the Amp executor to load it, installs the pi CLI when
  missing (`curl -fsSL https://pi.dev/install.sh | sh`), writes minimal broker
  settings (`runtimeMode: "broker"`; Slack tokens from
  `PINET_SLACK_BOT_TOKEN`/`PINET_SLACK_APP_TOKEN` and the access allowlist
  from `PINET_SLACK_ALLOWED_USERS` — comma-separated Slack user IDs, which
  should include your own, since the broker is default-deny without it —
  all typically delivered as Amp project secrets/env vars),
  and starts the supervised broker service (pi in a tmux session wrapped for
  `amp orb service`, so it survives orb pause/resume and CLI updates).

To sit at the broker interactively from the orb's web Terminal pane: the
pane is already inside Amp's outer tmux session, so attach nested with
`env -u TMUX tmux attach-session -t pinet-broker` and detach with
`Ctrl-b Ctrl-b d` (double prefix; a single `Ctrl-b d` detaches the outer
session and drops the Terminal pane).

## Usage

```sh
# From a checkout of this repository, with a logged-in amp CLI:
pinet-orb-node up

# Inspect the launch contract without creating an orb:
pinet-orb-node up --dry-run

# Options: --mode low|medium|high|ultra, --service <name>, --amp-command <path>
```

The orb agent reports the webhook capability URL, plugin status, and service
status back in the orb thread. Treat the capability URL as a bearer
credential: a POST to it both signals the plugin handler and **resumes the
orb if it is paused** (verified 2026-07-18; see the plan doc for the
experiment record).

## Wake channel contract

- POST any JSON to the capability URL → HTTP 202, durable at-least-once
  delivery.
- The plugin appends `{recordedAt, id, payload}` to `webhook-events.jsonl`
  and atomically rewrites `wake-signal.json` with the latest event id, so
  orb-local processes can watch either file.
- The webhook key is stable per plugin + thread: reloads return the same URL.
  Rotate by deleting the trigger in Amp Settings → Triggers and re-registering
  under a new key.

## Keep-awake semantics

The broker role holds `executor.keepAlive()` so the orb never auto-pauses
while the broker runs (consumes orb runtime credits; best-effort per Amp
docs). Worker-role config (`{"role":"worker"}`) skips the lease so idle
worker orbs pause and the webhook wake channel revives them — that spawn path
is Phase 3.

## Status / roadmap

Phase 1 (this package): broker-in-orb, workers colocated, loopback transport.
Phase 2: Tailscale so other orbs and machines can dial the broker's TLS
listener. Phase 3: `orb` spawn target in the broker so it can spawn pi worker
orbs on demand. Design and evidence: `plans/amp-orbs-as-mesh-nodes.md`.

The Amp plugin APIs used (`createWebhook`, `executor.keepAlive`) are
`@experimental` and may change.
