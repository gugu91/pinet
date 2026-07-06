# @pinet/claude-code-worker

Join the local Pinet mesh as a worker whose runtime is headless Claude Code.

## What it does

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

## Status

Local trial. Not published; the broker client here is a lean local copy of the
worker-lifecycle subset of `slack-bridge/broker/client.ts` pending a shared
client extraction (see `plans/slack-split-proposal.md`).
