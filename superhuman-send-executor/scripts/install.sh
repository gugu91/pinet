#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }
BUNDLE=${1:?usage: install.sh SIGNED_RELEASE.app}
REQUIREMENT_FILE=/etc/pinet/superhuman-executor-release-requirement
[ -f "$REQUIREMENT_FILE" ] || { echo "missing pinned release signing requirement" >&2; exit 1; }
REQUIREMENT=$(/bin/cat "$REQUIREMENT_FILE")
/usr/bin/codesign --verify --deep --strict --requirement "$REQUIREMENT" "$BUNDLE"
/usr/bin/codesign --verify --strict --requirement "$REQUIREMENT" "$BUNDLE/Contents/MacOS/node"
/usr/bin/codesign --verify --strict --requirement "$REQUIREMENT" "$BUNDLE/Contents/MacOS/credential-bridge"
/usr/bin/codesign --verify --strict --requirement "$REQUIREMENT" "$BUNDLE/Contents/MacOS/shm"
/usr/bin/plutil -lint "$BUNDLE/Contents/Resources/trust-policy.json" >/dev/null
/usr/bin/launchctl print system/ai.pinet.superhuman-send-executor >/dev/null 2>&1 && { echo "service is loaded; refuse in-place replacement" >&2; exit 1; }
VERSION=$(/usr/bin/codesign -d --verbose=4 "$BUNDLE" 2>&1 | /usr/bin/awk -F= '/^CDHash=/{print $2}')
[ -n "$VERSION" ] || { echo "missing code directory hash" >&2; exit 1; }
PREFIX=/usr/local/libexec/pinet-superhuman-send-executor
STATE=/var/db/pinet-superhuman-send-executor
RELEASES="$PREFIX/releases"
STAGE="$RELEASES/.stage-$VERSION.app"
/usr/bin/install -d -o root -g wheel -m 0700 "$PREFIX" "$RELEASES" "$STATE"
/bin/cp -R "$BUNDLE" "$STAGE"
/usr/sbin/chown -R root:wheel "$STAGE"
/bin/chmod -R go-rwx "$STAGE"
/bin/chmod 0500 "$STAGE/Contents/MacOS/node" "$STAGE/Contents/MacOS/credential-bridge" "$STAGE/Contents/MacOS/shm"
/bin/mv "$STAGE" "$RELEASES/$VERSION.app"
/bin/ln -sfn "$RELEASES/$VERSION.app/Contents/MacOS" "$PREFIX/current.next"
/bin/mv -h "$PREFIX/current.next" "$PREFIX/current"
/usr/bin/install -o root -g wheel -m 0400 "$BUNDLE/Contents/Resources/trust-policy.json" "$STATE/trust-policy.json"
/usr/bin/install -o root -g wheel -m 0444 "$BUNDLE/Contents/Resources/ai.pinet.superhuman-send-executor.plist" /Library/LaunchDaemons/ai.pinet.superhuman-send-executor.plist
echo "Installed atomically but not loaded. Credential provisioning and launch require separate approval." >&2
