# slack-bridge (Pinet)

Connect pi coding agents to Slack. Pinet provides multi-agent coordination, thread routing, and inbox tools through Socket Mode.

## Install Pinet

Install the latest version:

```bash
pi install npm:@pinet/slack-bridge
```

Pin a specific version:

```bash
pi install npm:@pinet/slack-bridge@0.2.2
```

For direct npm installation:

```bash
npm install @pinet/slack-bridge
```

## What you need

- a Slack workspace where you can install apps
- Node.js 22 or later
- pi installed on your system

## Set up your Slack app

### Create the app

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Select 'Create New App'
3. Choose 'From a manifest'
4. Select your workspace
5. Paste the contents of [`manifest.yaml`](./manifest.yaml)
6. If you want a different Slack command, change `features.slash_commands[0].command` before creating and set `slackCommandName` or `slackCommandNames` in `settings.json`
7. Select 'Create'

The manifest configures Socket Mode, the assistant view, bot scopes, event subscriptions, and slash commands automatically.

### Get your tokens

Generate two tokens:

| Token           | Where to find it                                                                | Format       |
| --------------- | ------------------------------------------------------------------------------- | ------------ |
| App-Level Token | Basic Information → App-Level Tokens → Generate (add `connections:write` scope) | `xapp-1-...` |
| Bot Token       | OAuth & Permissions → Install to Workspace → Bot User OAuth Token               | `xoxb-...`   |

### Required bot scopes

The manifest includes these scopes:

```
app_mentions:read    assistant:write      bookmarks:read
bookmarks:write      canvases:read        canvases:write
channels:history     channels:read        chat:write
commands             files:read           files:write
groups:history       groups:read          im:history
im:read              im:write             pins:read
pins:write           reactions:read       reactions:write
users:read
```

The `commands` scope enables slash commands. The `files:read` scope is needed because Slack uses `files.info` for canvas comment pagination.

## Configure Pinet

Add tokens, runtime mode, and access rules to `~/.pi/agent/settings.json`:

```json
{
  "slack-bridge": {
    "botToken": "xoxb-your-bot-token",
    "appToken": "xapp-your-app-token",
    "runtimeMode": "single",
    "allowedUsers": ["U_YOUR_USER_ID"]
  }
}
```

Pinet stays off unless you set `runtimeMode`, `autoConnect`, or `autoFollow`. Start pi after you configure access.

### Use environment variables instead

```bash
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_APP_TOKEN="xapp-..."
```

Settings in `settings.json` override environment variables.

## Control who can use Pinet

Slack access is default-deny. Configure one of these:

- `allowedUsers`: list specific Slack user IDs
- `allowAllWorkspaceUsers: true`: allow everyone in the workspace

Example with specific users:

```json
{
  "slack-bridge": {
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "allowedUsers": ["U_USER_ID_1", "U_USER_ID_2"]
  }
}
```

Find user IDs by selecting a user's profile in Slack and choosing 'Copy member ID'.

## Optional settings

### Mesh authentication

Shared-secret authentication is optional. Configure it with settings or environment variables:

Settings:

```json
{
  "slack-bridge": {
    "meshSecret": "your-shared-secret"
  }
}
```

Or use a file:

```json
{
  "slack-bridge": {
    "meshSecretPath": "/path/to/secret.txt"
  }
}
```

Environment variables:

```bash
export PINET_MESH_SECRET="your-shared-secret"
# or
export PINET_MESH_SECRET_PATH="/path/to/secret.txt"
```

How it works:

- settings override environment variables
- inline secrets override file paths
- if nothing is set, mesh auth is disabled
- brokers create the secret file if it does not exist
- followers need an existing file or will show an error

### Require mentions in channels

Make Pinet respond only when mentioned in specific channels:

```json
{
  "slack-bridge": {
    "ingressGuard": {
      "requireMention": {
        "channels": ["C_CHANNEL_ID"],
        "mixedParticipantThreads": {
          "enabled": true,
          "trustedUsers": ["U_TRUSTED_USER"]
        }
      }
    }
  }
}
```

This is separate from `allowedUsers`. Authorization decides who can use Pinet. The guard decides when a mention is needed.

### All configuration options

```json
{
  "slack-bridge": {
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "runtimeMode": "single",
    "allowedUsers": ["U_USER_ID"],
    "allowAllWorkspaceUsers": false,
    "ingressGuard": {
      "requireMention": {
        "channels": ["C_CHANNEL_ID"],
        "mixedParticipantThreads": {
          "enabled": true,
          "trustedUsers": ["U_USER_ID"]
        }
      }
    },
    "defaultChannel": "C_CHANNEL_ID",
    "logChannel": "#pinet-logs",
    "logLevel": "actions",
    "autoConnect": false,
    "autoFollow": false,
    "ralphLoopIntervalMs": 300000,
    "ralphSnoozeAfterEmptyCycles": 0,
    "ralphSnoozeDurationMs": 1800000,
    "meshSecretPath": "/path/to/secret",
    "suggestedPrompts": [
      {
        "title": "Status",
        "message": "What are you working on?"
      }
    ],
    "security": {
      "readOnly": false,
      "requireConfirmation": ["slack:create_channel"],
      "blockedTools": []
    }
  }
}
```

