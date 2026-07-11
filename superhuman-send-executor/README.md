# Credential-isolated Superhuman send executor

A separately deployed launchd daemon implementing only:

- `POST /v1/execute` with broker-core's exact `{ receipt: ApprovalReceipt }` wire object
- `GET /v1/status/:approvalId`

It is deliberately not a Pi extension, issuer, signer, general CLI, or arbitrary HTTP/command proxy. Issue: [#919](https://github.com/gugu91/extensions/issues/919); stacked contract dependency: issuer PR [#921](https://github.com/gugu91/extensions/pull/921).

## Boundary

The signed release is installed root-owned and code-signature verified. The Superhuman credential is an `ai.pinet.superhuman-send-executor` generic password in the **System Keychain**, with an ACL restricted to the signed native `credential-bridge`. The bridge calls Security.framework directly (never `/usr/bin/security`), requires effective UID 0, exposes only fixed render/send verbs, and passes the credential only to its root-only pinned `shm` child. Neither credentials nor URL/config/command overrides appear in the socket protocol. A Pi worker cannot execute the installed `0500` bridge, satisfy its root check, or read the Keychain item; raw `curl` and ordinary `shm` have no credential.

The root-owned trust policy pins the expected Slack principal, one or two Ed25519 issuer roots for bounded rotation, exact broker-core version, canonical approval-audit SQLite path, and caller group. Receipt parsing and canonical verification are imported from `@pinet/broker-core/approval-receipts`; the executor does not redefine v1.

## Atomic approval-to-send boundary

The provider rerenders the draft as a complete `ApprovalEnvelope`. Broker-core strictly verifies canonical unpadded-base64url Ed25519, five-minute lifetime, principal, root membership, and every envelope field—including payload, recipients, fingerprint, attestation, screenshots, schedule, action, and provider.

The executor and issuer use one SQLite WAL database. A single `BEGIN IMMEDIATE` transaction verifies the issued audit identity is active, atomically marks it consumed, and inserts the unique execution claim. The signed receipt hash is bound to the approval ID. Replays return the canonical execution row; ID/hash conflicts fail closed. Only the claim winner may invoke send.

The root-only adapter sends with the verified revision and `draftFingerprint`; its pinned contract must atomically enforce `--if-revision` plus `--expected-draft-fingerprint`. A definitive pre-POST precondition rejection becomes `failed`; any ambiguous invocation outcome becomes `unknown` and is never retried. On daemon restart, a surviving `claimed` row becomes `unknown`. This preserves at most one POST while honestly representing interrupted outcomes.

SQLite `audit_transitions` is the atomic body-free audit authority. JSONL is a repairable bounded mirror containing only approval ID/hash, state, timestamp, and bounded error code—never payload, recipients, subject, token, signature, or provider response.

## Signed release/install (not performed by this change)

1. Provide a reviewed Node binary and signed-compatible `shm` whose credential-free `executor-contract` reports `shm-executor/v1:conditional-revision+draft-fingerprint`.
2. Run `scripts/build-release.sh PINNED_NODE PINNED_SHM TRUST_POLICY SIGNING_IDENTITY OUTPUT.app`. It compiles/signs the native bridge **before** hashing it, embeds that signed hash, signs the remaining executables and enclosing app, and verifies the result.
3. Provision the System Keychain item separately, granting access only to the signed bridge. Never place the secret in shell history or files.
4. Run `sudo scripts/install.sh SIGNED_RELEASE.app`. It verifies the fixed root-owned designated requirement, stages and re-verifies after copy to close source-path races, atomically selects a retained code-directory-hash release, and intentionally does **not** load it.
5. Launch requires a separate approved `launchctl bootstrap` rollout.

Rollback requires bootout first, then `scripts/rollback.sh PREVIOUS_CODE_DIRECTORY_HASH`; it selects a retained signed release and preserves journal/audit/credential evidence.

## Checks

```sh
pnpm --filter @pinet/superhuman-send-executor lint
pnpm --filter @pinet/superhuman-send-executor typecheck
pnpm --filter @pinet/superhuman-send-executor test
pnpm --filter @pinet/broker-core test -- approval-receipts.compatibility.test.ts
```

The executor suite includes exact issuer JSON round-trip, forged/mutated/expired/wrong-principal/replay cases, independent-process SQLite races, interrupted-claim recovery, definitive versus ambiguous provider outcomes, strict parser checks, body-free audit schema, and native non-root bridge rejection. Credential-backed ACL/raw-bypass checks remain mandatory rollout gates because this PR deliberately provisions no credential and sends nothing.
