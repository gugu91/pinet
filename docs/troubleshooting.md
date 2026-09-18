---
layout: default
title: Troubleshooting
---

# Troubleshooting

Fix common Pinet problems.

## Pinet does not appear in Slack

### Check your tokens

Verify both tokens are in `~/.pi/agent/settings.json`:

```json
{
  "slack-bridge": {
    "botToken": "xoxb-...",
    "appToken": "xapp-..."
  }
}
```

### Check Socket Mode

1. Go to your app at [api.slack.com/apps](https://api.slack.com/apps)
2. Select **Socket Mode**
3. Verify it shows **Enabled**
4. Check **Connections** shows at least one active connection

### Check the app is installed

1. Go to **OAuth & Permissions**
2. Look for **Bot User OAuth Token**
3. If missing, select **Install to Workspace**

### Check pi is running

Verify pi started successfully. Look for startup messages mentioning Pinet.

## Pinet does not respond

### Check user permissions

Verify you are allowed to use Pinet:

```json
{
  "slack-bridge": {
    "allowedUsers": ["YOUR_USER_ID"]
  }
}
```

Or enable for everyone:

```json
{
  "slack-bridge": {
    "allowAllWorkspaceUsers": true
  }
}
```

### Check the bot is in the channel

Pinet must be a member of the channel. Invite it:

```
/invite @pinet
```

### Check mention requirements

Some channels may require mentions. Try:

```
@pinet hello
```

### Check the log channel

Look for errors in your configured log channel, or use `/pinet logs`.

## Connection errors

### WebSocket disconnections

If you see 'WebSocket error':

1. Check your internet connection
2. Verify the app token is valid
3. Check Slack's status page
4. Look for rate limiting (10 connections max per app)

### Rate limiting

Slack limits:

- 10 Socket Mode connections per app
- 1 message per second per channel
- 20 messages per minute workspace-wide

If rate limited:

- reduce message frequency
- use fewer connections
- wait for limits to reset

### Network issues

If behind a firewall:

- WebSocket connections need port 443
- Check proxy settings
- Verify SSL certificates work

## Permission errors

### Cannot send messages

Check the bot has these scopes:

- `chat:write`
- `channels:read`
- `groups:read`

Reinstall the app to update scopes.

### Cannot read messages

Check these scopes:

- `channels:history`
- `groups:history`
- `im:history`

### Cannot use slash commands

Check:

- `commands` scope is enabled
- slash command is configured in the app
- command name matches your configuration

## Agent problems

### Agents get stuck

RALPH checks automatically every 5 minutes. If it is too noisy during quiet periods, use `/pinet snooze`, `/pinet snooze 30m`, or `/pinet snooze off`.

### Dead agents persist

Check `/pinet status` and `/pinet logs`. RALPH can release stale claims after health checks, but you may still need to restart or free the affected worker.

### Work not assigned

Check:

- broker is running (`/pinet status`)
- followers are connected
- recent broker logs show incoming work (`/pinet logs`)

## Broker and follower issues

### Cannot become broker

If `/pinet broker` fails:

- check no other broker exists
- verify mesh credentials match
- check network connectivity

### Follower cannot connect

Check:

- broker is running
- mesh secrets match
- both agents can access the broker socket or configured TCP listener
- the broker and follower use compatible Pinet versions

### State not syncing

Verify:

- all instances use same mesh secret
- network is stable
- no version mismatches

## Message handling

### Messages go to wrong agent

This happens when thread ownership or routing hints are confused. Solutions:

- start a new thread
- mention the intended worker explicitly
- ask the broker to clear or transfer the stale claim

### Duplicate responses

Check for:

- multiple Pinet instances in single mode
- misconfigured broker/follower setup
- multiple apps with same token

### Missing messages

Verify:

- Socket Mode connection is stable
- event subscriptions are enabled
- bot is in the channel

## Configuration problems

### Settings not loading

Check:

- file path is `~/.pi/agent/settings.json`
- JSON syntax is valid
- pi was restarted after changes

### Environment variables ignored

Settings.json overrides environment variables. Remove settings from file to use environment variables.

### Mesh auth failures

If authentication fails:

- verify secrets match exactly
- check file permissions on secret file
- ensure broker started first

## Performance issues

### Slow responses

Check:

- RALPH interval (default 5 minutes)
- number of active agents
- Slack rate limits
- network latency

### High memory use

Reduce:

- inbox size limits
- log retention
- number of followers

### Crashes

Check logs for:

- out of memory errors
- uncaught exceptions
- network timeouts

## Common error messages

### 'not_in_channel'

The bot is not in the channel. Invite it with `/invite @pinet`.

### 'missing_scope'

The app needs more permissions. Check required scopes and reinstall.

### 'account_inactive'

The bot user was deactivated. Reactivate in Slack admin settings.

### 'invalid_auth'

Token is wrong or expired. Get new tokens from app settings.

### 'user_not_authorized'

User is not in `allowedUsers`. Add their ID or enable `allowAllWorkspaceUsers`.

## Verbose logging

Enable verbose logging:

```json
{
  "slack-bridge": {
    "logLevel": "verbose"
  }
}
```

This shows more activity, connection events, and detailed errors.

## Get more help

If problems persist:

1. Check the [GitHub issues](https://github.com/gugu91/extensions/issues)
2. Review [architecture documentation](architecture.md)
3. Look at recent changes in the repository
4. Check Slack's [API documentation](https://api.slack.com)
