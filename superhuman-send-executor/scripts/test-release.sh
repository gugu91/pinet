#!/bin/sh
set -eu
if [ "$(uname -s)" != "Darwin" ]; then
  echo "Skipping macOS signed-release test on $(uname -s)."
  exit 0
fi
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
TMP=$(/usr/bin/mktemp -d)
trap '/bin/rm -rf "$TMP"' EXIT HUP INT TERM
cat >"$TMP/fake-shm.c" <<'EOF'
#include <stdio.h>
#include <string.h>
int main(int argc,char**argv){
  if(argc==2&&!strcmp(argv[1],"executor-contract")){
    puts("shm-executor/v1:render-envelope-json;send-conditional-revision+draft-fingerprint;exit10=definitive-pre-post");
    return 0;
  }
  return 64;
}
EOF
/usr/bin/clang "$TMP/fake-shm.c" -o "$TMP/shm"
cat >"$TMP/portable-node.c" <<EOF
#include <unistd.h>
#include <stdlib.h>
int main(int argc,char**argv){
  char **forwarded=calloc((size_t)argc+1,sizeof(char*));
  forwarded[0]="node";
  for(int i=1;i<argc;i++)forwarded[i]=argv[i];
  execv("$(command -v node)",forwarded);
  return 127;
}
EOF
/usr/bin/clang "$TMP/portable-node.c" -o "$TMP/node"
cat >"$TMP/trust.json" <<'EOF'
{"expectedPrincipal":"U0AF5S3LQ5C","brokerCoreVersion":"0.2.4","callerGid":20,"approvalAuditPath":"/var/db/pinet/approval.sqlite","pinnedIssuerKeys":[{"keyId":"test","publicKeyPem":"test"}]}
EOF
if "$ROOT/superhuman-send-executor/scripts/build-release.sh" "$TMP/node" "$TMP/shm" "$TMP/trust.json" - "$TMP/Executor.app" 2>"$TMP/build.err"; then
  echo "release unexpectedly accepted unpinned Node/shm inputs" >&2
  exit 1
fi
/usr/bin/grep -q "reviewed release input hashes are not pinned at exact HEAD" "$TMP/build.err"
