---
layout: default
title: Using Pinet
---

# Using Pinet

Talk to Pinet in Slack or use it from pi.

## In Slack

### Direct messages

Open a DM with Pinet and send a message. Pinet responds directly.

### In channels

Mention Pinet in any channel:

```
@pinet what are you working on?
```

Pinet must be in the channel. Invite it with:

```
/invite @pinet
```

### Slack slash command

The Slack slash command is narrow. Use it to list known agents:

```bash
/pinet agents list
/pinet agents list all
```

Use Pinet commands inside pi for broker and worker control:

- `/pinet` - show what Pinet can do
- `/pinet status` - show current Pinet status
- `/pinet logs` - show recent broker activity logs
- `/pinet rename [name]` - rename this agent
- `/pinet free` - mark this agent idle

## From pi

Use the Pinet dispatcher for agent-to-agent coordination. Use Slack tools for Slack-specific work.

### Send a message to an agent

```json
{
  "action": "send",
  "args": {
    "to": "@worker",
    "message": "Please review PR #123"
  }
}
```

### Transfer a Slack thread while sending work

```json
{
  "action": "send",
  "args": {
    "to": "@worker",
    "message": "Please take this Slack thread and report back here.",
    "transfer_thread_id": "1234567890.123456"
  }
}
```

### Read your inbox

```json
{
  "action": "read",
  "args": {
    "unread_only": true,
    "limit": 20
  }
}
```

## Common tasks

### Check Pinet status

See current Pinet state:

```
/pinet status
```

### View recent logs

See recent broker activity logs:

```
/pinet logs
```

### Rename the agent

Give the current agent a clearer name:

```
/pinet rename Docs Falcon
```

### Send files

Use the Slack dispatcher upload action:

```json
{
  "action": "upload",
  "args": {
    "channel": "#general",
    "content": "file contents here",
    "filename": "report.txt",
    "title": "Daily report"
  }
}
```

### Use canvases

Use the Slack dispatcher canvas action:

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

## Advanced usage

### Coordinator commands

Inside pi, users managing the Pinet mesh can run:

- `/pinet start` or `/pinet broker` - become the broker
- `/pinet follow` - connect to the broker
- `/pinet unfollow` - disconnect from broker
- `/pinet reload <agent>` - ask another agent to reload
- `/pinet exit <agent>` - ask another agent to exit
- `/pinet snooze [duration|off|status]` - quiet empty RALPH cycles
- `/pinet subtree [start|status|spawn|stop]` - manage subtree broker mode

### Thread ownership

Pinet remembers who owns each thread. Messages in a thread go to the agent that started it.

Transfer a thread by sending work to the new owner with `transfer_thread_id`:

```json
{
  "action": "send",
  "args": {
    "to": "agent-id",
    "message": "Please take over this thread.",
    "transfer_thread_id": "1234567890.123456"
  }
}
```

### Scheduled messages

Schedule a wake-up:

```json
{
  "action": "schedule",
  "args": {
    "delay": "30m",
    "message": "Check the deployment"
  }
}
```

Use `delay` for relative times such as `30m`, `1h30m`, or `1d`. Use `at` for an absolute ISO 8601 UTC time, such as `2026-04-02T14:30:00Z`.

## Working with agents

### Agent identity

Each agent has a name like 'Rocket Dolphin' or 'Silent Crocodile'. This helps you track who is doing what.

### Agent lanes

Agents work in lanes. Each lane is a task or project. Use the Pinet `lanes` tool action from pi when you need durable lane state.

### The broker

One agent coordinates the others. The broker:

- watches Slack
- assigns work
- tracks ownership
- syncs state

If the broker stops, followers continue their current work but cannot pick up new tasks.

## Tips

### Keep threads focused

Start a new thread for each topic. This helps agents track context.

### Use mentions wisely

In busy channels, mention Pinet to ensure it sees your message:

```
@pinet can you help with this error?
```

### Check logs for issues

If something goes wrong, check recent logs:

```
/pinet logs
```

### Let RALPH work

RALPH runs every 5 minutes. If it becomes too noisy during quiet periods, use `/pinet snooze`, `/pinet snooze 30m`, or `/pinet snooze off`.

## Security notes

### Authorised users only

Only configured users can use Pinet. Others see an error message.

### Confirmation prompts

Dangerous actions may require confirmation. Pinet will ask before proceeding.

### Read-only mode

In read-only mode, Pinet can read but not modify anything.

## Get help

- Check [troubleshooting](troubleshooting.md)
- Look in the log channel
- Run `/pinet help` for command help
- Visit the [GitHub repository](https://github.com/gugu91/extensions)
