# @pinet/tmux

Optional Pi extension for tmux window labels, session state and unread attention.
No Slack, broker, model tools, runtime npm dependencies or personal footer required.

This package is being prepared for distribution; no npm release is implied by this
PR. Requires **Pi 1.1+**, **Node 24+**, **tmux 3.2+**, and a local macOS/Linux host
with `ps`. Tested with Pi 1.1.0 and tmux 3.6b on macOS; CI exercises isolated servers
on Linux. Windows, nested tmux and SSH proxy forwarding are not supported yet.

## Install / preview

Once a maintainer-approved release is published:

```sh
pi install npm:@pinet/tmux
```

To try the PR checkout without changing your Pi package settings:

```sh
pnpm install --frozen-lockfile
pnpm --filter @pinet/tmux build
pi -e ./tmux
```

Install/load does **not** modify tmux configuration or enable Rex forwarding.
Interactive Pi inside tmux publishes pane state and the standard footer emoji.
Headless, JSON, print and RPC children do not claim a parent's pane.

## Commands

| Command                            | Action                                                   |
| ---------------------------------- | -------------------------------------------------------- |
| `/tmux` or `/tmux status`          | Preview this window's Pi names/states                    |
| `/tmux preview`                    | Show generated tmux integration without editing files    |
| `/tmux setup`                      | Preview and confirm reversible installation              |
| `/tmux doctor`                     | Inspect tmux version, installation and changed options   |
| `/tmux uninstall`                  | Confirm removal of the managed integration               |
| `/unread`                          | Mark this pane unread silently; preserve execution state |
| `/tmux bell on` / `/tmux bell off` | Opt-in terminal BEL on attention transitions             |
| `/tmux rex on` / `/tmux rex off`   | Experimental per-client status forwarding                |
| `/tmux ack`                        | Explicitly acknowledge this pane (normally automatic)    |

`/tmux-pi` is retained as a prototype-compatible status/bell/ack alias.
No agent-callable tools or always-on prompt instructions are added.

## What you see

One Pi in a window: `⚙️ release prep` or `✅ release prep 🔔`.
Several Pi panes: `release prep + 2 others · 🙋 1 · ⚙️ 2 · 🔔 1`.
The active Pi pane supplies the name; with a shell active, the first Pi supplies it.
Labels use Pi's native session name, falling back to the project directory, never
the goal title. Names are sanitized and bounded to 32 graphemes.
Non-Pi windows retain their sanitized window name. Existing index, flag and theme
formatting is preserved by setup. It does not rename tmux windows/sessions.

States: **🙋 blocked**, **❌ error**, **⚙️ working**, **🗜️ compacting**,
**✅ done**, **💤 idle/cancelled**, with **🔔 unread attention** separately.
Pi's footer uses `ctx.ui.setStatus("tmux-pi", ...)`, not a custom footer. Custom
footers decide placement and whether narrow-width layouts show extension statuses.
To reproduce the personal layout, prioritize `tmux-pi` in your footer's status list.

Work is complete only at `agent_settled`, not the low-level `agent_end`, so retries
and queued continuations do not generate premature completion. Compaction overlays
the prior state and remains busy; success/cancellation restores that state without
a duplicate completion bell. Selected-model compaction also emits the scoped
`pinet:compaction-start` event, observed before its awaited summary, independent of
package load order. Other custom compaction extensions that await work in an earlier
`session_before_compact` handler should emit the same `{ phase: "start", sessionFile }`
notice; absent that cooperation, the icon appears when Pi reaches our core handler.

## Attention / acknowledgement

Returning to a pane or interacting with Pi clears its unread indicator, not its
actual state. Terminal capability replies and focus-out do not count. Input is
observed, never consumed. Merely viewing a window does not acknowledge every pane.

`/unread` renews the attention generation even after an external tmux focus
acknowledgement. Submitting the command does not immediately clear the mark: the
next interaction/return does. It is silent even when bells are enabled. UI dialogs
preserve a manual mark until acknowledgement. Bells start disabled on each runtime.
No automatic desktop notifications are sent; other notification extensions may act
independently.

