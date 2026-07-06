---
name: pinet-follow
description: Join the local Pinet mesh as a follower from this interactive Claude Code session — like /pinet follow in pi. Registers on the mesh, then wakes this session whenever mesh messages (Slack threads, agent-to-agent) arrive, handles them, and replies through the broker. Use when the user says "pinet follow", "join the mesh", or "follow the mesh".
---

# Pinet follow (interactive Claude Code)

Make this session a live follower on the local Pinet mesh using the `pinet`
MCP tools (`pinet_follow`, `pinet_read`, `pinet_send`, `pinet_unfollow`,
`pinet_agents`, `pinet_status`). If those tools are unavailable, say so — the
`pinet` MCP server is not registered — and stop.

## Start following

1. Call `pinet_follow` (no arguments — the broker assigns the identity).
2. Report the assigned name/emoji to the user.
3. **Arm the waiter**: run the exact waiter command from the `pinet_follow`
   result via Bash with `run_in_background: true`. Its exit is what wakes this
   session when mesh messages arrive. Do not poll; do not run it in the
   foreground.
4. Yield the turn. The session now behaves normally until the waiter exits.

## On every waiter exit (the wake loop)

The waiter's output tells you which case you are in:

- **`PINET_MESSAGES`** — mesh work arrived. Treat it like a steering message:
  service it promptly at this turn boundary, before returning to other work.
  1. `pinet_read` to drain the pending messages (this acks them — you own
     them now).
  2. Handle each message as a task. Do real work in this session (files,
     tools, repo — full interactive context). Keep replies concise and
     Slack-friendly: plain text or light markdown, no giant headers.
  3. Reply to each with `pinet_send` using that message's `threadId`.
  4. **Re-arm the waiter** (same command, `run_in_background: true`).
  5. Tell the user briefly what came in and what you did, then yield.
- **`PINET_WAIT_TIMEOUT`** — nothing arrived. Silently re-arm the waiter and
  yield; no user-facing commentary needed.
- **`PINET_EXIT`** — the mesh sent an exit control or the bridge unfollowed.
  Do **not** re-arm. Tell the user the session has left the mesh.
- **`PINET_BRIDGE_GONE`** — the bridge socket died. Do not re-arm blindly;
  call `pinet_follow` again to rejoin (it restarts the socket), then arm the
  fresh waiter command it returns.

Never leave the loop silently: after handling any waiter exit, the waiter must
either be re-armed or the user told why following stopped.

## Interleaving with normal work

The user can keep chatting and directing work while following — that is the
point. Mesh messages arriving mid-task simply wake the session at the next
turn boundary; handle them then. If a mesh task is long, tell the user before
diving in.

## Stop following

When the user asks to stop (or the work is done): call `pinet_unfollow`. The
armed waiter will exit with `PINET_EXIT` — do not re-arm it. Following also
ends automatically when the session ends (the MCP server unregisters on
shutdown; no cleanup needed).
