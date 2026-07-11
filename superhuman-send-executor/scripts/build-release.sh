#!/bin/sh
set -eu
NODE_BIN=${1:?usage: build-release.sh PINNED_NODE PINNED_SHM TRUST_POLICY SIGNING_IDENTITY OUTPUT.app}
SHM_BIN=${2:?usage: build-release.sh PINNED_NODE PINNED_SHM TRUST_POLICY SIGNING_IDENTITY OUTPUT.app}
TRUST_POLICY=${3:?usage: build-release.sh PINNED_NODE PINNED_SHM TRUST_POLICY SIGNING_IDENTITY OUTPUT.app}
SIGNING_IDENTITY=${4:?usage: build-release.sh PINNED_NODE PINNED_SHM TRUST_POLICY SIGNING_IDENTITY OUTPUT.app}
OUT=${5:?usage: build-release.sh PINNED_NODE PINNED_SHM TRUST_POLICY SIGNING_IDENTITY OUTPUT.app}
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
MACOS="$OUT/Contents/MacOS"
RESOURCES="$OUT/Contents/Resources"
CONTRACT=$($SHM_BIN executor-contract)
[ "$CONTRACT" = "shm-executor/v1:conditional-revision+draft-fingerprint" ] || {
  echo "pinned shm lacks the required atomic executor contract" >&2
  exit 1
}
rm -rf "$OUT"
mkdir -p "$MACOS" "$RESOURCES"
(cd "$ROOT" && pnpm --filter @pinet/superhuman-send-executor build)
/usr/bin/swiftc -O -framework Security "$ROOT/superhuman-send-executor/native/CredentialBridge.swift" -o "$MACOS/credential-bridge"
/bin/cp "$NODE_BIN" "$MACOS/node"
/bin/cp "$SHM_BIN" "$MACOS/shm"
/usr/bin/codesign --force --options runtime --sign "$SIGNING_IDENTITY" "$MACOS/credential-bridge"
/usr/bin/codesign --force --options runtime --sign "$SIGNING_IDENTITY" "$MACOS/node"
/usr/bin/codesign --force --options runtime --sign "$SIGNING_IDENTITY" "$MACOS/shm"
BRIDGE_HASH=$(/usr/bin/shasum -a 256 "$MACOS/credential-bridge" | /usr/bin/awk '{print $1}')
/bin/cp -R "$ROOT/superhuman-send-executor/dist" "$MACOS/dist"
/usr/bin/sed -i '' "s/REPLACE_DURING_SIGNED_RELEASE/$BRIDGE_HASH/g" "$MACOS/dist/src/keychain-provider.js"
/bin/cp "$TRUST_POLICY" "$RESOURCES/trust-policy.json"
/bin/cp "$ROOT/superhuman-send-executor/ai.pinet.superhuman-send-executor.plist" "$RESOURCES/"
/bin/cp "$ROOT/superhuman-send-executor/release/Info.plist" "$OUT/Contents/Info.plist"
/bin/chmod 0500 "$MACOS/node" "$MACOS/shm" "$MACOS/credential-bridge"
/usr/bin/codesign --force --deep --options runtime --sign "$SIGNING_IDENTITY" "$OUT"
/usr/bin/codesign --verify --deep --strict "$OUT"
echo "Signed, self-consistent release assembled at $OUT. Installation and launch remain separate approvals." >&2