## Reversible setup

`/tmux setup` writes a managed include under `~/.config/pinet/tmux/` and appends a
clearly delimited source block to `~/.tmux.conf`, after confirmation. Existing
configuration is backed up before editing. Executable and companion script paths
come from the running Node executable and installed package; no Homebrew/nvm path
is hardcoded. Published companions are JavaScript, not runtime-compiled TypeScript.

Setup replaces `#W`/`#{window_name}` in normal/current window formats with the label
renderer, or appends it to index-only formats. It retains other styles/content,
including status-right/continuum, and adds an invisible opt-in Rex tick. It enables
focus events and uses only `pane-focus-in[1079]`; an occupied slot fails rather than
replacing someone else's hook. It leaves the existing status interval unchanged.
Updates use that cadence (commonly five seconds).

Uninstall removes the exact managed source block/include, restores live options
only if they still match the installed values, and preserves user edits and other
hooks. Edited managed files require manual resolution rather than destructive
removal. Symlinked `~/.tmux.conf` files are not automatically rewritten: use the
preview to add the include to your actual target manually instead. Theme scripts
that asynchronously regenerate options after config load may override them;
`/tmux doctor` reports drift. Persistent setup is for the default tmux config only;
custom `tmux -f` configurations need manual placement.

Remove the Pi package separately after uninstalling:

```sh
pi remove npm:@pinet/tmux
```

For migration from the personal prototype: unload the personal extension and
remove its managed window formats/focus hook before installing this package.
Two interactive owners in one pane deliberately supersede each other.

## Experimental Rex relay

`/tmux rex on` explicitly enables reports for the sole attached terminal client of
this pane's session. Multiple-client sessions require explicit CLI selection:

```sh
node /path/to/installed/package/dist/rex-cli.js SOCKET CLIENT_PID on
```

Replace `on` with `off`, `tick`, or `preview` (JSON, without sending).

The renderer writes OSC 7501 to the attached client's **outer terminal**, not a
pane PTY. No DCS wrapping or `allow-passthrough` change is required. Client identity,
session routing and terminal ownership are checked. Reports contain sanitized
session names and state counts only—no prompts, summaries, model output or dialog
text. Records are namespaced `id=pi-tmux`, leaving native root reports untouched.

Each enabled client's entire attached tmux session (including hidden windows) is
aggregated and deduplicated. Priority: blocked, unread error, working/compacting,
unread done, idle. Compaction maps to protocol `working`; the message identifies it.
Acknowledged done/errors remain visible in labels but no longer demand attention.
No live Pi records clears only our record. Session changes replace the summary.

Opt-in bypasses feature detection; enable only in a terminal supporting OSC 7501.
Enablement is per client connection and must be repeated after reconnect. Disable
before detaching to clear immediately: detach/exit cleanup is not implemented yet,
so the terminal can retain its last done/error record. Native Pi reporting can
coexist but its presentation priority is terminal-defined. Rex parsed native OSC
777 notification POC requests, but macOS banners were not observed; notifications
are intentionally deferred. Protocol tests prove writes, not visual rendering.

## Ownership / validation

Pane-local `@pi_rollup*` records contain state, attention token, session name and
process identity. Matching PID + start time rejects stale owners and recycled PIDs.
Writes are serialized; newer owners cannot be overwritten/cleared by older ones.
Shutdown/reload releases owned options, listeners and footer status. Crashed records
are ignored, without a heartbeat. This is not a remote process monitor.

```sh
pnpm --filter @pinet/tmux lint
pnpm --filter @pinet/tmux typecheck
pnpm --filter @pinet/tmux test
pnpm --filter @pinet/tmux build
```

Tests use temporary isolated tmux servers and temporary home directories, not your
running server/config. They cover states, compaction, names, one/multiple-pane labels,
manual unread, focus/input acknowledgement, owner/liveness checks, portable quoting,
setup reload/uninstall, per-client Rex routing and deduplication.
