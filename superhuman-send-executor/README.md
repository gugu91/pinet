# Credential-isolated Superhuman send executor

A separately deployed launchd daemon implementing only:

- `POST /v1/execute` with a `shm-approval-receipt/v1` plus process attestation
- `GET /v1/status/:receiptId`

It is deliberately not a Pi extension, issuer, signer, general CLI, or arbitrary HTTP/command proxy. Issue: [#919](https://github.com/gugu91/extensions/issues/919).

## Boundary

The signed release is installed root-owned and code-signature verified. The Superhuman credential is an `ai.pinet.superhuman-send-executor` generic password in the **System Keychain**, with an ACL restricted to the signed native `credential-bridge`. The bridge calls Security.framework directly (never `/usr/bin/security`), requires effective UID 0, exposes only fixed render/send verbs, and passes the credential only to its root-only pinned `shm` child. Neither the credential nor a URL/config override appears in the socket protocol. A Pi worker cannot execute the `0500` bridge, satisfy its root check, or read the Keychain item; raw `curl` and ordinary `shm` therefore have no credential. The production bridge path and SHA-256 are compiled in. Release assembly replaces the fail-closed sentinel hash before the enclosing app and executables are signed.

The trust policy is root-owned at `/var/db/pinet-superhuman-send-executor/trust-policy.json`. It pins issuer key ID/public root, user ID, executor process-instance ID, and broker-core `0.2.4` contract compatibility. No request field can override these values.

## Exactly-once boundary

After strict parsing, independent signature/attestation verification, and fresh rerender/hash comparison, `BEGIN IMMEDIATE` inserts the unique receipt ID/hash claim and fsyncs SQLite WAL before provider invocation. Only the process that inserted the claim may POST. The send helper receives the verified revision ID and expected rendered hash; the pinned provider adapter must enforce both atomically (`--if-revision` and `--expected-rendered-sha256`), closing the render/send mutation window. Replays return the canonical journal row. On an exception after invocation, status is `unknown` and is never retried. A startup finding `claimed` converts it to `unknown`; this preserves **at most one POST**, while honestly acknowledging that an interrupted provider response cannot prove delivery. A later explicit provider reconciliation feature may resolve unknown, but must never retry it.

Audit JSONL contains receipt ID/hash, state, timestamp, and bounded error code—never recipients, subject, body, token, or provider response.

## Release/install (not performed by this change)

1. Use `scripts/build-release.sh PINNED_NODE PINNED_SHM TRUST_POLICY OUTPUT.app`; its reviewed `shm` must support conditional revision/hash send.
2. Code-sign Node, `shm`, and `credential-bridge`, then the enclosing app with the identity pinned by root-owned `/etc/pinet/superhuman-executor-release-requirement`.
3. An administrator creates the System Keychain generic password with service `ai.pinet.superhuman-send-executor`, account `root`, granting access only to the signed bridge. Do not place the secret in shell history or files.
4. Run `sudo scripts/install.sh SIGNED_RELEASE.app`. It verifies the pinned designated requirement, refuses replacement while loaded, and atomically selects a retained code-directory-hash release. It intentionally does **not** load the daemon.
5. Review ownership/signatures and explicitly `launchctl bootstrap system ...` in a separately approved rollout.

Rollback requires bootout first, then `scripts/rollback.sh PREVIOUS_CODE_DIRECTORY_HASH`; it atomically selects a retained signed release and preserves journal/audit/credential evidence.

## Tests

`pnpm --filter @pinet/superhuman-send-executor lint && pnpm --filter @pinet/superhuman-send-executor typecheck && pnpm --filter @pinet/superhuman-send-executor test`
