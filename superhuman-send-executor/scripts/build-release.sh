#!/bin/sh
set -eu
NODE_BIN=${1:?usage: build-release.sh PINNED_NODE PINNED_SHM TRUST_POLICY OUTPUT.app}
SHM_BIN=${2:?usage: build-release.sh PINNED_NODE PINNED_SHM TRUST_POLICY OUTPUT.app}
TRUST_POLICY=${3:?usage: build-release.sh PINNED_NODE PINNED_SHM TRUST_POLICY OUTPUT.app}
OUT=${4:?usage: build-release.sh PINNED_NODE PINNED_SHM TRUST_POLICY OUTPUT.app}
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
MACOS="$OUT/Contents/MacOS"
RESOURCES="$OUT/Contents/Resources"
rm -rf "$OUT"
mkdir -p "$MACOS" "$RESOURCES"
(cd "$ROOT" && pnpm --filter @pinet/superhuman-send-executor build)
/usr/bin/swiftc -O -framework Security "$ROOT/superhuman-send-executor/native/CredentialBridge.swift" -o "$MACOS/credential-bridge"
/bin/cp "$NODE_BIN" "$MACOS/node"
/bin/cp "$SHM_BIN" "$MACOS/shm"
/bin/cp -R "$ROOT/superhuman-send-executor/dist" "$MACOS/dist"
BRIDGE_HASH=$(/usr/bin/shasum -a 256 "$MACOS/credential-bridge" | /usr/bin/awk '{print $1}')
/usr/bin/sed -i '' "s/REPLACE_DURING_SIGNED_RELEASE/$BRIDGE_HASH/g" "$MACOS/dist/src/keychain-provider.js"
/bin/cp "$TRUST_POLICY" "$RESOURCES/trust-policy.json"
/bin/cp "$ROOT/superhuman-send-executor/ai.pinet.superhuman-send-executor.plist" "$RESOURCES/"
/bin/cp "$ROOT/superhuman-send-executor/release/Info.plist" "$OUT/Contents/Info.plist"
/bin/chmod 0500 "$MACOS/node" "$MACOS/shm" "$MACOS/credential-bridge"
echo "Unsigned app assembled at $OUT. A maintainer must sign each executable and then the enclosing app with the pinned release identity." >&2
