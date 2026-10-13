#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="$(command -v node)" || { printf '%s\n' 'pinet tmux plugin requires Node 24+ on PATH' >&2; exit 1; }
"$NODE" -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("pinet tmux plugin requires Node 24+"); process.exit(1); }'
# TMUX ends with ,server-pid,session-index. Removing the last two fields also preserves commas in paths.
# Older tmux versions escape dollars in the socket_path format variable; use the actual environment path.
SOCKET="${TMUX:?Run the plugin from tmux (TPM/run-shell)}"
SOCKET="${SOCKET%,*}"
SOCKET="${SOCKET%,*}"
exec "$NODE" "$ROOT/plugin.ts" "$SOCKET" "$@"
