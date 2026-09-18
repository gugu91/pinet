---
layout: default
title: Configuration
---

# Configuration

Configure Pinet to work how you need it.

## Configuration file

Settings go in `~/.pi/agent/settings.json`:

```json
{
  "slack-bridge": {
    "botToken": "xoxb-...",
    "appToken": "xapp-..."
  }
}
```

## Required settings

### Tokens

You must provide both tokens:

| Setting    | Description                     | Format     |
| ---------- | ------------------------------- | ---------- |
| `botToken` | Bot User OAuth Token            | `xoxb-...` |
| `appToken` | App-Level Token for Socket Mode | `xapp-...` |

Get these from your Slack app settings. See the [setup guide](setup.md).

## Control access

### Default behaviour

Pinet uses default-deny. Nobody can use it until you configure access.

### Allow specific users

List Slack user IDs:

```json
{
  "slack-bridge": {
    "allowedUsers": ["U_USER_1", "U_USER_2"]
  }
}
```

### Allow all workspace members

Enable workspace-wide access:

```json
{
  "slack-bridge": {
    "allowAllWorkspaceUsers": true
  }
}
```

### Require mentions in channels

Make Pinet respond only when mentioned:

```json
{
  "slack-bridge": {
    "ingressGuard": {
      "requireMention": {
        "channels": ["C_CHANNEL_1", "C_CHANNEL_2"]
      }
    }
  }
}
```

In these channels, users must mention Pinet (`@pinet`) to get a response.

### Mixed participant threads

Require mentions when non-trusted users join a thread:

```json
{
  "slack-bridge": {
    "ingressGuard": {
      "requireMention": {
        "mixedParticipantThreads": {
          "enabled": true,
          "trustedUsers": ["U_TRUSTED_1"]
        }
      }
    }
  }
}
```

## Runtime modes

Pinet is off until you set `runtimeMode`, `autoConnect`, or `autoFollow`.

### Single mode

One Pinet instance handles everything:

```json
{
  "slack-bridge": {
    "runtimeMode": "single"
  }
}
```

### Broker mode

Act as the coordinator:

```json
{
  "slack-bridge": {
    "runtimeMode": "broker"
  }
}
```

The broker:

- watches Slack
- assigns work
- syncs state

### Follower mode

Connect to a broker:

```json
{
  "slack-bridge": {
    "runtimeMode": "follower"
  }
}
```

Followers:

- receive work from the broker
- stay in sync automatically

### Auto-connect

Start as a single Pinet instance without setting `runtimeMode`:

```json
{
  "slack-bridge": {
    "autoConnect": true
  }
}
```

### Auto-follow

Start as follower if a broker exists:

```json
{
  "slack-bridge": {
    "autoFollow": true
  }
}
```

## Mesh authentication

### No authentication (default)

If you do not set mesh credentials, authentication is disabled.

### Shared secret

Use a password:

```json
{
  "slack-bridge": {
    "meshSecret": "your-secret-here"
  }
}
```

### Secret file

Store the secret in a file:

```json
{
  "slack-bridge": {
    "meshSecretPath": "/path/to/secret.txt"
  }
}
```

The broker creates the file if missing. Followers need an existing file.

### Environment variables

Use environment variables instead:

```bash
export PINET_MESH_SECRET="your-secret"
# or
export PINET_MESH_SECRET_PATH="/path/to/secret.txt"
```

## Channels and logging

### Default channel

Where Pinet posts general updates:

```json
{
  "slack-bridge": {
    "defaultChannel": "C_CHANNEL_ID"
  }
}
```

### Log channel

Where Pinet posts logs:

```json
{
  "slack-bridge": {
    "logChannel": "#pinet-logs"
  }
}
```

Use a channel ID or name with `#`.

### Log level

Control what gets logged:

```json
{
  "slack-bridge": {
    "logLevel": "actions"
  }
}
```

Options:

- `errors` - errors only
- `actions` - errors and actions (default)
- `verbose` - detailed activity logs

## RALPH maintenance

### Check interval

How often RALPH checks for problems (milliseconds):

```json
{
  "slack-bridge": {
    "ralphLoopIntervalMs": 120000
  }
}
```

Default: 300000 (5 minutes)

### Snooze after empty cycles

Pause RALPH after finding nothing to fix:

```json
{
  "slack-bridge": {
    "ralphSnoozeAfterEmptyCycles": 3,
    "ralphSnoozeDurationMs": 1800000
  }
}
```

After 3 empty cycles, RALPH sleeps for 30 minutes.

## Security

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

### Require confirmation

Ask before dangerous actions:

```json
{
  "slack-bridge": {
    "security": {
      "requireConfirmation": ["slack:create_channel", "slack:upload", "slack:delete"]
    }
  }
}
```

### Block specific tools

Disable tools completely:

```json
{
  "slack-bridge": {
    "security": {
      "blockedTools": ["dangerous_tool"]
    }
  }
}
```

## User interface

### Suggested prompts

Add quick-access prompts:

```json
{
  "slack-bridge": {
    "suggestedPrompts": [
      {
        "title": "Status",
        "message": "What are you working on?"
      },
      {
        "title": "Help",
        "message": "Show me what you can do"
      }
    ]
  }
}
```

These appear in the Slack interface.

## Complete example

A production configuration:

```json
{
  "slack-bridge": {
    "botToken": "xoxb-workspace-bot-token",
    "appToken": "xapp-socket-mode-token",
    "runtimeMode": "single",
    "allowedUsers": ["U_ADMIN_1", "U_ADMIN_2"],
    "defaultChannel": "C_PINET_GENERAL",
    "logChannel": "#pinet-logs",
    "logLevel": "actions",
    "ralphLoopIntervalMs": 120000,
    "meshSecretPath": "/home/pi/.config/pinet/secret",
    "ingressGuard": {
      "requireMention": {
        "channels": ["C_PUBLIC_CHANNEL"],
        "mixedParticipantThreads": {
          "enabled": true,
          "trustedUsers": ["U_ADMIN_1"]
        }
      }
    },
    "security": {
      "requireConfirmation": ["slack:create_channel"]
    },
    "suggestedPrompts": [
      {
        "title": "Daily status",
        "message": "/pinet status"
      }
    ]
  }
}
```

## Environment variables

These settings can use environment variables as fallback:

| Setting                  | Environment variable                    |
| ------------------------ | --------------------------------------- |
| `botToken`               | `SLACK_BOT_TOKEN`                       |
| `appToken`               | `SLACK_APP_TOKEN`                       |
| `allowedUsers`           | `SLACK_ALLOWED_USERS` (comma-separated) |
| `allowAllWorkspaceUsers` | `SLACK_ALLOW_ALL_WORKSPACE_USERS`       |
| `meshSecret`             | `PINET_MESH_SECRET`                     |
| `meshSecretPath`         | `PINET_MESH_SECRET_PATH`                |

Settings in `settings.json` override environment variables. Other settings are read from `settings.json`.
