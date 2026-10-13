# Pinet companion tmux plugin

Shows Pi state in **your own** tmux status line. It is a separately installed
**TPM plugin**, not a Pi extension or npm package.

It needs the [Pi state publisher](../tmux/README.md) running inside Pi: the
publisher writes each Pi pane's state, and this plugin reads, aggregates and
exposes it as placeholders. Neither layer installs a theme, icons, colors,
layout, bells or notifications. You decide where and how state appears.

Requirements: tmux 3.2+, Node 24+, local macOS/Linux. No `pnpm install` or build
step is needed for this plugin.

## Quick start

1. **Install the Pi publisher** (see [its README](../tmux/README.md#install)),
   then run `/reload` in each open Pi session (or restart it).
2. **Install this plugin** with TPM by adding it to your plugin list:

   ```tmux
   set -g @plugin 'gugu91/pinet'
   ```

   Then press `prefix + I`. Without TPM, add this line instead:

   ```tmux
   run-shell '/absolute/path/to/pinet/pinet.tmux'
   ```

3. **Add a placeholder** to a status format you already have, e.g. append
   `#{pi_window_summary}` to your `window-status-format`. See the
   [examples](#examples).
4. **Reload tmux config** (`tmux source-file ~/.tmux.conf`, or your theme's
   reload binding).

Expected result: windows running Pi show a summary such as `my-session · working`;
other windows look exactly as before.

**Load order matters.** Placeholders are expanded once, when the plugin loads.
Define your formats (or load your theme) **before** the plugin. TPM's loader
normally runs last, so this is usually automatic. Themes that regenerate formats
later need the plugin to run again afterwards.

## Placeholders

All placeholders are **per window** (all Pi panes in that window), except the
session summary.

| Placeholder             | Value                                                                          |
| ----------------------- | ------------------------------------------------------------------------------ |
| `#{pi_state}`           | Most urgent state: `blocked`, `error`, `compacting`, `working`, `done`, `idle` |
| `#{pi_name}`            | Active Pi's session name (else first Pi)                                       |
| `#{pi_unread}`          | Number of Pi panes needing attention (`0` if none)                             |
| `#{pi_count}`           | Number of Pi panes (`0` if none)                                               |
| `#{pi_window_summary}`  | Plain text, e.g. `api + 2 others · working 1 · done 2 · unread 1`              |
| `#{pi_session_summary}` | The same summary across the whole session                                      |

In windows with no Pi, text placeholders are empty and counts are `0`, so they
work as tmux conditionals: `#{?#{pi_count},…,…}`. Placeholders can be nested inside
conditionals and comparisons.

State priority is blocked → error → compacting → working → done → idle. Unread
is separate from state: `done` stays `done` after you look at it; only the unread
count drops.

### When does unread appear?

A pane becomes unread when Pi finishes a run (`done` or `error`), asks for input
(`blocked`), or when you run `/unread` in Pi. Cancelled runs don't mark it. Entering
that pane or typing in Pi clears it. If you're already in the pane when Pi
finishes, it stays unread until you type or come back.

## Examples

Use these as starting points; nothing is applied automatically.

Plain tmux, keeping the window name for non-Pi windows:

```tmux
set -g window-status-format '#I #{?#{pi_count},#{pi_window_summary},#W}'
set -g window-status-current-format '#I #{?#{pi_count},#{pi_window_summary},#W}'
```

State emoji plus name, with a bell for unread:

```tmux
set -g window-status-format '#I #{?#{pi_count},#{?#{==:#{pi_state},blocked},🙋,#{?#{==:#{pi_state},error},❌,#{?#{==:#{pi_state},compacting},🗜️,#{?#{==:#{pi_state},working},⚙️,#{?#{==:#{pi_state},done},✅,💤}}}}} #{pi_name},#W}#{?#{pi_unread}, 🔔,}'
```

Session summary on the right, keeping existing modules:

```tmux
set -ga status-right ' #{pi_session_summary}'
```

For themes (gpakosz/.tmux, Catppuccin, etc.), put the placeholder in the theme's
own window/status text option rather than overriding the final tmux option. Keep
its index, flags and styles. The [optional setup prompt](setup-prompt.md) can help
an agent adapt this to your config, with your confirmation before any edit.

Fully custom labels (e.g. emoji-only counts) can call the publisher's query
helper from your own script; see
[Shared query helper](../tmux/README.md#shared-query-helper).

## Troubleshooting

| Symptom                                       | Likely cause and fix                                                                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Literal `#{pi_…}` text in the status bar      | Plugin ran before the format was defined, or the theme regenerated it. Load the plugin after your theme, then reload.              |
| Placeholders render empty in Pi windows       | Publisher not loaded in that Pi. Install it and run `/reload`; `/tmux status` in Pi should list the pane.                          |
| `pane-focus-in[1079] is occupied` on load     | Another plugin uses that hook slot. Nothing was changed; free the slot or remove the other hook.                                   |
| Stopped working after switching Node versions | The Node path is captured at load. Reload tmux config with Node 24+ on tmux's `PATH`.                                              |
| State is not cleared when you return          | Ensure the plugin loaded (it enables `focus-events` and installs the hook). Check with `tmux show-hooks -g 'pane-focus-in[1079]'`. |

## Focus acknowledgement

The plugin enables `focus-events` and installs a single hook,
`pane-focus-in[1079]`, which clears unread when you enter a Pi pane. It touches
only Pi-owned panes and leaves other hook slots alone. Reloading is idempotent.

## Uninstall

1. Remove the placeholders from your formats.
2. From inside tmux, remove the hook:

   ```sh
   bash /absolute/path/to/pinet/pinet.tmux uninstall
   ```

   This removes only the hook the plugin installed. `focus-events` stays enabled
   because other plugins may rely on it.

3. Remove the plugin line, reload tmux config and run TPM's clean
   (`prefix + alt + u`), or delete the checkout.

The plugin keeps no backups and never edits config files. Remove the Pi
publisher separately (see its README).

## Rex

This plugin never forwards terminal reports or installs background jobs. The
publisher's experimental Rex adapter is a separate, explicit opt-in; see its
README.
