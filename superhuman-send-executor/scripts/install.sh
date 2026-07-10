#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }
PREFIX=/usr/local/libexec/pinet-superhuman-send-executor
STATE=/var/db/pinet-superhuman-send-executor
PLIST=/Library/LaunchDaemons/ai.pinet.superhuman-send-executor.plist
BUNDLE=${1:?usage: install.sh SIGNED_RELEASE_DIRECTORY}
/usr/bin/codesign --verify --deep --strict "$BUNDLE/pinet-superhuman-send-executor"
/usr/bin/codesign --verify --deep --strict "$BUNDLE/shm"
install -d -o root -g wheel -m 0700 "$PREFIX" "$STATE"
install -o root -g wheel -m 0555 "$BUNDLE/pinet-superhuman-send-executor" "$PREFIX/daemon"
install -o root -g wheel -m 0555 "$BUNDLE/shm" "$PREFIX/shm"
install -o root -g wheel -m 0444 "$BUNDLE/ai.pinet.superhuman-send-executor.plist" "$PLIST"
install -o root -g wheel -m 0400 "$BUNDLE/trust-policy.json" "$STATE/trust-policy.json"
echo "Installed but not loaded. Provision the system-Keychain credential, then explicitly bootstrap with launchctl." >&2
