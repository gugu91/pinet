---
name: slack-bridge
description: Warm reference for the @pinet/slack-bridge Slack dispatcher. Use when building Slack Block Kit messages, modals, canvases, uploads, schedules, pins/bookmarks, or when you need per-action usage patterns beyond slack action=help schemas.
---

# Slack Bridge Warm Reference

Use this skill when the compact `slack` dispatcher schema is not enough. The
hot path stays small: `slack_inbox` receives work, `slack_send` replies in the
current assistant thread, and `slack` handles the cold action surface.

## Dispatcher contract

Call the dispatcher with an action and action-specific args:

```json
{
  "action": "help",
  "args": { "topic": "canvas_update" }
}
```

Every dispatcher response has this envelope in tool `details`, while the default
visible `content` is compact CLI-style text:

```json
{
  "status": "succeeded",
  "data": {},
  "errors": [],
  "warnings": []
}
```

Pass `args.format="json"` when you need the envelope in visible content, and
`args.full=true` when you need full structured details instead of compact
defaults. If an action already owns a `format` argument, such as `export`, use
`args.response_format="json"` for response presentation.

On failure, inspect `errors[0].class`, `retryable`, and `hint`. Prefer
`slack({"action":"help","args":{"topic":"..."}})` before guessing an action
schema.

Guardrails match cold actions as `slack:<action>` (for example
`slack:upload`, `slack:delete`, `slack:canvas_update`). Legacy
`slack_<action>` patterns may be accepted during migration, but new configs
should use the colon form.

## Action quick map

- Thread/channel messaging: `post_channel`, `read`, `read_channel`, `export`
- Lightweight acknowledgement: `react`
- Files/snippets: `upload`, `file`; `slack_send.files` and `post_channel.files` for text plus attachments in one message
- Time-based follow-up: `schedule`
- People/timing: `presence`
- Durable channel affordances: `pin`, `bookmark`
- Channel/project setup: `create_channel`, `project_create`
- Canvases: `canvas_comments_read`, `canvas_create`, `canvas_update`
- Modals: `modal_open`, `modal_push`, `modal_update`
- Guardrail approvals: `confirm_action`
- Destructive cleanup: `delete`

## Block Kit patterns

No Block Kit builder tool is registered. Build the JSON inline and pass it to
`slack_send` or `slack` action `post_channel` as `blocks`.

### Status report

```json
[
  {
    "type": "header",
    "text": { "type": "plain_text", "text": "Deploy complete" }
  },
  {
    "type": "section",
    "fields": [
      { "type": "mrkdwn", "text": "*Branch*\n`main`" },
      { "type": "mrkdwn", "text": "*Checks*\n✅ lint/typecheck/test" }
    ]
  },
  {
    "type": "context",
    "elements": [{ "type": "mrkdwn", "text": "PR #123 is ready for review." }]
  }
]
```

Use with:

```json
{
  "text": "Deploy complete — branch main, checks passed.",
  "thread_ts": "1712345678.000100",
  "blocks": []
}
```

### Action buttons

Stable `action_id` values make incoming `slack_block_action` metadata easy to
route. Put machine-readable context in `value` as plain text or JSON.

```json
[
  {
    "type": "section",
    "text": { "type": "mrkdwn", "text": "Approve the production deploy?" }
  },
  {
    "type": "actions",
    "elements": [
      {
        "type": "button",
        "text": { "type": "plain_text", "text": "Approve" },
        "style": "primary",
        "action_id": "deploy.approve",
        "value": "{\"deployId\":\"2026-04-24-main\",\"decision\":\"approve\"}"
      },
      {
        "type": "button",
        "text": { "type": "plain_text", "text": "Reject" },
        "style": "danger",
        "action_id": "deploy.reject",
        "value": "{\"deployId\":\"2026-04-24-main\",\"decision\":\"reject\"}"
      }
    ]
  }
]
```

### Diff/code snippet

For long diffs or logs, prefer `upload` over huge inline blocks. For short
snippets:

````json
[
  {
    "type": "section",
    "text": { "type": "mrkdwn", "text": "```ts\nconst ok = true;\n```" }
  }
]
````

## File workflows

For outbound local files, attach them to the message-posting surface you are
already using. Use `slack_send.files` for owned assistant-thread replies, and
`slack` action `post_channel` with `args.files` for explicit channel/thread
posts. Both use the same file object shape and send text plus files in one Slack
message:

```json
{
  "text": "Here is the report and the raw capture.",
  "thread_ts": "1712345678.000100",
  "files": [
    { "path": "./out/report.pdf", "title": "Report" },
    { "path": "/tmp/capture.bin", "filename": "capture.bin" }
  ]
}
```

```json
{
  "action": "post_channel",
  "args": {
    "channel": "#deployments",
    "text": "Here is the deploy evidence.",
    "files": [{ "path": "/tmp/evidence.png", "filename": "evidence.png" }]
  }
}
```

Local path guardrails still apply: paths must resolve inside the current working
directory or the system temp directory. Binary files are supported.

For inbound Slack-hosted files, use the `slackFiles` metadata from incoming
messages to get the file ID, then download explicitly:

```json
{
  "action": "file",
  "args": {
    "op": "download",
    "file_id": "F0123456789",
    "thread_ts": "1712345678.000100",
    "message_ts": "1712345678.000200"
  }
}
```

