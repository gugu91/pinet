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
SOURCE_VERSION=$(/usr/bin/codesign -d --verbose=4 "$BUNDLE" 2>&1 | /usr/bin/awk -F= '/^CDHash=/{print $2}')
[ -n "$SOURCE_VERSION" ] || { echo "missing source code directory hash" >&2; exit 1; }
/bin/launchctl print system/ai.pinet.superhuman-send-executor >/dev/null 2>&1 && { echo "service is loaded; refuse in-place replacement" >&2; exit 1; }
PREFIX=/usr/local/libexec/pinet-superhuman-send-executor
STATE=/var/db/pinet-superhuman-send-executor
RELEASES="$PREFIX/releases"
/usr/bin/install -d -o root -g wheel -m 0700 "$PREFIX" "$RELEASES" "$STATE"
STAGE_ROOT=$(/usr/bin/mktemp -d "$RELEASES/.stage.XXXXXX")
trap '/bin/rm -rf "$STAGE_ROOT"' EXIT HUP INT TERM
STAGE="$STAGE_ROOT/release.app"
/bin/cp -R "$BUNDLE" "$STAGE"
/usr/sbin/chown -R root:wheel "$STAGE"
/bin/chmod -R go-rwx "$STAGE"
/bin/chmod 0500 "$STAGE/Contents/MacOS/node" "$STAGE/Contents/MacOS/credential-bridge" "$STAGE/Contents/MacOS/shm"
/usr/bin/codesign --verify --deep --strict --requirement "$REQUIREMENT" "$STAGE"
/usr/bin/codesign --verify --strict --requirement "$REQUIREMENT" "$STAGE/Contents/MacOS/node"
/usr/bin/codesign --verify --strict --requirement "$REQUIREMENT" "$STAGE/Contents/MacOS/credential-bridge"
/usr/bin/codesign --verify --strict --requirement "$REQUIREMENT" "$STAGE/Contents/MacOS/shm"
/usr/bin/plutil -lint "$STAGE/Contents/Resources/trust-policy.json" >/dev/null
STAGED_VERSION=$(/usr/bin/codesign -d --verbose=4 "$STAGE" 2>&1 | /usr/bin/awk -F= '/^CDHash=/{print $2}')
[ "$STAGED_VERSION" = "$SOURCE_VERSION" ] || { echo "release changed while staging" >&2; exit 1; }
FINAL="$RELEASES/$STAGED_VERSION.app"
[ ! -e "$FINAL" ] || { echo "release already retained; refuse overwrite/downgrade ambiguity" >&2; exit 1; }
/bin/mv "$STAGE" "$FINAL"
/usr/bin/install -o root -g wheel -m 0400 "$FINAL/Contents/Resources/trust-policy.json" "$STATE/trust-policy.json"
/usr/bin/install -o root -g wheel -m 0444 "$FINAL/Contents/Resources/ai.pinet.superhuman-send-executor.plist" /Library/LaunchDaemons/ai.pinet.superhuman-send-executor.plist
/bin/ln -sfn "$FINAL/Contents/MacOS" "$PREFIX/current.next"
/bin/mv -h "$PREFIX/current.next" "$PREFIX/current"
trap - EXIT HUP INT TERM
/bin/rm -rf "$STAGE_ROOT"
echo "Installed atomically but not loaded. Credential provisioning and launch require separate approval." >&2