| Setting                  | Description                                            | Default              |
| ------------------------ | ------------------------------------------------------ | -------------------- |
| `botToken`               | Bot User OAuth Token (required)                        | none                 |
| `appToken`               | App-Level Token for Socket Mode (required)             | none                 |
| `runtimeMode`            | How Pinet runs (`off`, `single`, `broker`, `follower`) | `off`                |
| `allowedUsers`           | Slack user IDs who can use Pinet                       | none                 |
| `allowAllWorkspaceUsers` | Allow all workspace members                            | `false`              |
| `defaultChannel`         | Where to post updates                                  | none                 |
| `logChannel`             | Where to post logs                                     | none                 |
| `logLevel`               | What to log (`errors`, `actions`, `verbose`)           | `actions`            |
| `autoConnect`            | Start as a single instance when `runtimeMode` is unset | `false`              |
| `autoFollow`             | Start as follower if broker exists                     | `false`              |
| `ralphLoopIntervalMs`    | How often to check for stalls (milliseconds)           | `300000` (5 minutes) |
| `meshSecret`             | Shared secret for mesh auth                            | none                 |
| `meshSecretPath`         | File containing shared secret                          | none                 |

## Using Pinet

### In Slack

Talk to Pinet:

- Direct message: open a DM with Pinet
- In channels: mention `@pinet` (or your app name)
- Slack slash command: type `/pinet agents list` or `/pinet agents list all`

### Pi commands

Run these inside pi.

Main commands:

- `/pinet` - show available commands
- `/pinet status` - show current Pinet status
- `/pinet logs` - show recent broker activity logs
- `/pinet rename [name]` - rename this agent
- `/pinet free` - mark this agent idle

Coordinator commands:

- `/pinet start` or `/pinet broker` - become the broker
- `/pinet follow` - become a follower
- `/pinet unfollow` - disconnect from broker
- `/pinet reload <agent>` - ask another agent to reload
- `/pinet exit <agent>` - ask another agent to exit
- `/pinet snooze [duration|off|status]` - quiet empty RALPH cycles
- `/pinet subtree [start|status|spawn|stop]` - manage subtree broker mode

### From pi

Use the Pinet dispatcher for agent coordination:

```json
{
  "action": "send",
  "args": {
    "to": "@worker",
    "message": "Please review PR #123"
  }
}
```

Common actions:

- `send` - send a message to an agent or broker-only channel
- `read` - read this agent's inbox
- `schedule` - schedule a future wake-up
- `free` - mark this agent idle
- `help` - discover actions and schemas

Use `slack_send` for hot-path Slack replies. Use the `slack` dispatcher for uploads, canvases, pins, bookmarks, and other Slack actions.

## Architecture

### Broker and followers

Pinet can run as:

- single - one instance handles everything
- broker - coordinates and routes messages
- follower - receives work from the broker

The broker:

- watches Slack for messages
- assigns work to agents
- tracks who owns what
- syncs state across followers

Followers:

- connect to the broker
- receive assigned work
- stay in sync automatically

### RALPH maintenance loop

RALPH keeps broker state healthy. It:

- runs every 5 minutes by default
- checks worker presence
- releases stale claims held by unavailable workers
- observes pending backlog while broker maintenance handles assignment
- triggers wake-ups

Configure RALPH:

```json
{
  "slack-bridge": {
    "ralphLoopIntervalMs": 120000,
    "ralphSnoozeAfterEmptyCycles": 3,
    "ralphSnoozeDurationMs": 1800000
  }
}
```

### Inbox and threading

Pinet maintains an inbox for each agent. Messages are:

- routed based on thread ownership
- queued when agents are busy
- marked read when processed
- preserved across restarts

Thread ownership ensures continuity. Once an agent owns a thread, it keeps receiving those messages.

## Troubleshooting

### Socket Mode connection issues

If you see 'WebSocket error' or connection failures:

1. Check your app token is valid
2. Verify Socket Mode is enabled in your Slack app
3. Check network connectivity
4. Look for rate limiting (Slack allows 10 connections per app)

### Permission errors

If Pinet cannot perform actions:

1. Check the bot is in the channel (invite with `/invite @pinet`)
2. Verify bot scopes match the manifest
3. Reinstall the app to update permissions
4. Check `allowedUsers` includes the right user IDs

### Messages not received

If Pinet does not respond:

1. Check Socket Mode shows 'Connected' in Slack app settings
2. Verify event subscriptions are enabled
3. Check `allowedUsers` or `allowAllWorkspaceUsers`
4. Look in the log channel for errors
5. Try `/pinet status` to check if Pinet is running

### Stalled agents

If work gets stuck:

1. Check `/pinet status` for current state.
2. Check `/pinet logs` for repeated failures.
3. Wait for RALPH to run automatically.
4. Reduce `ralphLoopIntervalMs` for faster recovery if needed.

## Package information

### Publishing metadata

The package declares pi metadata in [`package.json`](./package.json):

- `keywords` includes `pi-package` for gallery discovery
- `pi.extensions` points to `./dist/index.js`
- `pi.skills` points to bundled skills
- No preview assets yet

Check the package contents:

```bash
cd slack-bridge
npm pack --dry-run
```

### Development

Build the package:

```bash
cd slack-bridge
pnpm build
```

Run tests:

```bash
pnpm test
```

Deploy the Slack manifest:

```bash
pnpm deploy:slack
```

## Security

### Default-deny access

Pinet requires explicit configuration to allow users. Without `allowedUsers` or `allowAllWorkspaceUsers`, nobody can use it.

### Token safety

- Never commit tokens to git
- Use environment variables in production
- Rotate tokens regularly
- Use separate apps for development and production

### Confirmation for dangerous actions

Configure confirmation for sensitive operations:

```json
{
  "slack-bridge": {
    "security": {
      "requireConfirmation": ["slack:create_channel", "slack:upload", "slack:delete"]
    }
  }
}
```

### Read-only mode

Prevent all modifications:

```json
{
  "slack-bridge": {
    "security": {
      "readOnly": true
    }
  }
}
```

## Support

- [GitHub repository](https://github.com/gugu91/pinet)
- [Architecture documentation](../plans/)
- Check the log channel in Slack for runtime issues
