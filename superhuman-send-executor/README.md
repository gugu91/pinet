# Credential-isolated Superhuman send executor

A separately deployed launchd daemon implementing only:

- `POST /v1/execute` with a `shm-approval-receipt/v1` plus process attestation
- `GET /v1/status/:receiptId`

It is deliberately not a Pi extension, issuer, signer, general CLI, or arbitrary HTTP/command proxy. Issue: [#919](https://github.com/gugu91/extensions/issues/919).

## Boundary

The signed release is installed root-owned and code-signature verified. The Superhuman credential is a `ai.pinet.superhuman-send-executor` generic password in the **System Keychain**, with an ACL restricted to the signed executor's pinned `shm` helper. Neither the credential nor a URL/config override appears in the socket protocol. A Pi worker running without privilege cannot read the System Keychain item; invoking `curl` or an ordinary `shm` process therefore has no credential. The production helper path and SHA-256 are compiled in. Release packaging must replace the sentinel hash and sign both executables; the daemon refuses to operate otherwise.

The trust policy is root-owned at `/var/db/pinet-superhuman-send-executor/trust-policy.json`. It pins issuer key ID/public root, user ID, executor process-instance ID, and broker-core `0.2.4` contract compatibility. No request field can override these values.

## Exactly-once boundary

After independent signature/attestation verification and fresh rerender/hash comparison, `BEGIN IMMEDIATE` inserts the unique receipt claim and fsyncs SQLite WAL before provider invocation. Only the process that inserted the claim may POST. Replays return the canonical journal row. On an exception after invocation, status is `unknown` and is never retried. A startup finding `claimed` converts it to `unknown`; this preserves **at most one POST**, while honestly acknowledging that an interrupted provider response cannot prove delivery. A later explicit provider reconciliation feature may resolve unknown, but must never retry it.

Audit JSONL contains receipt ID/hash, state, timestamp, and bounded error code—never recipients, subject, body, token, or provider response.

## Release/install (not performed by this change)

1. Build and package the daemon and a reviewed compatible `shm` binary.
2. Replace `REPLACE_DURING_SIGNED_RELEASE` with the helper SHA-256.
3. Code-sign both artifacts and prepare the root-owned trust policy.
4. An administrator creates the System Keychain generic password with service `ai.pinet.superhuman-send-executor`, account `root`, granting access only to the signed helper. Do not place the secret in shell history or files.
5. Run `sudo scripts/install.sh SIGNED_RELEASE_DIRECTORY`. Installation intentionally does **not** load the daemon.
6. Review ownership/signatures and explicitly `launchctl bootstrap system ...` in a separately approved rollout.

Rollback requires bootout first, then `scripts/rollback.sh`; it intentionally retains the journal/audit/credential for investigation and safe forward recovery.

## Tests

`pnpm --filter @pinet/superhuman-send-executor lint && pnpm --filter @pinet/superhuman-send-executor typecheck && pnpm --filter @pinet/superhuman-send-executor test`
