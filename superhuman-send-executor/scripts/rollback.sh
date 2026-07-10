#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }
# Operator must bootout first. Refuse to delete durable evidence or credentials.
launchctl print system/ai.pinet.superhuman-send-executor >/dev/null 2>&1 && { echo "service is loaded; bootout before rollback" >&2; exit 1; }
rm -f /Library/LaunchDaemons/ai.pinet.superhuman-send-executor.plist
rm -rf /usr/local/libexec/pinet-superhuman-send-executor
echo "Executable rolled back. Journal, body-free audit, trust policy, and Keychain item retained." >&2