The result is a safe local descriptor with path, filename, type, size, SHA-256,
cache expiry, and residual risks. Private Slack download URLs are fetched with
bot auth but are not returned in normal output.

## Modal patterns

Modal actions require a fresh Slack `trigger_id` from a recent interaction. The
window is short (about three seconds), so do not spend an extra human turn after
receiving a trigger; call `modal_open` or `modal_push` immediately.

### Confirmation modal

```json
{
  "type": "modal",
  "callback_id": "deploy.confirm",
  "title": { "type": "plain_text", "text": "Deploy approval" },
  "submit": { "type": "plain_text", "text": "Approve" },
  "close": { "type": "plain_text", "text": "Cancel" },
  "private_metadata": "{\"workflow\":\"deploy\"}",
  "blocks": [
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "Ready to deploy `main` to production." }
    },
    {
      "type": "input",
      "block_id": "confirm_phrase",
      "element": {
        "type": "plain_text_input",
        "action_id": "confirm_phrase",
        "placeholder": { "type": "plain_text", "text": "Type CONFIRM" }
      },
      "label": { "type": "plain_text", "text": "Confirmation" }
    }
  ]
}
```

Open it:

```json
{
  "action": "modal_open",
  "args": {
    "trigger_id": "fresh-trigger-id",
    "thread_ts": "1712345678.000100",
    "view": { "type": "modal", "blocks": [] }
  }
}
```

When `thread_ts` is provided, slack-bridge embeds routing metadata in
`private_metadata` so modal submissions return to the original thread.

### Simple form input

```json
{
  "type": "modal",
  "callback_id": "incident.update",
  "title": { "type": "plain_text", "text": "Incident update" },
  "submit": { "type": "plain_text", "text": "Submit" },
  "close": { "type": "plain_text", "text": "Cancel" },
  "blocks": [
    {
      "type": "input",
      "block_id": "summary",
      "element": {
        "type": "plain_text_input",
        "action_id": "summary",
        "multiline": true
      },
      "label": { "type": "plain_text", "text": "Summary" }
    }
  ]
}
```

## Canvas patterns

Create a standalone canvas:

```json
{
  "action": "canvas_create",
  "args": { "title": "Launch plan", "markdown": "# Launch plan\n\n## Goals" }
}
```

Create/update a channel canvas:

```json
{
  "action": "canvas_create",
  "args": { "kind": "channel", "channel": "#proj-alpha", "title": "Alpha RFC" }
}
```

If Slack returns `canvas_tab_creation_failed`, `canvas_create` creates a
standalone fallback attached to the channel, attempts to add a channel bookmark,
and returns the fallback `canvas_id`. Use that `canvas_id` for later
`canvas_update` calls if Slack still does not expose a channel canvas ID.

Append to a canvas:

```json
{
  "action": "canvas_update",
  "args": { "canvas_id": "F0123", "mode": "append", "markdown": "\n## Update\nDone." }
}
```

Replace a section by lookup text:

```json
{
  "action": "canvas_update",
  "args": {
    "canvas_id": "F0123",
    "mode": "replace",
    "section_contains_text": "## Rollout",
    "section_type": "h2",
    "markdown": "## Rollout\nPhase 1 complete."
  }
}
```

Read comments only for verified canvases:

```json
{
  "action": "canvas_comments_read",
  "args": { "canvas_id": "F0123", "limit": 20 }
}
```

## Upload, schedule, pin, bookmark examples

Upload inline content:

```json
{
  "action": "upload",
  "args": {
    "content": "test log contents",
    "filename": "test.log",
    "filetype": "text",
    "thread_ts": "1712345678.000100"
  }
}
```

Upload local paths only when the file is inside the current working directory
or the system temp directory. Otherwise read the file content explicitly and use
`content`.

Schedule a follow-up:

```json
{
  "action": "schedule",
  "args": { "text": "Checking back in.", "thread_ts": "1712345678.000100", "delay": "1h" }
}
```

Pin a decision:

```json
{
  "action": "pin",
  "args": { "action": "pin", "message_ts": "1712345678.000200", "thread_ts": "1712345678.000100" }
}
```

Add a bookmark:

```json
{
  "action": "bookmark",
  "args": {
    "action": "add",
    "channel": "#proj-alpha",
    "title": "Runbook",
    "url": "https://example.com/runbook"
  }
}
```

## Confirmation and destructive actions

If guardrails require confirmation, request it in the same Slack thread. The
`action` value must be the exact action string required by the guarded tool;
the safest flow is to copy it from the `requires confirmation for action ...`
error and retry the guarded call unchanged after approval:

```json
{
  "action": "confirm_action",
  "args": {
    "thread_ts": "1712345678.000100",
    "tool": "slack:delete",
    "action": "channel=#proj-alpha | thread_ts=1712345678.000100 | ts=1712345678.000200 | thread=false"
  }
}
```

Wait for `slack_inbox` to deliver the approval before retrying the guarded
action. Every destructive delete also needs `confirm: true` after verifying the
target; whole-thread deletion additionally needs `thread: true` and only works
when every message in the target thread was posted by the current bot:

```json
{
  "action": "delete",
  "args": { "ts": "1712345678.000200", "thread_ts": "1712345678.000100", "confirm": true }
}
```
