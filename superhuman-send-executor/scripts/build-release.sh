#!/bin/sh
set -eu
NODE_BIN=${1:?usage: build-release.sh PINNED_NODE PINNED_SHM TRUST_POLICY SIGNING_IDENTITY OUTPUT.app}
SHM_BIN=${2:?usage: build-release.sh PINNED_NODE PINNED_SHM TRUST_POLICY SIGNING_IDENTITY OUTPUT.app}
TRUST_POLICY=${3:?usage: build-release.sh PINNED_NODE PINNED_SHM TRUST_POLICY SIGNING_IDENTITY OUTPUT.app}
SIGNING_IDENTITY=${4:?usage: build-release.sh PINNED_NODE PINNED_SHM TRUST_POLICY SIGNING_IDENTITY OUTPUT.app}
FINAL_OUT=${5:?usage: build-release.sh PINNED_NODE PINNED_SHM TRUST_POLICY SIGNING_IDENTITY OUTPUT.app}
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
PRIVATE_STAGE=$(/usr/bin/mktemp -d)
/bin/chmod 0700 "$PRIVATE_STAGE"
trap '/bin/rm -rf "$PRIVATE_STAGE"' EXIT HUP INT TERM
/bin/cp "$NODE_BIN" "$PRIVATE_STAGE/node"
/bin/cp "$SHM_BIN" "$PRIVATE_STAGE/shm"
/bin/cp "$TRUST_POLICY" "$PRIVATE_STAGE/trust-policy.json"
NODE_BIN="$PRIVATE_STAGE/node"
SHM_BIN="$PRIVATE_STAGE/shm"
TRUST_POLICY="$PRIVATE_STAGE/trust-policy.json"
OUT="$PRIVATE_STAGE/Executor.app"
MACOS="$OUT/Contents/MacOS"
RESOURCES="$OUT/Contents/Resources"
if /usr/bin/otool -L "$NODE_BIN" | /usr/bin/tail -n +2 | /usr/bin/grep -Ev '^[[:space:]]+(/usr/lib/|/System/Library/)' >/dev/null; then
  echo "pinned Node is not a self-contained macOS runtime" >&2
  exit 1
fi
CONTRACT=$($SHM_BIN executor-contract)
[ "$CONTRACT" = "shm-executor/v1:render-envelope-json;send-conditional-revision+draft-fingerprint;exit10=definitive-pre-post" ] || {
  echo "pinned shm lacks the required atomic executor contract" >&2
  exit 1
}
mkdir -p "$MACOS" "$RESOURCES"
(cd "$ROOT" && pnpm --filter @pinet/broker-core build && pnpm --filter @pinet/superhuman-send-executor build)
/usr/bin/swiftc -O -framework Security "$ROOT/superhuman-send-executor/native/CredentialBridge.swift" -o "$MACOS/credential-bridge"
/bin/cp "$NODE_BIN" "$MACOS/node"
/bin/cp "$SHM_BIN" "$MACOS/shm"
/usr/bin/codesign --force --options runtime --sign "$SIGNING_IDENTITY" "$MACOS/credential-bridge"
/usr/bin/codesign --force --options runtime --sign "$SIGNING_IDENTITY" "$MACOS/node"
/usr/bin/codesign --force --options runtime --sign "$SIGNING_IDENTITY" "$MACOS/shm"
BRIDGE_HASH=$(/usr/bin/shasum -a 256 "$MACOS/credential-bridge" | /usr/bin/awk '{print $1}')
/bin/cp -R "$ROOT/superhuman-send-executor/dist" "$MACOS/dist"
/usr/bin/install -d "$MACOS/node_modules/@pinet/broker-core"
/bin/cp -R "$ROOT/broker-core/dist" "$MACOS/node_modules/@pinet/broker-core/dist"
/bin/cp "$ROOT/broker-core/package.json" "$MACOS/node_modules/@pinet/broker-core/package.json"
/usr/bin/sed -i '' "s/REPLACE_DURING_SIGNED_RELEASE/$BRIDGE_HASH/g" "$MACOS/dist/src/keychain-provider.js"
/bin/cp "$TRUST_POLICY" "$RESOURCES/trust-policy.json"
/bin/cp "$ROOT/superhuman-send-executor/ai.pinet.superhuman-send-executor.plist" "$RESOURCES/"
/bin/cp "$ROOT/superhuman-send-executor/release/Info.plist" "$OUT/Contents/Info.plist"
/bin/chmod 0500 "$MACOS/node" "$MACOS/shm" "$MACOS/credential-bridge"
(
  cd "$MACOS"
  "$MACOS/node" --input-type=module -e 'await import("./dist/src/executor.js"); await import("@pinet/broker-core/approval-receipts")'
)
/usr/bin/codesign --force --deep --options runtime --sign "$SIGNING_IDENTITY" "$OUT"
/usr/bin/codesign --verify --deep --strict "$OUT"
/bin/rm -rf "$FINAL_OUT"
/bin/mv "$OUT" "$FINAL_OUT"
trap - EXIT HUP INT TERM
/bin/rm -rf "$PRIVATE_STAGE"
echo "Signed, self-consistent release assembled at $FINAL_OUT. Installation and launch remain separate approvals." >&2
