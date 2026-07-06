# Interactive Claude Code as a Pinet follower

Design note for making an interactive Claude Code session behave like `/pinet
follow` in pi — and for the seam that later gives Pinet first-class support for
non-pi harnesses. Companion to the existing `claude-code-worker` package
(headless worker daemon), which stays as-is.

## Goal

Thomas runs an interactive Claude Code session. It should:

- register on the local mesh with a broker-assigned identity, visible in
  rosters, heartbeating with live metadata — for exactly as long as the session
  lives
- receive mesh messages (broker-routed Slack threads, a2a messages, nudges)
  **as prompts in the live conversation**, without Thomas asking, including
  while the session is otherwise idle
- reply back through the broker (thread claims included)
- coexist with interactive use: Thomas can chat with the session while it is
  also a follower
- honor `exit` (and degrade gracefully on `interrupt`/`reload`)

Non-goals for v1: interrupting a Claude Code turn from the mesh (no external
interrupt surface exists), pixel-perfect status sync, subtree brokers,
spawning.

## Reference semantics: what `/pinet follow` actually does

From `slack-bridge/follower-runtime.ts`:

1. connect → auth → register (stableId from session file; broker assigns
   name/emoji unless explicit) → heartbeat every 5s with metadata
2. poll `inbox.poll` every 2s
3. partition entries: control commands (exit/interrupt/reload) → executed on
   the harness; RALPH nudges and a2a messages → injected as follow-up prompts;
   regular (Slack) messages → synced into thread state and delivered when idle
4. delivery = `deliverFollowUpMessage(text)` — the harness takes a turn on the
   injected prompt; its response flows back to the mesh thread
5. thread claims on owned threads; reclaim on reconnect; `status.update`
   working/idle mirroring harness busyness; ack after delivery

The whole follower is therefore: **mesh mechanics** (1, 2, 5, acks) plus a
**harness adapter** (3, 4: deliver prompts into a live conversation, run
control commands, reflect busy/idle). Pi fuses these; the design below splits
them, which is the entire extensibility story.

## Claude Code's available surfaces (and the two hard constraints)

Available:

- **MCP servers (stdio, user/project scope)** — a long-lived child process per
  session, spawned at session start, killed at session end. Can hold sockets,
  timers, state; exposes typed tools. This is the only process whose lifetime
  _equals_ the session's — perfect for registration + heartbeats
  (auto-unregister on session death, no ghost reaping needed).
- **Background tasks re-invoke the model.** A Bash command started with
  `run_in_background` keeps running across turns and _re-invokes the session
  when it exits_ — even if the session is sitting idle at the prompt. This is
  Claude Code's equivalent of "inject a follow-up prompt": a blocking waiter
  process that exits when a mesh message arrives wakes the conversation.
  (Assumption to validate in the v1 smoke; if a given CC surface doesn't
  re-invoke on idle, fallback is Stop-hook injection + a `/loop` poll.)
- **Hooks** (SessionStart, Stop, PreToolUse…) — optional robustness: a Stop
  hook can block end-of-turn and inject "pending mesh messages" so items that
  arrive mid-conversation are handled without waiting for the waiter cycle.
- **Skills** — package the follow behaviour as `/pinet-follow` so the loop is
  self-instructing and survives compaction.

Hard constraints:

1. **No mid-turn push.** Nothing can inject text into a turn in progress; a
   message arriving while the model is working is handled at the next turn
   boundary (waiter-exit notification queues). Acceptable — pi's delivery is
   also effectively at-idle for regular messages.
2. **No external interrupt.** Only the human can stop a turn. Mesh `interrupt`
   gets a courteous "not supported in interactive mode" reply (the _headless_
   worker does support it via child kill).

## Design

### Component 1: `pinet` MCP server = the follower bridge

One process per CC session (stdio MCP, registered in Claude Code user scope).
Embeds the existing `WorkerBrokerClient` from `claude-code-worker`. On first
`pinet_follow` call (not at spawn — you don't want every CC session on the
mesh):

