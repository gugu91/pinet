# slack-bridge (Pinet)

Slack assistant integration for [pi](https://github.com/badlogic/pi-mono) — multi-agent broker, thread routing, and inbox tools powered by Socket Mode.

## Install

Install the latest Pinet Slack bridge pi package:

```bash
pi install npm:@pinet/slack-bridge
```

Or pin an exact published version for reproducible installs:

```bash
pi install npm:@pinet/slack-bridge@0.1.0
```

For package managers or local inspection, the npm package is also installable directly:

```bash
npm install @pinet/slack-bridge
```

## Package metadata and publishing

This package declares pi package/gallery metadata in [`package.json`](./package.json):

- `keywords` includes `pi-package` for gallery discovery.
- `pi.extensions` points at the built extension entrypoint, `./dist/index.js`.
- `pi.skills` points at the bundled skill directory, `./skills`.
- No `pi.image` or `pi.video` preview is declared yet because this package does
  not currently include a reviewed gallery image/video asset.

The published tarball is expected to include the package metadata, README,
Slack app manifest, built `dist/` files, bundled `skills/`, and LICENSE. Verify
that locally with:

```bash
cd slack-bridge
npm pack --dry-run
```

This package is included in the full npm publish set tracked in
[`../plans/npm-publish.md`](../plans/npm-publish.md). Use the GitHub Actions
workflow's default dry-run/readiness path for validation; do not publish, tag, or
bump versions without explicit maintainer release approval.

## Prerequisites

- A Slack workspace where you have permission to install apps
- Node.js 22+ (uses native `fetch` and `WebSocket`)
- [pi](https://github.com/badlogic/pi-mono) installed

## Slack App Setup

### 1. Create the app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App**
2. Choose **From a manifest**
3. Select your workspace
4. Paste the contents of [`manifest.yaml`](./manifest.yaml) from this directory
5. If the Slack app is not named Pinet, change `features.slash_commands[0].command` before creating the app (for example, Oathgate uses `/oathgate` instead of the packaged `/pinet` default)
6. Click **Create**

The manifest configures Socket Mode, the assistant view, all required bot scopes, event subscriptions, and the packaged Pinet slash-command default automatically.

### 2. Generate tokens

You need two tokens:

| Token               | Where to find it                                                                 | Looks like   |
| ------------------- | -------------------------------------------------------------------------------- | ------------ |
| **App-Level Token** | Basic Information → App-Level Tokens → Generate (with `connections:write` scope) | `xapp-1-...` |
| **Bot Token**       | OAuth & Permissions → Install to Workspace → Bot User OAuth Token                | `xoxb-...`   |

### 3. Required bot scopes

These are included in the manifest, but for reference:

```
app_mentions:read    assistant:write      bookmarks:read
bookmarks:write      canvases:read        canvases:write
channels:history     channels:read        chat:write
commands             files:read           files:write          groups:history
groups:read          im:history           im:read
im:write             pins:read            pins:write
reactions:read       reactions:write      users:read
```

`commands` is required for the Slack slash-command surface (`/<app> agents list [all]`). `files:read` is required because Slack exposes canvas comment pagination through `files.info`, even when the target is first validated via canvas-specific APIs.

Slack thread shimmer/status updates use `assistant.threads.setStatus`; Slack's 2026 scope update allows this method with the existing `chat:write` bot scope, so no new `assistant:write` scope is needed for status-only support.

## Configuration

Add your tokens to `~/.pi/agent/settings.json`:

```json
{
  "slack-bridge": {
    "botToken": "xoxb-your-bot-token",
    "appToken": "xapp-your-app-token"
  }
}
```

That's it for a minimal setup. Start pi and Pinet appears in Slack's sidebar.

### Environment variables (alternative)

```bash
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_APP_TOKEN="xapp-..."
```

Settings in `settings.json` take priority over env vars.

### Optional Pinet mesh auth

Shared-secret mesh auth is **optional**. You can configure it with either settings keys or environment variables:

```json
{
  "slack-bridge": {
    "meshSecret": "shared-secret"
  }
}
```

```json
{
  "slack-bridge": {
    "meshSecretPath": "/Users/alice/.config/pi/pinet.secret"
  }
}
```

```bash
export PINET_MESH_SECRET="shared-secret"
# or
export PINET_MESH_SECRET_PATH="$HOME/.config/pi/pinet.secret"
```

Behavior and precedence:

- `slack-bridge.meshSecret` and `slack-bridge.meshSecretPath` override the environment fallbacks.
- Inline secrets win over secret paths. If `meshSecret` or `PINET_MESH_SECRET` is set, the corresponding `*Path` value is ignored.
- If all four values are unset, broker/follower mesh auth is disabled.
- A broker started with `meshSecretPath` creates the secret file if it does not exist yet.
- A follower started with `meshSecretPath` does **not** create the file. If the configured file is missing, follow fails with a clear error telling you to point at an existing file, provide `meshSecret` directly, or leave both unset to disable shared-secret auth.
- A follower configured for mesh auth will fail closed against an older/no-auth broker with a clear compatibility error. It will **not** silently retry as an unauthenticated follower.

### Full settings reference

```json
{
  "slack-bridge": {
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "runtimeMode": "single",
    "allowedUsers": ["U_EXAMPLE_MEMBER_ID"],
    "ingressGuard": {
      "requireMention": {
        "channels": ["C_EXTERNAL_CHANNEL_ID"],
        "mixedParticipantThreads": {
          "enabled": true,
          "trustedUsers": ["U_EXAMPLE_MEMBER_ID"]
        }
      }
    },
    "defaultChannel": "C_EXAMPLE_CHANNEL_ID",
    "logChannel": "#pinet-logs",
    "logLevel": "actions",
    "autoFollow": true,
    "ralphLoopIntervalMs": 300000,
    "ralphSnoozeAfterEmptyCycles": 0,
    "ralphSnoozeDurationMs": 1800000,
    "meshSecretPath": "/Users/alice/.config/pi/pinet.secret",
    "suggestedPrompts": [{ "title": "Status", "message": "What are you working on?" }],
    "security": {
      "readOnly": false,
      "requireConfirmation": ["slack:create_channel"],
      "blockedTools": []
    }
  }
}
```

Slack access is now **default-deny** unless you configure one of these explicitly:

- `allowedUsers` / `SLACK_ALLOWED_USERS` — allow only specific Slack user IDs
- `allowAllWorkspaceUsers: true` / `SLACK_ALLOW_ALL_WORKSPACE_USERS=true` — explicit workspace-wide opt-in

Optional explicit invocation guard: `ingressGuard.requireMention` is off by default. Set `channels` to Slack channel IDs where otherwise-actionable messages must mention the bot (`@pinet` / `<@bot>`), and set `mixedParticipantThreads.enabled: true` with `trustedUsers` to require a mention in Pinet-owned Slack threads once anyone outside `trustedUsers` plus the bot has participated. This guard is orthogonal to `allowedUsers`: sender authorization still decides who may invoke Pinet; the guard only decides when an explicit mention is required.

| Key                            | Required | Description                                                                                                            |
| ------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `botToken`                     | **yes**  | Bot User OAuth Token (`xoxb-...`)                                                                                      |
| `appToken`                     | **yes**  | App-Level Token for Socket Mode (`xapp-...`)                                                                           |
| `allowedUsers`                 | no       | Slack user IDs that can interact; when unset, access is denied unless `allowAllWorkspaceUsers` is true                 |
| `allowAllWorkspaceUsers`       | no       | Explicit opt-in for workspace-wide Slack access when you do not want a user allowlist                                  |
| `ingressGuard.requireMention`  | no       | Optional Slack ingress guard requiring `@pinet` in configured channel IDs and/or mixed-participant Pinet-owned threads |
| `defaultChannel`               | no       | Default channel for the `slack` dispatcher `post_channel` action                                                       |
| `logChannel`                   | no       | Channel for broker activity logs                                                                                       |
| `logLevel`                     | no       | `"errors"`, `"actions"` (default), or `"verbose"`                                                                      |
| `runtimeMode`                  | no       | Explicit startup mode: `"off"`, `"single"`, `"broker"`, or `"follower"`                                                |
| `autoConnect`                  | no       | Legacy compatibility alias for `runtimeMode: "single"`                                                                 |
| `autoFollow`                   | no       | Legacy compatibility alias for follower startup when a broker socket exists                                            |
| `ralphLoopIntervalMs`          | no       | Broker RALPH maintenance cadence in milliseconds; defaults to `300000` (5 minutes), valid range `1000`-`2147483647`    |
| `ralphSnoozeAfterEmptyCycles`  | no       | Broker RALPH auto-snooze trigger after N empty cycles; defaults to `0` (disabled), valid range `0`-`100`               |
| `ralphSnoozeDurationMs`        | no       | Broker RALPH auto-snooze duration in milliseconds; defaults to `1800000` (30 minutes), valid range `60000`-`86400000`  |
| `skinTheme`                    | no       | Pinet presentation skin selected at broker startup/reload (`default`, `foundation`, `cosmere`, or free-form)           |
| `slackCommandName`             | no       | Slack web app slash command name for `agents list`; defaults to `/pinet`, or `/oathgate` for Oathgate/Cosmere skins    |
| `slackCommandNames`            | no       | Optional list of accepted/deployed Slack slash command aliases when one app needs multiple command names               |
| `meshSecret`                   | no       | Optional inline Pinet shared secret; overrides `meshSecretPath` and env fallbacks                                      |
| `meshSecretPath`               | no       | Optional path to a shared-secret file; broker creates it if missing, followers require an existing file                |
| `suggestedPrompts`             | no       | Prompts shown when a user opens a new conversation                                                                     |
| `security.readOnly`            | no       | Runtime-block write-capable tools for Slack-triggered turns, including core tools like `bash`, `edit`, and `write`     |
| `security.requireConfirmation` | no       | Runtime-require Slack approval before matching tools execute; core tools need a specific Slack thread context          |
| `security.blockedTools`        | no       | Runtime-block matching tools for Slack-triggered turns, including core tools                                           |

## Scope carrier model (compatibility-first)

Slack/Pinet now threads a first-class runtime `scope` carrier through shared message contracts and runtime metadata.

For this first slice:

- **workspace/install scope** is carried as compatibility-first metadata for Slack
- **instance scope** is also carried as a first-class compatibility carrier
- today’s single-workspace deployments use one default compatibility scope
- a missing or empty Slack `teamId` stays **unknown** — the bridge does not invent a fake workspace ID
- these carriers are metadata only in this slice; enforcement and multi-install behavior land later in `#547` / `#550`

## Usage

Once configured, Pinet appears in Slack's sidebar. Users open it, type a message, and the pi agent responds.

```
User opens Pinet in Slack sidebar
  └─► types a message
        └─► 👀 reaction appears (thinking)
              └─► message queued for pi agent
                    └─► agent responds via slack_send
                          └─► 👀 removed, reply appears in thread
```

Messages queue while the agent is busy. When the agent finishes, it automatically drains the inbox and responds.

### Reaction triggers

Slack emoji reactions are ignored by default: they do not enqueue Pinet work, trigger reviews, steer agents, interrupt owners, or cause broker/worker replies. To opt in deliberately, configure `reactionCommands` for the exact emoji aliases that should become structured Pinet requests from the reacted-to Slack message. Even configured reactions are accepted only inside an already authorized Pinet thread (for example a thread with a current Pinet owner, or persisted Slack assistant-thread context). Reaction authorization is deny-by-default: it requires an explicit broker-backed authorization gate, and a thread the adapter has merely seen or cached never qualifies on its own. Reactions in ordinary, uninvoked Slack channel threads remain no-op — even from authorized users — and they do not enqueue work, persist thread state, claim ownership, or receive a Slack ACK. Messages and interactive events from users outside the allowlist also never mint known-thread state that could later admit reactions or replies. Pinet adds ✅ only when it accepts an opt-in reaction-triggered request. If it cannot process an accepted opted-in reaction, it adds ❌; check broker logs for the underlying Slack/API error. When Slack cannot return the reacted message text, Pinet can still route configured reactions when the message timestamp itself identifies an already authorized thread; otherwise it ignores the reaction safely.

### Available tools

Slack-bridge uses progressive disclosure to keep the per-turn tool surface
small:

| Tool          | Description                                                                 |
| ------------- | --------------------------------------------------------------------------- |
| `slack_inbox` | Hot-path inbox drain for pending incoming Slack messages                    |
| `slack_send`  | Hot-path reply tool for Slack assistant threads                             |
| `slack`       | Dispatcher for all non-hot Slack actions; call `action: "help"` for schemas |

Cold Slack actions live behind the `slack` dispatcher:

| Dispatcher action      | Description                                                                       |
| ---------------------- | --------------------------------------------------------------------------------- |
| `react`                | Add an emoji reaction to a message                                                |
| `read`                 | Read messages from a thread                                                       |
| `upload`               | Upload files, snippets, or diffs into Slack                                       |
| `file`                 | Download Slack-hosted files to a controlled local temp cache by file ID           |
| `schedule`             | Schedule a message for later delivery                                             |
| `post_channel`         | Post to a channel (by name or ID)                                                 |
| `delete`               | Delete a bot-posted message or an entire thread                                   |
| `read_channel`         | Read channel history or a thread in a channel                                     |
| `create_channel`       | Create a new Slack channel                                                        |
| `project_create`       | Create a project channel + RFC canvas + bot invite in one call                    |
| `pin`                  | Pin or unpin a message                                                            |
| `bookmark`             | Add, list, or remove channel bookmarks                                            |
| `export`               | Export a thread as markdown, plain text, or JSON                                  |
| `presence`             | Check if users are active, away, or in DND                                        |
| `canvas_comments_read` | Read comments attached to a verified canvas by canvas ID or channel canvas lookup |
| `canvas_create`        | Create a standalone or channel canvas                                             |
| `canvas_update`        | Append, prepend, or replace canvas content                                        |
| `modal_open`           | Open a modal from a trigger interaction                                           |
| `modal_push`           | Push a new step onto a modal stack                                                |
| `modal_update`         | Update an existing open modal                                                     |
| `confirm_action`       | Request user confirmation before a dangerous action                               |

Use `slack` with `action: "help"` for the action catalogue, or
`action: "help", args: { "topic": "canvas_update" }` for a specific JSON
schema and example invocations. Dispatcher responses use a consistent
`{ "status", "data", "errors", "warnings" }` envelope. Guardrails match
cold Slack actions as `slack:<action>` (for example `slack:upload` or
`slack:canvas_update`); legacy `slack_<action>` patterns are accepted during
migration.

#### Tool and workflow usage notes

- **Reply where the work arrived.** Use `slack_send` for assistant-thread
  replies. If a task was delivered in a Slack thread, acknowledge briefly,
  do the work, report blockers immediately, and finish with the outcome. If
  you know only a channel/thread pair, use dispatcher action `post_channel`
  with `channel` and optional `thread_ts` instead.
- **Channel posting is explicit.** `post_channel` posts to a named channel or
  channel ID. When `channel` is omitted, it first resolves a provided
  `thread_ts` to a tracked thread channel, then falls back to `defaultChannel`
  from settings. `slack_send` is intentionally narrower and resolves the
  current tracked assistant thread/DM context.
- **Rich messages use Block Kit JSON.** Pass `blocks` directly to
  `slack_send` or `post_channel`; keep `text` as the notification/fallback.
  Block Kit builder tools are not registered by this package. Load the bundled
  `slack-bridge` skill for copyable status-report, button, code, and diff
  templates. The package also bundles `pinet-skin-creator` for safely drafting
  or reviewing curated Pinet skin descriptors and character/status-vocabulary
  pools before changing runtime skin wiring.
- **Modal helpers are patterns, not hot tools.** Use dispatcher actions
  `modal_open`, `modal_push`, and `modal_update` with Slack view JSON. Open or
  push immediately after receiving a fresh `trigger_id`; Slack trigger IDs
  expire quickly. Include `thread_ts` when submissions should route back to an
  original assistant thread.
- **Uploads are for bulky artifacts.** Use `upload` for logs, screenshots,
  long diffs, and generated files instead of large inline messages. Inline
  uploads require `filename`; path uploads are guarded and must stay within the
  current working directory or system temp directory. `slack_send` also accepts
  `files: [{ path, filename?, title?, filetype? }]` so one assistant-thread
  reply can contain both text and local binary attachments in the same Slack
  file upload message. Slack external file uploads cannot include Block Kit in
  that same message, so omit `blocks` when sending files or send a separate
  block-only reply.
- **Inbound Slack files are fetched explicitly.** Incoming file-share messages
  preserve safe `slackFiles` metadata such as file ID, name, type, size, and
  permalink, but private Slack download URLs are not exposed in normal tool
  output. To inspect raw content, call dispatcher action `file` with
  `op: "download"`, `file_id`, and optionally `thread_ts`, `message_ts`, and
  `channel`. The bot fetches the file with Slack bot auth, stores it under the
  system temp `pi-slack-files` cache with best-effort TTL cleanup, and returns a
  descriptor containing the local path, filename, type, size, SHA-256, expiry,
  and residual privacy risks.
- **Upload host egress note.** The second upload leg goes to Slack file upload
  hosts (`files.slack.com`/`uploads.slack.com`) for the raw payload. In
  environments with restricted egress this can fail with `403` (proxy
  allowlist) or DNS errors after `files.getUploadURLExternal`; verify the proxy
  allowlist first, or route through an environment that can reach those hosts.
- **Upload metadata note.** Slack snippet uploads attempt to use inferred
  `snippet_type` values for inline content and retry with plain upload metadata
  when Slack returns `invalid_arguments`, preserving syntax highlighting for
  supported types while avoiding hard failures on unsupported snippet types.
- **Canvases are long-lived docs.** `canvas_create` creates standalone or
  channel canvases. If Slack rejects channel tab creation with
  `canvas_tab_creation_failed`, it falls back to a standalone canvas attached to
  the channel, attempts to bookmark the canvas URL, and returns the fallback
  `canvas_id` for future `canvas_update` calls. `canvas_update` can append,
  prepend, replace the whole canvas, or replace a matched section;
  `canvas_comments_read` is read-only and limited to verified canvas targets.
- **Scheduling, pins, and bookmarks are durable affordances.** Use `schedule`
  for delayed reminders instead of waiting; use `pin` for important thread
  messages; use `bookmark` for persistent channel-header links to repos,
  dashboards, docs, or runbooks.
- **Presence helps choose timing.** Use `presence` before pinging humans when
  active/away/DND status affects routing or whether to schedule a follow-up.
- **Destructive actions stay constrained.** `delete` can remove only messages
  posted by the current bot and every delete call requires `confirm: true`.
  Whole-thread deletion additionally requires `thread: true` and succeeds only
  when every message in the target thread belongs to the current bot. Prefer
  asking for explicit approval before destructive cleanup.
- **Confirm guarded actions in the same thread.** If guardrails require
  confirmation, call `confirm_action` with the target `thread_ts`, exact tool
  name, and the exact action string required by the guarded tool. The safest
  flow is: attempt the guarded call, copy the `requires confirmation for action
...` string from the error, request confirmation, wait for the user's approval
  via `slack_inbox`, then retry the guarded call unchanged. Batched
  multi-thread Slack turns cannot satisfy a single-thread confirmation.
- **Plain emoji reactions are not tasks.** Slack emoji reactions are ignored
  unless `reactionCommands` explicitly opts that emoji into structured
  reaction-trigger handling and the reacted message belongs to an already
  authorized Pinet thread. If an opt-in reaction-triggered request or a Block
  Kit/modal interaction payload arrives through `slack_inbox` with metadata,
  treat it as a user instruction tied to the referenced Slack thread or
  message.

#### Common dispatcher examples

Reply in the current Slack assistant thread with Block Kit:

```json
{
  "text": "Deploy complete — branch main, checks passed.",
  "blocks": [
    {
      "type": "section",
      "fields": [
        { "type": "mrkdwn", "text": "*Branch*\n`main`" },
        { "type": "mrkdwn", "text": "*Checks*\n✅ lint/typecheck/test" }
      ]
    }
  ]
}
```

Post a channel/thread update through the dispatcher:

```json
{
  "action": "post_channel",
  "args": {
    "channel": "#pinet-logs",
    "thread_ts": "1712345678.000100",
    "text": "PR #123 is ready for review."
  }
}
```

Upload a generated diff snippet:

```json
{
  "action": "upload",
  "args": {
    "content": "diff --git a/README.md b/README.md\n...",
    "filename": "docs.diff",
    "filetype": "diff",
    "title": "Docs changes",
    "thread_ts": "1712345678.000100"
  }
}
```

Request confirmation before a guarded destructive action after copying the
exact action string from the guardrail error:

```json
{
  "action": "confirm_action",
  "args": {
    "thread_ts": "1712345678.000100",
    "tool": "slack:delete",
    "action": "channel=#pinet-logs | thread_ts=1712345678.000100 | ts=1712345678.000200 | thread=false"
  }
}
```

#### Canvas comment inspection

The `canvas_comments_read` dispatcher action is intentionally narrow:

- it validates the target with `canvases.sections.lookup` before reading comment pages via `files.info`
- it needs `files:read` because Slack exposes canvas comments through the file API surface
- it will **not** inspect generic Slack files, non-canvas file comments, or full canvas body/history

### Slash commands

| Command                    | Description                                                |
| -------------------------- | ---------------------------------------------------------- |
| `/pinet <action>`          | Unified Pinet command surface; run `/pinet help` for usage |
| `/pinet status`            | Show connection status, threads, and agent identity        |
| `/pinet rename`            | Change the agent's display name                            |
| `/pinet logs`              | Show recent broker activity log entries                    |
| `/<app> agents list [all]` | Slack-native broker roster, workload, task, and lane view  |

## Runtime modes

`slack-bridge` now treats runtime mode as an explicit concept:

| Mode       | Meaning                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `off`      | Slack bridge is loaded, but **no Slack Socket Mode ingress** and no coordination runtime are started.                                                                    |
| `single`   | One local Pi session owns Slack ingress and local thread/inbox ownership only. No broker DB/socket/client, no RALPH/control plane, no mesh auth, no multi-agent surface. |
| `broker`   | The session runs the broker coordination runtime.                                                                                                                        |
| `follower` | The session connects to an existing broker as a worker runtime.                                                                                                          |

Startup selection:

- `runtimeMode` is the explicit startup selector.
- `autoConnect` is a legacy compatibility alias for `runtimeMode: "single"`.
- `autoFollow` is a legacy compatibility alias for `runtimeMode: "follower"` when a broker socket is available.
- explicit `runtimeMode` wins over the legacy flags.
- `/pinet start` and `/pinet follow` still switch the live session into broker/follower runtimes explicitly.

## Scope carriers (compatibility-first)

`slack-bridge` now emits first-class runtime scope carriers in shared transport contracts and agent runtime metadata.

- `scope.workspace` models the current Slack install/workspace scope.
- `scope.instance` models the current broker/runtime instance scope.
- in the first slice, both stay **compatibility-first**: today’s singleton runtime gets one default compatibility scope
- if Slack omits `team_id`, the carrier keeps the workspace id **unknown** instead of inventing a fake one
- this slice is metadata/plumbing only: it does **not** change routing, enforcement, or multi-install orchestration yet

## Pinet (Multi-Agent Mode)

Pinet supports a broker/follower architecture for coordinating multiple pi agents over Slack.

### Runtime composition boundary

Broker startup is composed as Pinet core plus injected transport adapter factories. `broker-runtime.ts` starts the broker DB/socket/router and skin/agent state, then calls `createAdapterBindings` to attach transports. The packaged Slack bridge passes `createSlackPinetRuntimeAdapterFactory(...)`, while tests use an in-memory non-Slack adapter to demonstrate the same boundary without Slack tokens or Slack-specific metadata. Adapter factories return `MessageAdapter` bindings; the core wires inbound delivery, registers adapters on the broker, and connects them.

### Quick start

**Broker** (one per mesh — coordinates routing and health):

```
/pinet start
```

**Follower** (workers that connect to the broker):

```
/pinet follow
```

Or set `"runtimeMode": "follower"` in settings (or the legacy `"autoFollow": true`) to auto-connect when a broker is running.

### Broker prompt MD

Broker coordination policy is loaded from Markdown. Configure `slack-bridge.brokerPrompt` to choose a packaged prompt preset such as `tmux` or to point at a custom Markdown file path. Relative paths resolve under the current repo/worktree root; `~/...` paths resolve under the user home directory. When no setting is present, the broker scans for the first valid prompt in this order:

1. workspace override: `.pi/slack-bridge/tmux.md` under the current repo/worktree root
2. user-local override: `~/.pi/agent/slack-bridge/tmux.md`
3. packaged default: `dist/prompts/broker/tmux.md`

Invalid higher-priority files (unsafe symlink/path escape, unreadable file, oversized content, invalid UTF-8/binary-looking content, or empty file) emit a concise warning and fall through to lower-priority candidates. Warnings identify only the candidate kind and reason; prompt bodies and private paths are not echoed.

The packaged `tmux.md` captures the default fully autonomous / unchained broker operating policy: the broker coordinates and never implements, delegates to repo-scoped workers, starts fresh tmux-backed workers on the Mac mini for new repo-scoped tasks/lanes unless a maintainer explicitly asks for reuse, marks broker-launched followers with `PINET_BROKER_MANAGED=1 PINET_BROKER_AGENT_ID=<current-broker-agent-id> PINET_LAUNCH_SOURCE=broker-tmux PINET_TMUX_SESSION=<session>` so PID ownership is inspectable, records tmux session/socket and repo/worktree metadata in durable lane state, keeps completed workers available for a one-hour follow-up grace period, routes follow-up back to the same Pi instance when possible, asks grace-expired healthy idle broker-managed workers to exit only when inspectable Pinet signals or the worker confirm they are free, fails closed by reporting ambiguous cleanup candidates, prunes old broker-managed tmux capacity instead of recycling stale context into new lanes, observes RALPH loop maintenance expectations, handles Slack thread ownership/reporting caveats, and describes GitHub/secret handling without exposing secrets.

Only broker prompt content is replaceable. Broker runtime/tool restrictions remain code-owned and are appended after the loaded MD prompt, including the forbidden local `Agent` path and broker `edit`/`write` blocking. Followers keep append-only worker guidance and do not load broker prompt MD. Prompt changes are picked up on `/pinet start` / runtime restart; this slice does not hot-reload per turn.

### Multi-agent tools

| Tool    | Description                                                                                                                                                                            |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pinet` | Pinet dispatcher with token-efficient `action`-based routing (`help`, `send`, `read`, `free`, `snooze`, `schedule`, `agents`, `sessions`, `lanes`, `ports`, `spawn`, `reload`, `exit`) |

Use the dispatcher for Pinet tool actions: `pinet action=send`, `pinet action=read`, `pinet action=free`, `pinet action=snooze`, `pinet action=schedule`, `pinet action=agents`, `pinet action=sessions`, `pinet action=lanes`, `pinet action=ports`, `pinet action=spawn`, `pinet action=reload`, and `pinet action=exit`. Use slash commands for UI lifecycle transitions: `/pinet start`, `/pinet follow`, `/pinet unfollow`, and `/pinet subtree start`. Dedicated direct Pinet tools (`pinet_message`, `pinet_read`, `pinet_agents`, `pinet_free`, `pinet_schedule`) are no longer registered. Legacy `pinet_*` guardrail patterns still match dispatcher action names, and legacy send policies such as `pinet_send` or `pinet_message` also cover `pinet action=send`, so existing security configs fail closed during migration.

Worker-owned subtree brokers let a follower worker supervise its own child mesh without registering those children in the central broker. Run `/pinet subtree start` (alias: `/pinet subbroker start`) from a follower worker. The worker remains connected to the central broker as a normal worker, and it also starts a separate broker socket/database under `~/.pi/pinet-subtrees/<worker>/`. Child workers launched by this worker receive `PINET_SOCKET_PATH`, `PINET_PARENT_AGENT_ID`, `PINET_ROOT_AGENT_ID`, `PINET_LAUNCH_ID`, `PINET_SUBTREE_ROLE`, and related metadata, so they follow the worker's subtree broker instead of the central Pinet broker.

Use `pinet action=spawn args.repo=<repo> args.task=<task> [args.role=<role>] [args.lane_id=<lane>]` or `/pinet subtree spawn repo=<repo> [role=<role>] [lane=<lane>] <task>` to launch a tmux-backed child worker, wait for it to register in the subtree broker, and deliver the task over private Pinet A2A. Use `pinet action=agents args.scope=subtree args.full=true` from the supervising worker to list subtree children, `pinet action=send args.to=<child> args.message=<message>` to reply/control them, `pinet action=read` to read child reports, and `pinet action=exit args.target=<child>` or `/pinet subtree stop` to clean them up. The central broker sees only the supervising worker; the subtree DB contains the child roster and messages.

Dispatcher content defaults to terse CLI-style confirmations/summaries for noisy reads, sends, agent lists, and session lookups. Bulky read/agent/session payloads are compacted in `data.details` by default, including when `args.format="json"` (or `args.f` / `args["-f"]`) renders the dispatcher envelope in content. Use `args.full=true` / `args["--full"]=true` only when you need verbose text and full structured debug details such as exact message bodies, agent metadata, stable session IDs, or local session JSONL paths.

`pinet action=agents` shows a broker-safe session reference (`session:<digest>`) alongside pid in verbose roster output without exposing raw local paths by default. Use `pinet action=sessions args.agent_name="Frozen Hazel Whale"` to search live and historical worker sessions by display name; the search also accepts `agent_id`, `thread_id`, `repo`, `worktree_path`, `tmux_session`, `since`, `until`, and `limit`. Default output redacts path-bearing stable IDs; add `args.full=true` (or JSON plus `full`) only in local/debug contexts when the broker needs the exact stable ID or Pi session JSONL path for inspection/resume.

Durable Pinet inbox notifications are classified as `steering`, `fwup`, or `maintenance/context` from explicit metadata or message cues. Follower prompts receive compact pointers such as `pinet action=read args.thread_id=...` instead of the full durable message body; agents use `pinet action=read` to retrieve the actual context. Delivery, read/ack state, and mail classification remain separate.

Scheduled Pinet wake-ups use the same durable read surface: due wake-ups are persisted/stamped as Pinet follow-up mail and surfaced through compact `pinet action=read` pointers rather than direct reminder-body prompts. Wake-up bodies and metadata are treated as mail content only; they do not trigger Pinet remote-control commands such as `/exit`, `/reload`, or structured `pinet:control` JSON.

Durable lane metadata is stored in SQLite and can be inspected/updated with `pinet action=lanes`. PM-mode lanes can record the accountable follower/PM, implementation lead, participant roles (`pm`, `lead`, `implementer`, `reviewer`, `second_pass_reviewer`, etc.), linked issue/PR, state, and summary. The `detached` lane state means a lane is manually supervised by a human; broker/RALPH/status surfaces keep it visible but should not treat it as normal auto-reassignment work without explicit human/broker action.

Durable local port leases are stored in SQLite and can be managed with `pinet action=ports`. Use `op=acquire` with `purpose` and `ttl_ms` to reserve either a requested `port` (for example `3000`) or the first free port in `min_port..max_port` (default `49152..65535`, host default `127.0.0.1`). Use `op=renew` with `lease_id` and `ttl_ms`, `op=release`, `op=status`, `op=list`, or `op=expire`. Follower RPC access is scoped to the caller-owned leases; broker-local maintenance can still expire all stale leases. Active leases are unique by `(host, port)`; broker maintenance expires stale leases conservatively, and process-kill behavior should be layered on explicit cleanup hooks rather than hidden in lease acquisition.

Broker-mode ghost cleanup is deliberately conservative. The broker stores follower PIDs in the agent registry, but it only sends real process signals for ghosts that registered with broker-managed launch metadata (`PINET_BROKER_MANAGED=1`) and still verify as Pi follower processes. Reaping sends `SIGTERM` first and schedules a bounded `SIGKILL` only if the same verified broker-managed process remains; unmarked or mismatched PIDs are never killed.

RALPH snooze quiets non-urgent empty maintenance cycles without disabling human-triggered routing. Use `/pinet snooze 30m no work available` or `pinet action=snooze args.op=set args.duration=30m` to quiet the broker manually, `/pinet snooze off` or `op=clear` to wake it, and `/pinet status` / Home tab to inspect snooze state. An empty cycle means no active live workers, no active tracked assignments, no visible RALPH anomalies, no pending backlog, no assigned backlog from broker maintenance, no maintenance anomalies, no pending task-assignment report, and no tracked task progress change. If active work, anomalies, or task progress appears during snooze, RALPH wakes and reports normally. Auto-snooze is opt-in via `ralphSnoozeAfterEmptyCycles`; the default is disabled.

### Pinet command surface

Use `/pinet <action> [args]` for mesh lifecycle and broker operations. In the Slack web app, use `/<app> agents list [all]` for the Slack-native broker roster/current-work view: `/pinet agents list` for the Pinet app, or `/oathgate agents list` for an Oathgate-named app. Set `slackCommandName` (or `slackCommandNames`) in `slack-bridge` settings before deploying the manifest when the Slack command should match a non-default app name.

| Command                                    | Description                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| `/pinet start`                             | Start as the mesh broker                                                      |
| `/pinet follow`                            | Connect as a follower worker                                                  |
| `/pinet unfollow`                          | Disconnect from the broker                                                    |
| `/pinet reload <agent>`                    | Ask another agent to reload                                                   |
| `/pinet exit <agent>`                      | Ask another agent to exit                                                     |
| `/pinet free`                              | Mark this agent as idle                                                       |
| `/pinet snooze [duration/off/status]`      | Quiet empty RALPH cycles while preserving human-triggered wake/route behavior |
| `/pinet subtree [start/status/spawn/stop]` | Run this worker as a local subtree broker for child followers                 |

### Pinet skins

Pinet skin selection is configuration-driven. Set `skinTheme` under the `slack-bridge` settings object (for example, `"skinTheme": "foundation"`) and restart/reload the broker; broker startup applies the configured presentation to broker and follower registrations. Skin selection updates mesh presentation only: names, emoji palette, persona/tone guidance, and optional display vocabulary for statuses. Core roles and states stay skin-neutral (`broker`, `worker`, `idle`, `working`, routing, repo, and guardrails are not redefined by skins).

Built-in skins:

- `default` / `classic` — preserves the current whimsical animal names, animal emoji palette, and playful-but-focused persona.
- `foundation` / `foundation/space` / `space` — JSON descriptor with curated institutional sci-fi characters, full-name aliases, and archive, relay, frontier, and crisis-room flavor.
- `cosmere` / `cosmere-inspired` / `oathgate` — JSON descriptor with curated/prebaked 1–3 word identities, static emoji, and whimsical Mistborn/Stormlight/Emberdark-inspired agents, spren, artifacts, places, and jokes while avoiding exact third-party character names.

Free-form themes are still accepted as deterministic legacy/custom presentation themes. Shipped non-default skins live in `skins/*.json`; use the bundled `pinet-skin-creator` skill to author and review curated character/name/persona/status-vocabulary pools before adding runtime descriptors.

### How it works

- The **broker** runs Slack Socket Mode, routes messages to agents, and monitors health via the RALPH loop. The loop defaults to every 5 minutes and can be configured with `ralphLoopIntervalMs` under `slack-bridge` settings.
- **Followers** connect to the broker over a local Unix socket, poll for work, and report results
- Agents can optionally authenticate using a shared local secret (`meshSecret` or `meshSecretPath`); when both are unset, mesh auth is disabled
- Thread ownership is first-responder-wins — the first agent to reply claims the thread

## Security

- **User access**: Slack access is default-deny. Set `allowedUsers` for a narrow allowlist, or `allowAllWorkspaceUsers: true` only if you explicitly want workspace-wide access
- **Tool guardrails**: `security.readOnly`, `security.requireConfirmation`, and `security.blockedTools` are runtime-enforced for Slack-triggered turns, including core tools such as `bash`, `edit`, and `write`
- **Guardrail posture**: If Slack/Pinet access is enabled for admitted users and `security.readOnly`, `security.blockedTools`, and `security.requireConfirmation` are all effectively empty (`readOnly !== true` and both arrays are absent or empty), the bridge emits a startup/runtime warning and `/pinet status` shows `Guardrails: empty (warn-first posture; behavior unchanged)`. This is visibility-only: it does **not** auto-enable `readOnly`, block startup, or require an acknowledgement flow.
- **Mesh authentication**: Optional. Configure `meshSecret` or `meshSecretPath` (or `PINET_MESH_SECRET` / `PINET_MESH_SECRET_PATH`) to require a shared secret; leave them unset to disable shared-secret auth. Configured followers fail closed on missing secret files or older/no-auth brokers rather than silently downgrading.

Find Slack user IDs: click a user's profile → **More** → **Copy member ID**.

---

## Development

### Build

```bash
pnpm run build
```

### Lint / Typecheck / Test

```bash
pnpm lint
pnpm typecheck
pnpm test
```

### Deploy manifest to Slack

```bash
pnpm deploy:slack
```

Requires `appId` and `appConfigToken` in settings (or `SLACK_APP_ID` / `SLACK_APP_CONFIG_TOKEN` env vars). The deploy path rewrites `features.slash_commands` from `slackCommandName` / `slackCommandNames` (or the configured `skinTheme`) before validating and uploading, so set `slackCommandName: "/oathgate"` for an Oathgate app and leave it unset for the packaged Pinet `/pinet` default.

### Architecture

- **Socket Mode** — outbound WebSocket, no public URL needed
- **Zero runtime npm deps** — native `fetch`, `WebSocket`, `node:sqlite` (Node 22+)
- **Hybrid inbox** — queue when busy, auto-drain when idle
- **Reactions** — 👀 as a lightweight "thinking" indicator
- **Thread persistence** — thread state survives `/reload`

## License

MIT. See [`LICENSE`](./LICENSE).
