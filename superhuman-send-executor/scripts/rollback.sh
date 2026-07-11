#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }
TARGET=${1:?usage: rollback.sh PREVIOUS_CODE_DIRECTORY_HASH}
PREFIX=/usr/local/libexec/pinet-superhuman-send-executor
launchctl print system/ai.pinet.superhuman-send-executor >/dev/null 2>&1 && { echo "service is loaded; bootout before rollback" >&2; exit 1; }
[ -d "$PREFIX/releases/$TARGET.app" ] || { echo "unknown retained release" >&2; exit 1; }
/usr/bin/codesign --verify --deep --strict "$PREFIX/releases/$TARGET.app"
/bin/ln -sfn "$PREFIX/releases/$TARGET.app/Contents/MacOS" "$PREFIX/current.next"
/bin/mv -h "$PREFIX/current.next" "$PREFIX/current"
echo "Rolled executable pointer back to retained release. Durable journal, audit, policy, and Keychain item unchanged." >&2
