---
layout: default
title: API reference
---

# API reference

Complete reference for Pinet tools and actions.

## Pinet dispatcher

Use the Pinet dispatcher for agent coordination. Use Slack tools for Slack-specific messages, uploads, canvases, pins, and bookmarks.

### Actions

#### send

Send a message to a connected Pinet agent or broker-only broadcast channel:

```json
{
  "action": "send",
  "args": {
    "to": "@worker",
    "message": "Please review PR #123"
  }
}
```

Parameters:

- `to` - agent name, agent ID, or broker-only broadcast channel
- `message` - message body
- `transfer_thread_id` - Slack or Pinet thread to transfer to the recipient (optional)

#### read

Read this agent's durable inbox:

```json
{
  "action": "read",
  "args": {
    "unread_only": true,
    "limit": 20
  }
}
```

Parameters:

- `thread_id` - filter to one thread (optional)
- `limit` - maximum messages, default 20 and maximum 100
- `unread_only` - only unread messages, default true
- `mark_read` - mark returned unread messages as read, default true

#### schedule

Schedule a future wake-up for the current Pinet agent:

```json
{
  "action": "schedule",
  "args": {
    "delay": "30m",
    "message": "Check queue state"
  }
}
```

Parameters:

- `delay` - relative delay such as `5m`, `30s`, `1h30m`, or `1d`
- `at` - absolute ISO 8601 UTC time, such as `2026-04-02T14:30:00Z`
- `message` - reminder or wake-up message

#### free

Mark the agent as idle and ready for more work:

```json
{
  "action": "free",
  "args": {}
}
```

#### help

Discover actions and per-action schemas:

```json
{
  "action": "help",
  "args": {
    "topic": "send"
  }
}
```

## Slack tools

Use `slack_send` for hot-path Slack replies in the current thread. Use the `slack` dispatcher for colder Slack actions.

### upload

Upload a file or snippet to Slack:

```json
{
  "action": "upload",
  "args": {
    "channel": "#general",
    "content": "file contents",
    "filename": "data.txt",
    "title": "Data export"
  }
}
```

### canvas_create

Create a Slack canvas:

```json
{
  "action": "canvas_create",
  "args": {
    "channel": "#project",
    "title": "Project plan",
    "markdown": "# Project\n\n- task 1\n- task 2"
  }
}
```

### help

Discover Slack dispatcher actions and schemas:

```json
{
  "action": "help",
  "args": {
    "topic": "upload"
  }
}
```

## Commands

Pinet has a narrow Slack slash command and a broader pi command.

### Slack slash command

#### /pinet agents list [all]

List known agents. Add `all` to include inactive agents.

If you rename the Slack command in the manifest, set `slackCommandName` or `slackCommandNames` in `settings.json`.

### Pi command

Run these inside pi.

#### /pinet

Show available commands and usage.

#### /pinet status

Show current Pinet status.

#### /pinet logs

Show recent broker activity logs.

#### /pinet rename [name]

Rename this Pinet agent.

#### /pinet free

Mark this agent as idle.

#### /pinet start

Start this session as the broker. `/pinet broker` is an alias.

#### /pinet follow

Connect as a follower to the broker. `/pinet worker` is an alias.

#### /pinet unfollow

Disconnect from the broker.

#### /pinet reload <agent>

Ask another agent to reload configuration.

#### /pinet exit <agent>

Ask another agent to exit.

#### /pinet snooze [duration|off|status]

Quiet empty RALPH cycles.

#### /pinet subtree [start|status|spawn|stop]

Run this worker as a subtree broker for child followers.

## Configuration API

Settings that affect behavior.

### Core settings

```json
{
  "slack-bridge": {
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "runtimeMode": "single"
  }
}
```

Pinet stays off unless you set `runtimeMode`, `autoConnect`, or `autoFollow`.

### Access control

```json
{
  "slack-bridge": {
    "allowedUsers": ["U_USER_ID"],
    "allowAllWorkspaceUsers": false
  }
}
```

### Runtime mode

```json
{
  "slack-bridge": {
    "runtimeMode": "single",
    "autoConnect": true,
    "autoFollow": true
  }
}
```

Use one startup option at a time. Valid `runtimeMode` values are `off`, `single`, `broker`, and `follower`.

### Mesh authentication

```json
{
  "slack-bridge": {
    "meshSecret": "secret",
    "meshSecretPath": "/path/to/secret"
  }
}
```

### Channels

```json
{
  "slack-bridge": {
    "defaultChannel": "C_CHANNEL_ID",
    "logChannel": "#pinet-logs",
    "logLevel": "actions"
  }
}
```

### RALPH settings

```json
{
  "slack-bridge": {
    "ralphLoopIntervalMs": 300000,
    "ralphSnoozeAfterEmptyCycles": 3,
    "ralphSnoozeDurationMs": 1800000
  }
}
```

### Security

```json
{
  "slack-bridge": {
    "security": {
      "readOnly": false,
      "requireConfirmation": ["slack:create_channel"],
      "blockedTools": []
    }
  }
}
```

## Slack dispatcher actions

Use the `slack` dispatcher to discover and run Slack actions. Start with `help`, then request the schema for a specific action.

### Common action families

- `read_channel` - read channel history
- `post_channel` - post to a channel
- `upload` - upload a file or snippet
- `react` - add or remove reactions
- `pin` - manage pins
- `bookmark` - manage bookmarks
- `canvas_create` and `canvas_update` - manage canvases
- `schedule` - schedule Slack messages
- `create_channel` - create channels
- `file` - read file metadata
- `delete` - delete a Slack message or supported object

Ask the dispatcher for the current action list:

```json
{
  "action": "help",
  "args": {}
}
```

## Event types

Events Pinet handles.

### Message events

- `message` - new message in subscribed channels, private channels, and DMs

### App events

- `app_mention` - bot mentioned
- `app_home_opened` - app home viewed
- `assistant_thread_started` - Slack assistant thread started
- `assistant_thread_context_changed` - assistant thread context changed

### Member events

- `member_joined_channel` - user joined

### Reaction events

- `reaction_added` - reaction added

## Error codes

Common error responses.

### Authentication errors

- `invalid_auth` - bad token
- `not_authed` - missing token
- `account_inactive` - deactivated bot

### Permission errors

- `missing_scope` - needs more permissions
- `not_in_channel` - bot not in channel
- `user_not_authorized` - user not allowed

### Rate limiting

- `rate_limited` - too many requests
- `msg_too_long` - message over 40,000 chars
- `too_many_attachments` - over 100 attachments

### State errors

- `already_exists` - duplicate resource
- `not_found` - resource missing
- `invalid_state` - bad state transition
