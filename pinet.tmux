#!/usr/bin/env bash
# TPM discovers this entry point at the repository root.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$ROOT/tmux-plugin/plugin.tmux" "$@"
