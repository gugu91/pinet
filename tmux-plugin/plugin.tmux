#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="$(command -v node)" || { printf '%s\n' 'pinet tmux plugin requires Node 24+ on PATH' >&2; exit 1; }
"$NODE" -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("pinet tmux plugin requires Node 24+"); process.exit(1); }'
SOCKET="$(tmux display-message -p '#{socket_path}')"
exec "$NODE" "$ROOT/plugin.ts" "$SOCKET" "$@"
