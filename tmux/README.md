# @pinet/tmux — Pi state publisher

Optional Pi extension publishing **data, not a theme**. No Slack/broker, runtime
npm dependencies, agent-callable tools, footer changes, status-line customization,
configuration edits, bells or desktop notifications.

To show state in tmux, also install the separate
[companion tmux plugin](https://github.com/gugu91/pinet/tree/main/tmux-plugin): it
provides status-line placeholders and clears unread when you enter a pane. Its
README has the end-to-end quick start. Without it, you can read the raw pane
variables below directly.

## Install

Requires **Pi 1.1+**, **Node 24+**, **tmux 3.2+** and local macOS/Linux with `ps`.
Tested on macOS/tmux 3.6b and Linux CI. No Windows, nested-tmux or remote-process
monitoring support is promised.

From npm (once a release including `@pinet/tmux` is published):

```sh
pi install npm:@pinet/tmux
```

From a source checkout (until then, or to track `main`):

```sh
git clone https://github.com/gugu91/pinet.git && cd pinet
pnpm install --frozen-lockfile
pnpm --filter @pinet/tmux build
pi install ./tmux          # or try once: pi -e ./tmux/dist/index.js
```

Rebuild after pulling, then **restart** open Pi sessions (e.g. exit and `pi -c`).
`/reload` is enough for a first install, but after an update it can keep running
the previously loaded code. Check with `/tmux status`.

Don't run this alongside another Pi/tmux state extension in the same pane.

Only interactive TUI Pi with a terminal inside tmux claims its pane. RPC, print,
JSON and headless children do not overwrite a parent's state. The publisher does
not load/configure the companion plugin automatically.

## Public pane variables

| Variable     | Value                                                       |
| ------------ | ----------------------------------------------------------- |
| `@pi_state`  | `idle`, `working`, `compacting`, `blocked`, `done`, `error` |
| `@pi_name`   | Native Pi session name, or project-directory fallback       |
| `@pi_unread` | `1` or `0`; independent of execution state                  |

Read these with tmux's native `#{@pi_state}`, `#{@pi_name}`, `#{@pi_unread}` formats.
They refer to the target pane, not all panes in a window. Names are bounded to
32 graphemes; terminal controls/bidi overrides are removed and `#` is replaced
with a full-width character to prevent tmux-format injection.

Pane-local `@pi_rollup*` variables are implementation-owned record, owner,
process identity and attention/acknowledgement metadata. Consumers should use
public variables or the query helper, not parse private serialization. Direct raw
options cannot validate a crashed process; the query helper filters stale owners.

## Lifecycle and attention

Completion is published at `agent_settled`, not `agent_end`, so retries and queued
continuations do not generate premature done/error states. Cancellation is idle.
Dialogs are blocked; acknowledgement never changes execution state. Compaction
overlays the prior state and restores it on success/cancellation. Failures during
active work await its eventual outcome; idle/manual failures are errors.

`model-aware-compaction` emits scoped `{ phase: "start", sessionFile }` on
`pinet:compaction-start` before awaiting its summary. This removes load-order
dependence between these two packages. Other custom compaction handlers that await
work before our observer must emit that notice for immediate tracking.

Background subagents count as work. While [pi-subagents](https://github.com/nicobailon/pi-subagents)
async runs are active (its `subagent:async-started`/`subagent:async-complete`
events), an idle parent shows `working`, and its done/error attention waits until
they finish. Runs whose runner process has exited are dropped, so a missed
completion event cannot pin the pane to `working`. Without pi-subagents, nothing
changes.

Returning focus or interacting with Pi clears unread. Terminal replies and
focus-out do not count; input is observed, never consumed. The companion's tmux
focus hook additionally acknowledges pane returns when Pi is not receiving input.
The query helper applies its attention-generation acknowledgement even if the Pi
process has not refreshed its internal record yet.

Commands:

- `/unread`: silently renew this pane's unread attention; preserve execution state.
  It stays marked until the _next_ interaction/return, including repeated marks.
- `/tmux` or `/tmux status`: inspect this window's validated records as JSON.
- `/tmux ack`: acknowledge this pane explicitly.

There are no `/tmux setup`, theme, footer or Rex commands. Presentation belongs to
your tmux configuration and the companion plugin.

## Shared query helper

```sh
node /path/to/installed/package/dist/status.js SOCKET window WINDOW_ID aggregate
node /path/to/installed/package/dist/status.js SOCKET session SESSION_ID aggregate
node /path/to/installed/package/dist/status.js SOCKET publish
```

`publish` prints nothing. It writes every window's and session's aggregate as
tmux options in one pass (the companion plugin runs it once per status tick).
Prefer reading those options to running a query per window: each query starts a
Node process.

Modes: `json` (validated pane records), `aggregate` (counts/name/state as JSON),
`summary` (plain text, no styles/icons), `state`, `name`, `unread`, `count`.
Arguments select socket and target; no implicit latest-client routing. The companion
uses `env` instead of SOCKET to resolve the job's own `TMUX` server inside Node,
keeping shell brace/comma expressions out of tmux's nested-format parser.
The helper deduplicates linked panes, validates PID/start-time ownership, excludes
crashed/recycled owners, and applies focus acknowledgement. Its plain-text summary
is optional convenience, not a required layout.

State priority is blocked, error, compacting, working, done, idle. Unread remains a
separate count; done/error are still truthful after acknowledgement. Primary name
is the active Pi pane, falling back to the first Pi. Empty aggregates have no name
or state, count/unread zero, and empty summary.

## Experimental Rex adapter

Rex forwarding remains a **separate explicit CLI opt-in**, never enabled by the
publisher or companion plugin:

```sh
node /path/to/installed/package/dist/rex-cli.js SOCKET CLIENT_PID on
```

Replace `on` with `off`, `preview`, or `tick`. Arrange polling separately if wanted;
no automatic tick is installed in tmux formats. Disable before detaching.

The adapter writes namespaced OSC 7501 to the attached client's outer terminal.
It checks client/terminal ownership, aggregates only that client's session and
deduplicates writes. Only sanitized session names/state counts are sent—never
prompts, dialogs or model output. Native root reports are left untouched.
Compaction maps to `working`; no live Pi panes clears only our record.

Opt-in bypasses terminal feature detection. Rex visual rendering remains
unverified; detached clients may retain their last record. Reconnect requires a
new opt-in. Desktop banners were not observed in earlier experiments, so automatic
notifications remain deferred.

## Cleanup / validation

Serialized writes and owner-scoped release prevent older instances from clearing
newer ones. Shutdown/reload removes owned public/private pane options and listeners.
Crashes can leave raw options; queries ignore them without a heartbeat.

```sh
pnpm --filter @pinet/tmux lint
pnpm --filter @pinet/tmux typecheck
pnpm --filter @pinet/tmux test
pnpm --filter @pinet/tmux build
```

Tests use isolated tmux servers/temporary directories, never your live server or
configuration. They cover lifecycle, compaction, state aggregation, unread,
quoting, stale/duplicate ownership, no publisher UI changes, TPM entry/placeholder
integration, scope routing and experimental Rex protocol writes.
