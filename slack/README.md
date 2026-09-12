# @pinet/slack

A separate Slack transport for `@pinet/chat`. Chat itself has no Slack dependency. The adapter receives human messages over authenticated Slack Socket Mode, posts through the Slack Web API, and calls Chat's authenticated HTTP API.

Set `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_BOT_USER_ID`, `PINET_CHAT_URL`, and a dedicated bridge-agent `PINET_SLACK_CHAT_TOKEN`. Use `PINET_SLACK_DB` to move the SQLite mapping database. Then explicitly map channels with `pinet_slack` action `bind_channel`. Thread mappings are created only after a successful root relay; unmapped replies are ignored rather than sent into the wrong thread.

The adapter prefixes inbound text with the verified Socket Mode event's Slack user ID. Configure Slack-user-to-agent mention mappings when registering programmatically. Bot events, the adapter's own user, known Slack timestamps, and known Chat IDs are suppressed to prevent loops. Tokens are authorization headers, never query parameters or logs. Socket Mode reconnects with bounded backoff.

There is no Events API HTTP receiver. Outbound Chat delivery uses bounded cursor polling because Chat's portable notification path is HTTP in this version. No live Slack send or connection is made in tests.
