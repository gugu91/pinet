# Optional agent prompt: integrate Pi state with my tmux theme

Copy the prompt below into an agent session. This is documentation, not an
automatically loaded Pi prompt or permission to edit files without confirmation.

---

Integrate the Pinet Pi-state publisher and companion tmux plugin with my existing
tmux configuration. Read their README files first. Do not invent another state
tracker or duplicate pane aggregation/liveness logic.

1. Inspect the installed tmux version, current configuration and includes, theme,
   TPM/manual plugin loading, Node version/PATH and existing hooks. Determine whether
   the Pi publisher and companion plugin are already installed. Do not change my
   live server, Pi package settings or config during inspection.
2. Ask whether I want per-window indicators, a session summary or both, and my
   preferred presentation. Keep the existing layout, colors, indices, flags,
   shell-window names, unrelated plugins and status modules by default.
3. Use the companion's documented `#{pi_state}`, `#{pi_name}`, `#{pi_count}`,
   `#{pi_unread}`, `#{pi_window_summary}` or `#{pi_session_summary}` placeholders.
   Place its loader after theme/format definitions. Native `#{@pi_*}` options are
   pane-local and lack stale-process filtering; prefer plugin aggregates for
   window/session indicators. Handle zero/one/multiple Pi panes explicitly.
4. Propose the exact diff and installation/reload commands. Explain load order,
   focus acknowledgement (`pane-focus-in[1079]`), existing status refresh cadence
   and uninstall steps. Preserve other hooks; do not enable Rex, bells or desktop
   notifications. Do not replace my theme or inject model/prompt output into status.
5. Wait for my confirmation. Back up files before applying the approved changes;
   handle symlinked/config-managed files through their actual owner rather than
   blindly overwriting them. Install only the approved components. No npm publish,
   release/tag/version change or unrelated repo changes.
6. Validate syntax/integration with an isolated tmux server first, then reload the
   live config only if authorized. Check shell-only, one-Pi and multi-Pi windows,
   state/compaction/unread transitions, return-focus acknowledgement and unchanged
   unrelated layout. Separate automated protocol checks from visual verification.
7. Report modified paths, backups, checks, remaining manual verification and exact
   rollback instructions. Keep any unsupported theme/custom config limitation
   visible rather than pretending the integration is verified.
