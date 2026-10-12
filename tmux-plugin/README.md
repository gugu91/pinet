# Pinet companion tmux plugin

A separately installed **TPM plugin**, not a Pi extension or npm package.
It adapts [the Pi state publisher](../tmux/README.md) to tmux's normal format-plugin
convention: users explicitly insert placeholders into their own theme/layout.

**No theme, icons, colors, window renaming, default layout, footer, config-file
rewriting, bells or Rex polling are installed.** The only behavioral integration
is focus acknowledgement. Native Node 24+ and tmux 3.2+ on local macOS/Linux are
required; the checkout runs without `pnpm install`, npm runtime deps or a build.

## Install independently

After this PR is merged, add to your existing TPM plugin list:

```tmux
set -g @plugin 'gugu91/pinet'
```

TPM discovers the repository-root `pinet.tmux` entry and loads only this companion.
It does **not** start Pi, enable Slack, install npm packages or run repository
bootstrap scripts. While testing this PR, use `gugu91/pinet#feat/pinet-tmux-1079`.
Use TPM's normal install command (`prefix + I`). Ensure Node 24+ is on tmux's PATH.

For manual installation/a source checkout:

```tmux
run-shell '/absolute/path/to/pinet/pinet.tmux'
```

Run it **after your theme and format definitions**, or place TPM's loader after
those definitions. Theme regeneration may overwrite formats; rerun the plugin
entry after regenerating them. The Pi publisher is installed/loaded independently.

## Placeholders (window aggregates, not just the current pane)

| Placeholder             | Value                                                        |
| ----------------------- | ------------------------------------------------------------ |
| `#{pi_state}`           | Highest-priority live state in this window, empty without Pi |
| `#{pi_name}`            | Active Pi's name, otherwise first Pi, empty without Pi       |
| `#{pi_unread}`          | Number of unread live Pi panes in this window                |
| `#{pi_count}`           | Number of live Pi panes in this window                       |
| `#{pi_window_summary}`  | Optional plain-text name/states/counts summary               |
| `#{pi_session_summary}` | Same summary across the targeted client's session            |

These are plugin placeholders, expanded into `#(...)` query jobs when the plugin
loads. They are not additional built-in tmux format variables. The adapter scans
`status-left`, `status-right`, normal/current window formats, plus window-local
format overrides. It preserves all content except explicit placeholder tokens.
It does not create/add tokens itself. Theme custom text fields work when the theme
expands them into those format options **before** this plugin loads.

Queries reuse the publisher's shared helper. Stale/recycled owners are filtered,
linked panes deduplicated and acknowledgement applied. Names cannot inject tmux
formatting or terminal controls. Jobs resolve their server from `TMUX` inside the
Node helper; window/session targets are explicit. No shell parameter expressions
are embedded in nested tmux formats. Multiple attached clients do not accidentally
query the server's latest session.
The user's existing status interval controls refresh; no interval is changed.

## Optional examples — choose/edit these yourself

A minimal plain-tmux window format (no styles):

```tmux
set -g window-status-format '#I #W #{pi_state}'
set -g window-status-current-format '#I #W #{pi_state}'
```

A summary instead of the regular name:

```tmux
set -g window-status-format '#I #{pi_window_summary}'
```

The second example is Pi-only: non-Pi windows yield an empty summary. Preserve `#W`
if you want a shell-window fallback. Likewise, a window with several Pi panes shows
a plain-text aggregate, not just the current pane. No preset is applied implicitly.

For an existing theme, place the desired token into its documented text field or
append it to your existing format; preserve the theme's index, flags, styles and
other status modules. Use the [optional setup prompt](setup-prompt.md) if you want
an agent to adapt that integration to your particular configuration.

## Focus acknowledgement and uninstall

The plugin enables `focus-events` and installs only `pane-focus-in[1079]`. It
acknowledges only Pi-owned panes by copying their attention-generation marker and
setting public unread to zero. An occupied hook slot belonging to another plugin
fails **before any changes**. Other hook slots are preserved. Repeated loading is
idempotent. Do not redefine our slot while the plugin is in use.

To remove the behavioral hook:

```sh
bash /absolute/path/to/pinet/pinet.tmux uninstall
```

Only the exact recorded owned hook is removed; a replacement is preserved.
`focus-events` remains enabled because other plugins may depend on it.
Remove our placeholders from your own formats, remove the plugin line, and reload
your config before deleting the checkout/using TPM's uninstall. This restores your
chosen layout; the plugin does not keep backups or rewrite your config files.
Remove the Pi publisher separately with `pi remove npm:@pinet/tmux` if desired.

## Experimental Rex

This plugin never forwards terminal reports or installs an invisible relay job.
The publisher package's optional `rex-cli.js` adapter is separately opt-in. See its
README for protocol/ownership limitations. No automatic desktop notifications.
