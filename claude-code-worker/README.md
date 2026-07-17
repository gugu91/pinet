# @pinet/claude-code-worker

Join the local Pinet mesh from Claude Code — as a headless worker daemon, or
as an interactive follower (the Claude Code equivalent of `/pinet follow`).
Design note: `plans/claude-code-follower.md`.

## Headless worker (`pinet-claude-worker`)

A standalone daemon (not a pi extension) that speaks the broker's JSON-RPC
socket protocol directly:

- authenticates with the mesh secret and registers as a worker agent
  (broker-assigned identity by default, stable across restarts)
- heartbeats with live metadata (workdir, repo, `runtime:claude-code` tags)
- polls its inbox, claims Slack threads it works on, and executes each task
  with `claude -p --dangerously-skip-permissions --output-format json`
- maps mesh threads to Claude Code sessions so follow-ups resume context
  (`--resume`)
- sends replies back through the broker (Slack threads or agent-to-agent)
- honors `exit` and `interrupt` control commands from the mesh

## Run

```bash
pnpm --filter @pinet/claude-code-worker build
node claude-code-worker/dist/cli.js --workdir ~/projects/my-repo
```

`--help` lists all options. Persistent config lives in
`~/.pi/claude-code-worker/config.json`; session and identity state in the same
directory.

## Interactive follower (`mcp` + `wait` subcommands)

Makes a live interactive Claude Code session behave like `/pinet follow` in
pi. Three parts:

- **`pinet-claude-worker mcp`** — a stdio MCP server (register it in Claude
  Code user scope as `pinet`). Embeds the follower bridge: broker
  registration/heartbeat/poll/spool/ack/claim, exposed to the model as
  `pinet_follow`, `pinet_read`, `pinet_send`, `pinet_agents`, `pinet_status`,
  `pinet_unfollow`. Lives and dies with the session, so registration cleans
  itself up.
- **`pinet-claude-worker wait --socket <path>`** — the waiter: blocks on the
  bridge's per-session socket until messages are pending, then exits. The
  session runs it as a background task; its exit wakes the conversation —
  Claude Code's equivalent of pi's follow-up message injection.
- **the `pinet-follow` skill** (`skills/pinet-follow/SKILL.md`) — drives the
  loop: follow → arm waiter → on wake read/handle/send → re-arm.

Setup on a machine:

```bash
claude mcp add --scope user pinet -- node <repo>/claude-code-worker/dist/cli.js mcp
ln -s <repo>/claude-code-worker/skills/pinet-follow ~/.claude/skills/pinet-follow
```

Then in any Claude Code session: `/pinet-follow`. Mesh `exit` control is
honored; `interrupt`/`reload` are declined politely (interactive turns cannot
be interrupted externally).

## Status

Local trial. Not published; the broker client here is a lean local copy of the
worker-lifecycle subset of `slack-bridge/broker/client.ts` pending a shared
client extraction (see `plans/slack-split-proposal.md`).
