---
layout: default
title: Setup guide
---

# Setup guide

Get Pinet running in 10 minutes.

## Before you start

You need:

- a Slack workspace where you can install apps
- Node.js 22 or later
- pi installed

## Step 1: install the package

Install from npm:

```bash
pi install npm:@pinet/slack-bridge
```

Or pin a version:

```bash
pi install npm:@pinet/slack-bridge@0.2.2
```

## Step 2: create your Slack app

### Use the app manifest

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Select **Create New App**
3. Choose **From a manifest**
4. Select your workspace
5. Copy the manifest from [`slack-bridge/manifest.yaml`](https://github.com/gugu91/extensions/blob/main/slack-bridge/manifest.yaml)
6. Paste it into the text box
7. Select **Next**
8. Review the settings
9. Select **Create**

The manifest sets up:

- Socket Mode for real-time connection
- all required bot scopes
- event subscriptions
- slash commands

### Change the app name (optional)

Before creating the app, you can change:

- the app name in `display_information.name`
- the Slack slash command in `features.slash_commands[0].command`

For example, change `/pinet` to `/mybot`. If you do this by editing the manifest manually, also set `slackCommandName` or `slackCommandNames` in `settings.json` so the runtime recognises the command.

## Step 3: get your tokens

You need two tokens.

### App-level token

1. Go to **Basic Information**
2. Scroll to **App-Level Tokens**
3. Select **Generate Token and Scopes**
4. Name it (for example, 'Socket Mode')
5. Add the `connections:write` scope
6. Select **Generate**
7. Copy the token (starts with `xapp-`)

### Bot token

1. Go to **OAuth & Permissions**
2. Select **Install to Workspace**
3. Authorise the app
4. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

## Step 4: configure pi

Add tokens and choose a runtime mode in `~/.pi/agent/settings.json`:

```json
{
  "slack-bridge": {
    "botToken": "xoxb-your-bot-token",
    "appToken": "xapp-your-app-token",
    "runtimeMode": "single"
  }
}
```

Pinet stays off unless you set `runtimeMode`, `autoConnect`, or `autoFollow`.

## Step 5: control access

By default, nobody can use Pinet. Choose one option before you test Pinet:

### Allow specific users

```json
{
  "slack-bridge": {
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "runtimeMode": "single",
    "allowedUsers": ["U_USER_ID_1", "U_USER_ID_2"]
  }
}
```

Find user IDs:

1. Select a user's profile in Slack
2. Choose the three dots menu
3. Select **Copy member ID**

### Allow everyone in the workspace

```json
{
  "slack-bridge": {
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "runtimeMode": "single",
    "allowAllWorkspaceUsers": true
  }
}
```

## Step 6: start Pinet

Start pi. Pinet appears in your Slack sidebar.

Test it:

1. Open a DM with Pinet.
2. Say hello.
3. Pinet responds.

## Optional: set a default channel

Tell Pinet where to post updates:

```json
{
  "slack-bridge": {
    "defaultChannel": "C_CHANNEL_ID"
  }
}
```

Find channel IDs:

1. Right-click the channel name
2. Select **View channel details**
3. Copy the Channel ID at the bottom

## Optional: use environment variables

Instead of `settings.json`, use environment variables:

```bash
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_APP_TOKEN="xapp-..."
export SLACK_ALLOWED_USERS="U_USER_1,U_USER_2"
```

Settings in `settings.json` override environment variables.

## Next steps

- [Configure Pinet](configuration.md) for your needs
- Learn [how to use Pinet](usage.md)
- Understand the [architecture](architecture.md)
