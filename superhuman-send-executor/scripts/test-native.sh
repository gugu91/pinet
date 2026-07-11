#!/bin/sh
set -eu
OUT=$(mktemp -d)/credential-bridge
trap 'rm -rf "$(dirname "$OUT")"' EXIT
/usr/bin/swiftc -O -framework Security "$(dirname "$0")/../native/CredentialBridge.swift" -o "$OUT"
if "$OUT" render account draft > /dev/null 2>"$OUT.err"; then
  echo "credential bridge unexpectedly ran without root" >&2
  exit 1
fi
/usr/bin/grep -qx root_required "$OUT.err"