- connect/auth/register with `stableId = claude-code:<cc-session-id>`,
  broker-assigned identity, metadata `runtime:claude-code`,
  `harness:interactive`, cwd/repo/branch tags
- heartbeat every 5s; reconnect with re-register (already in the client)
- start polling `inbox.poll` every 2s into a local **spool** (in-memory +
  json file for crash recovery)
- open a **per-session unix socket** (`~/.pi/claude-code-worker/sessions/
<session-id>.sock`, 0600) serving the waiter (below)

Tools exposed to the model:

| Tool                              | Behaviour                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pinet_follow` / `pinet_unfollow` | join/leave the mesh (idempotent)                                                                              |
| `pinet_read`                      | drain spool: returns pending items formatted like pi's `formatPinetInboxMessages`, marks them delivered, acks |
| `pinet_send`                      | reply: regular thread → `message.send` (+ auto `thread.claim` on first send); a2a → `agent.message` to sender |
| `pinet_agents`                    | roster (`agents.list`)                                                                                        |
| `pinet_status`                    | manual working/idle override (rarely needed; see status below)                                                |

Control commands are handled in the bridge where possible: `exit` → unregister,
close socket, waiter exits with `EXIT` sentinel (model is instructed to stop
re-arming); `interrupt`/`reload` → ack + polite unsupported reply.

### Component 2: the waiter (`pinet-claude-worker wait --session <id>`)

A trivial CLI (same package) that connects to the bridge's unix socket and
**blocks until the spool is non-empty** (or timeout, default ~50 min), then
exits printing a one-line summary ("2 mesh messages pending: …"). The model
runs it via Bash `run_in_background` — its exit re-invokes the session. It
holds no mesh state; the MCP server owns everything.

### Component 3: the `/pinet-follow` skill (the loop driver)

Instructs the session:

1. call `pinet_follow`; report assigned identity
2. start the waiter in the background
3. when the waiter exits: `pinet_read` → handle each message as a task (do the
   work; for Slack threads keep replies Slack-friendly) → `pinet_send` the
   result → **re-arm the waiter** → yield the turn back to Thomas
4. on `EXIT` sentinel or `pinet_unfollow`: stop re-arming

The skill is what makes it _behave_ like `/pinet follow`; the bridge makes it
_safe_ (nothing is lost if the model forgets — messages sit in the spool and
the next waiter/read picks them up; a Stop hook can also nag).

### Status semantics (v1, honest and simple)

- `idle` when the waiter is armed and the spool is empty
- `working` from waiter-exit (bridge flips it when the spool hands items to
  `pinet_read`) until the next waiter arm
- interactive chatter that never touches pinet tools leaves status idle — fine
  for v1; RALPH nudges on a busy-looking-idle agent just become visible prompts

### Message flow walkthrough

Slack message → broker routes to this agent → bridge poll picks it up → spool →
waiter unblocks and exits → CC session wakes → `pinet_read` → model does the
work in the session (full interactive context, user watching) → `pinet_send`
(auto-claims thread) → bridge acks → model re-arms waiter → idle.

## The extensibility seam: Follower Bridge Protocol

The MCP server above is really two things fused: (a) a **harness-agnostic
follower bridge** (register/heartbeat/poll/spool/ack/claim/control) and (b) a
thin **Claude Code adapter** (MCP tools + waiter + skill). The proposal to
take upstream once proven:

1. Extract the bridge into `@pinet/follower-bridge`: a library + standalone
   `pinet-bridge` daemon exposing the local control surface
   (`next` [blocking], `read`, `ack`, `send`, `claim`, `status`, `agents`,
   `shutdown`) over a unix socket with newline-JSON — deliberately the same
   style as the broker protocol.
2. A harness then needs only: start bridge → deliver `next` results into its
   conversation → route replies to `send` → reflect busy/idle → honor
   `exit`. That's the whole contract. Claude Code, Codex CLI, Cursor, a plain
   tmux REPL — each is a ~100-line adapter.
3. Pi itself can eventually ride the same bridge (its follower-runtime becomes
   an adapter), collapsing today's duplicated client logic — this is the
   "first-class support for non-pi harnesses" end state, and it's the natural
   continuation of `plans/slack-split-proposal.md`.
4. Broker niceties later: `harness:`/`runtime:` metadata surfaced in rosters
   and the control-plane dashboard; docs page "bring your own harness".

## Build order

1. **v1 (local, this branch):** MCP server + waiter CLI in
   `claude-code-worker/` (reuses client/config/sessions as-is), `/pinet-follow`
   skill + user-scope MCP registration on Thomas's machine. Smoke: follow from
   a live CC session, have the broker/another agent send it work, watch the
   session wake, reply, re-arm. Validate the background-waiter re-invocation
   assumption first — it is the only real risk.
2. **v1.5:** Stop-hook nagging for mid-conversation arrivals; auto thread
   reclaim on reconnect; spool crash-recovery polish.
3. **Upstream:** shared broker client extraction → follower-bridge extraction
   → PR the worker + bridge + CC adapter with this doc as the plan.

## Status: v1 built and proven (2026-07-06)

Shipped in `claude-code-worker/` (`follower-bridge.ts`, `mcp-server.ts`,
`waiter.ts`, `cli.ts` subcommands `mcp`/`wait`, `skills/pinet-follow/`).
Local only — nothing pushed. Evidence:

- **E2E against the live broker** (MCP-protocol driver simulating the
  session): follow → broker-assigned identity → waiter armed → a2a task →
  waiter woke → `pinet_read` drained/acked → `pinet_send` reply delivered →
  `pinet_unfollow` gave armed waiters `PINET_EXIT`; bridge unregisters on
  stdin close.
- **Real Claude Code interop**: a headless `claude -p` session loaded the
  user-scope `pinet` server, followed, listed the roster, unfollowed — the
  hand-rolled MCP server speaks CC's dialect.
- **Idle-wake assumption validated live**: a background task exiting ~90s
  after the turn ended re-invoked a fully idle interactive session.
- 46 unit tests; package + repo-wide typecheck/lint green.

Machine setup (Thomas's laptop): `claude mcp add --scope user pinet -- node
<worktree>/claude-code-worker/dist/cli.js mcp` and
`~/.claude/skills/pinet-follow` symlinked into the worktree — both bind to
the worktree path; re-point them if it moves. Sessions spawn MCP servers at
start, so `/pinet-follow` only works in sessions newer than the
registration.

Protocol findings worth keeping: a2a `sender` fields are agentId UUIDs (not
names); roster `agents.list` ids are 8-char prefixes of those UUIDs (the
bridge resolves display names by prefix match); `agent.message` accepts a
UUID `targetAgent`. Pre-existing `slack-bridge` test failures on this
machine, unrelated to this branch (flag when upstreaming): one fixture
spreads `...process.env` and picks up the real exported `PINET_MESH_SECRET`;
one hardcodes a schedule date (2026-07-01) that is now in the past.

Next: trial period from fresh interactive sessions, then the upstream
sequence in Build order step 3.

## Decisions (Thomas, 2026-07-06)

1. **Opt-in.** Sessions join via `/pinet-follow`, never automatically.
2. **Steering-message delivery.** Mirror pi's behaviour: mesh messages are
   serviced promptly at the next turn boundary (the waiter-exit wake _is_ the
   turn boundary, so this falls out naturally — the skill instructs the model
   to treat wakes like steering messages and handle mesh work before
   returning to other tasks).
3. **Broker-assigned identity**, same as the rest of the mesh. The
   `harness:interactive` metadata tag distinguishes interactive followers
   from headless workers in rosters.
