# Slack approval receipt issuer (`shm-approval-receipt/v1`)

Tracking: [#920](https://github.com/gugu91/extensions/issues/920)

## Implemented security boundary

`SlackApprovalIssuer` is an issuer protocol, not an executor or provider transport. It exposes only semantic `create`, `status`, and `cancel` operations; there is no `sign(bytes)` operation.

A create call contains no principal field. It must carry a `SlackBrokerApprovalContext` containing only an opaque handle. At authenticated Slack/broker ingress, a deployment adapter must mint that unforgeable handle against a server-side record containing the authenticated principal, exact approval ID, exact Slack thread ID, and digest of the complete canonical envelope. `SlackApprovalContextAuthenticator.authenticateAndConsume` must retrieve and delete that record in one atomic operation; a missing or previously consumed handle fails authentication. Copying a Slack user ID or accepting caller-provided bindings is not authentication.

Before any reservation or signer invocation, `SlackApprovalIssuer` validates and freezes the caller envelope, computes its canonical digest, atomically consumes the handle, and compares every trusted binding: fixed authorized principal, approval ID, thread ID, and complete envelope digest. Any approval-ID or envelope-field substitution therefore fails before signing, and the consumed handle cannot be replayed or detached for a later request. `status` and `cancel` also consume a fresh bound handle and compare its approval ID and stored complete envelope digest.

The broker receives an `ApprovalSigner` capability with a fixed `keyId` and one method, `issueApproval(ApprovalClaims)`. The key ID is included in the claims before signing. Production packaging **must** back that capability with a separately supervised signer process or hardware-backed service that:

1. owns the Ed25519 private key outside Pi/worker processes;
2. does not put the key in environment variables, files readable by Pi, command lines, IPC responses, crash reports, or descendant processes;
3. independently parses and validates the exact `shm-approval-receipt/v1` claims before signing;
4. authenticates the broker issuer identity rather than trusting arbitrary local callers; and
5. exposes no generic signing operation or production key fallback.

Provider credentials belong only to the executor/provider process. The signer must not receive them, and the broker and signer must not inherit them.

## External signer and pinned verifier contracts

The broker-side adapter implements only this logical request/response contract over an administrator-owned authenticated IPC endpoint:

```text
configured capability: { keyId: string }
request:               { operation: "issueApproval", claims: ApprovalClaims }
response:              { signature: base64url(Ed25519(canonicalClaims)) }
```

The endpoint rejects every other operation, especially raw byte signing. It parses the complete claims object; rejects unknown or missing fields; requires the configured key ID, version, principal, and a lifetime in `(0, 300000]` milliseconds; and authenticates the broker service using an administrator-owned OS credential or mutually authenticated channel. Filesystem location or loopback reachability alone is not authentication.

Executor code uses `ApprovalReceiptVerifier`, constructed with a fixed expected principal, `ApprovalAuditStore`, and a `PinnedApprovalSignatureVerifier`. No verification method accepts a caller public key or key ID. The deployment trust object must pin exactly the configured key ID and Ed25519 public root from an operator-owned, non-caller-writable resource. The repository provides no production key and no fallback verifier.

Synthetic generated keys appear only in the isolated broker-core regression test and are marked non-production.

## Receipt semantics

Claims bind all of the following:

- receipt version, key ID, approval ID, authenticated principal, issue time, and expiry;
- account, authenticated Slack thread, draft ID, lowercase-hex SHA-256 draft fingerprint and attestation, and complete payload;
- full ordered `To`, `Cc`, and `Bcc` recipient lists;
- renderer build and at least one lowercase-hex SHA-256 screenshot digest;
- send ID, delay, schedule, action, and provider.

Canonical JSON recursively sorts object keys by locale-independent UTF-16 code-unit order and uses JSON string/number encoding. Issuer inputs are copied into recursively frozen arrays and objects before the signer is called, so caller mutation cannot change signed, returned, or audited values.

Only after the request-bound ingress context has been consumed and all of its bindings match, `ApprovalAuditStore.reserve` commits a SQLite `BEGIN IMMEDIATE` reservation with unique constraints for approval ID, send ID, draft ID, draft fingerprint, and complete envelope digest. Concurrent collisions therefore make exactly one signer call. A signer failure removes only the matching still-pending reservation token; finalized records cannot be removed by failure cleanup. Because ingress authorization is one-time, a retry after signer failure requires a newly authenticated handle for the same exact request.

`ApprovalReceiptVerifier.verifyAndConsume` checks the exact receipt shape, version, pinned key ID and signature, fixed expected principal, canonical issue/expiry times, non-future issuance, five-minute maximum lifetime, and exact equality for the expected approval and every envelope field. It then checks the issued audit reservation, cancellation, expiry, and replay state and records consumption in one `BEGIN IMMEDIATE` transaction before returning. Cancellation and consumption serialize against each other. A successful receipt is usable once only.

SQLite audit rows contain identifiers, timestamps, key ID, envelope digest, signature digest, reservation state, cancellation, and consumption state. They never contain message bodies, rendered payloads, or recipients.

## Deployment actions not authorized by #920

1. Create a dedicated non-login signer service identity separate from Pi/workers and the provider executor.
2. Generate or import the Ed25519 key in that identity's hardware-backed or non-exportable keystore; record only its public SPKI fingerprint and key ID.
3. Install authenticated IPC ACLs so only the broker issuer identity can call `issueApproval`; prove Pi/workers and descendants cannot read the key or invoke the endpoint directly.
4. Install the pinned verifier resource with operator ownership and no caller write permission; record its artifact checksum.
5. Put provider credentials only in the executor identity's credential store and prove credential separation.
6. Run the staging-only protocol/adversarial suite and obtain an independent exact-head security review.
7. Only with separate rollout authorization, install or reload pinned artifacts. Nothing here authorizes a provider send.

## Install evidence checklist (not executed in #920)

- [ ] Exact-commit build, lint, typecheck, and tests pass.
- [ ] Slack/broker context authenticator validates real ingress provenance, atomically consumes each handle once, and returns only its server-side principal, approval ID, thread ID, and complete canonical-envelope digest bindings.
- [ ] Signer identity and pinned public root are provisioned by an administrator outside Pi.
- [ ] File/socket ACL inspection proves Pi/workers cannot read signer material or rewrite the trust root.
- [ ] Process-environment inspection proves signer/provider credential separation.
- [ ] Staging tests cover altered key ID, wrong version/principal, every envelope mismatch, expiry, cancellation, replay, failed reservation cleanup, and concurrent issue/consume without a send.
- [ ] Exact-head independent security review is attached to the PR.
- [ ] Package and installed artifact checksums match.

## Rollback

1. Disable the semantic approval endpoint at the broker boundary.
2. Stop the external signer endpoint without exporting its private key.
3. Restore the previous package artifact by recorded checksum.
4. Preserve the body-free audit database for incident analysis.
5. Revoke the signer identity and rotate the pinned root before re-enable.
6. Confirm no receipt from the disabled key remains within its validity window (at most five minutes).

Rollback must not install an executor, invoke provider transport, or perform a synthetic/live send.
