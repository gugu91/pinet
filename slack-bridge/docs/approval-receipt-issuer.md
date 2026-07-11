# Slack approval receipt issuer (`shm-approval-receipt/v1`)

Tracking: [#920](https://github.com/gugu91/extensions/issues/920)

Deployment specifications: [external signer/runbook](external-approval-signer-runbook.md) and [issuer-to-executor compatibility gate](approval-receipt-compatibility.md). Both are explicitly non-production and unexecuted.

## Implemented library security boundary (not deployment status)

`SlackApprovalIssuer` is an issuer protocol, not an executor or provider transport. It exposes only semantic `create`, `status`, and `cancel` operations; there is no `sign(bytes)` operation. The library implementation and tests described here do not mean that a Slack route, signing secret, signer service, or trust root has been deployed.

`SlackV0ApprovalContextAuthenticator` is the concrete ingress implementation. It accepts the exact undecoded HTTP body bytes plus `X-Slack-Request-Timestamp` and `X-Slack-Signature`, verifies Slack `v0` HMAC-SHA256 over `v0:<timestamp>:<exact raw body>` with the configured Slack signing secret, and rejects requests more than five minutes old or future-dated by more than five minutes. Configured freshness may be shorter but is hard-capped at five minutes. The body must be a genuine form-encoded Slack `payload`: either `block_actions` with nested `user`, message `container`, and exactly one `button` action whose `action_id` is `pinet.approval.issue`, or `view_submission` with nested `user` and a modal `view` whose `callback_id` is `pinet.approval.issue`. The action `value` or view `private_metadata` must be the exact versioned binding object containing approval ID, Slack thread ID, and complete canonical-envelope digest. For block actions the bound thread must also equal the Slack thread timestamp resolved from `container.thread_ts`, `message.thread_ts`, or (for a root message) `container.message_ts`. The actor comes only from Slack's nested `user.id` and must be Thomas. Direct JSON/custom context objects, alternate interaction types, identifiers, shapes, or fallback principal inputs are rejected.

After verification, it commits digests of both the signed request identity and semantic context identity to SQLite in one `BEGIN IMMEDIATE` transaction. Both columns are unique, so an exact Slack retry and the same context re-signed at another timestamp are durably rejected, including across restarts and concurrent processes. The database stores neither raw request/message bodies nor the Slack signing secret. Operators must supply the correct signing-secret capability/config from their secret store and close the authenticator when its route shuts down.

Before any reservation or signer invocation, `SlackApprovalIssuer` validates and freezes the caller envelope, computes its canonical digest, consumes the signed Slack request, and compares every trusted binding: hard-coded Thomas principal, approval ID, thread ID, and complete envelope digest. Any approval-ID or envelope-field substitution therefore fails before signing. `status` and `cancel` also require a fresh signed, bound Slack request and compare its approval ID and stored complete envelope digest.

The broker receives an `ApprovalSigner` capability with a fixed `keyId` and one method, `issueApproval(ApprovalClaims)`, plus a separately configured `PinnedApprovalSignatureVerifier` for that exact key ID and the explicit `Ed25519` algorithm. The key ID is included in the claims before signing. Production packaging **must** back that capability with a separately supervised signer process or hardware-backed service that:

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
request:               { operation: "issueApproval", operationId: UUID, claims: ApprovalClaims }
response:              { algorithm: "Ed25519", keyId: configuredKeyId,
                         signature: strict-unpadded-base64url(Ed25519(canonicalClaims)) }
```

The endpoint rejects every other operation, especially raw byte signing. It parses the complete claims object; rejects unknown or missing fields; requires the configured key ID, version, principal, and a lifetime in `(0, 300000]` milliseconds; and authenticates the broker service using an administrator-owned OS credential or mutually authenticated channel. Its response has exactly the three fields above. The signature is unpadded RFC 4648 base64url, decodes to exactly 64 bytes, and has canonical trailing bits. It must durably single-flight and cache the complete result by `operationId`, rejecting reuse with different claims. Broker abort/disconnect must cancel work when possible; a retry with the same operation ID must join or return the same result, never start a second signing operation. Filesystem location or loopback reachability alone is not authentication.

Before durable finalization, issuer code rejects a signer response unless its shape is exact, algorithm is `Ed25519`, key ID equals both the configured signer and pinned verifier, signature encoding is strict/canonical unpadded base64url, decoded signature length is exactly 64 bytes, and cryptographic verification of the canonical claims succeeds against the pinned public-key verifier. Any malformed or wrong response is an ambiguous outcome: no issued row or consumption is possible, and the pending reservation and operation ID remain for reconciliation.

Executor code uses `ApprovalReceiptVerifier`, constructed with a fixed expected principal, `ApprovalAuditStore`, and the same kind of `PinnedApprovalSignatureVerifier`. No verification method accepts a caller public key or key ID. For bounded root rotation, `PinnedApprovalVerifierSet` is an immutable deployment-pinned registry and `RotatingApprovalReceiptVerifier` selects only among its preconfigured roots; a receipt cannot supply a root. Removing a key ID from the set is immediate revocation. The deployment trust object must pin the configured key IDs, explicit `Ed25519` algorithm, and public roots from an operator-owned, non-caller-writable resource. The repository provides no production key and no fallback verifier. Exact overlap, drain, emergency revocation, monotonic manifest generation, and rollback procedures are in the external signer runbook.

Synthetic generated keys appear only in `.test.ts` regression/compatibility files that are excluded from broker-core build output and package exports. The compatibility harness has no environment/config switch, key loader, network, provider, or send capability, so it cannot be enabled as a production signer fallback.

## Receipt semantics

Claims bind all of the following:

- receipt version, key ID, approval ID, authenticated principal, issue time, and expiry;
- account, authenticated Slack thread, draft ID, lowercase-hex SHA-256 draft fingerprint and attestation, and complete payload;
- full ordered `To`, `Cc`, and `Bcc` recipient lists;
- renderer build and at least one lowercase-hex SHA-256 screenshot digest;
- send ID, delay, schedule, action, and provider.

Canonical JSON recursively sorts object keys by locale-independent UTF-16 code-unit order and uses JSON string/number encoding. Issuer inputs are copied into recursively frozen arrays and objects before the signer is called, so caller mutation cannot change signed, returned, or audited values.

Only after the request-bound ingress context has been consumed and all bindings match, `ApprovalAuditStore.reserveOrRecover` commits a SQLite `BEGIN IMMEDIATE` reservation with unique constraints for approval ID, send ID, draft ID, draft fingerprint, and complete envelope digest. Concurrent fresh collisions therefore make one signer call. Each pending row has a lease token and expiry. The issuer releases a reservation only when the signer throws `ApprovalSignerPreSignRejection` for the exact operation ID, which is the signer's explicit assertion that it rejected before any signing work or durable result. Transport failures, disconnects, malformed responses, timeouts, aborts, finalization failures, mismatched rejection operation IDs, and every other ambiguous outcome retain the reservation and its operation identity.

Signer calls have a 15-second default timeout and receive an abort signal plus a durable `operationId`. The caller fails closed at timeout, while the already-started signer continuation remains fenced if an abort-ignoring signer eventually returns. After the 30-second default lease expires, an exactly identity-matching request (including principal, all unique identities, envelope digest, key ID, and TTL) may take a new fenced lease while retaining the original operation ID and exact claims timestamps. This is fail-closed reconciliation: the external signer must durably single-flight by operation ID and join or return the prior outcome rather than start a second cryptographic operation. A stale continuation cannot finalize after takeover because finalization requires the current lease token; its failure cleanup also cannot delete the successor lease. This remains true when the old signer ignores abort and completes late, including after the successor has durably finalized. An expired stale claim is deleted before a new operation is reserved, so a late signature for it is unusable. Every retry requires a newly signed, one-time Slack request.

`ApprovalReceiptVerifier.verifyAndConsume` checks the exact receipt shape, version, pinned key ID and signature, fixed expected principal, canonical issue/expiry times, non-future issuance, five-minute maximum lifetime, and exact equality for the expected approval and every envelope field. It then checks the issued audit reservation, cancellation, expiry, and replay state and records consumption in one `BEGIN IMMEDIATE` transaction before returning. Cancellation and consumption serialize against each other. A successful receipt is usable once only.

SQLite audit rows contain identifiers, timestamps, key ID, envelope digest, signature digest, reservation state, cancellation, and consumption state. They never contain message bodies, rendered payloads, or recipients. `ApprovalAuditStore.health()` runs SQLite `quick_check` and exposes only checked time and aggregate pending/stale/active/cancelled/expired/consumed counts. The body-free log/metric allowlist and readiness alerts are defined in the external signer runbook.

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
- [ ] The deployed Slack route passes exact undecoded bytes and unmodified Slack headers to `SlackV0ApprovalContextAuthenticator`; its configured signing secret is verified against the intended Slack app.
- [ ] Signer identity and pinned public root are provisioned by an administrator outside Pi.
- [ ] File/socket ACL inspection proves Pi/workers cannot read signer material or rewrite the trust root.
- [ ] Process-environment inspection proves signer/provider credential separation.
- [ ] Staging tests cover genuine `block_actions` and `view_submission` forms, rejected custom/wrong-identifier payloads, forged/modified/stale Slack requests, wrong user, request/context replay, altered key ID, every envelope mismatch, expiry, cancellation, ambiguous signer failures, malformed/non-canonical/wrong-length signer signatures, wrong signer algorithm/key ID/signature, hung signer timeout, abort-ignoring stale lease takeover with a late fenced finalization, and concurrent issue/consume without a send.
- [ ] Exact-head independent security review is attached to the PR.
- [ ] Package and installed artifact checksums match.

## Rollback

1. Disable the semantic approval endpoint at the broker boundary.
2. Stop the external signer endpoint without exporting its private key.
3. Restore the previous package artifact by recorded checksum.
4. Preserve the body-free audit database for incident analysis.
5. Revoke the signer identity and rotate the pinned root before re-enable.
6. Confirm no receipt from the disabled key remains within its validity window (at most five minutes).

For ordinary rollback, retain uncompromised old/new roots through the bounded TTL/skew/propagation drain and use a monotonically higher manifest generation. For suspected compromise, disable issuance/execution and remove the affected root immediately with no overlap. See the external signer runbook for the exact decision procedure.

Rollback must not install an executor, invoke provider transport, or perform a synthetic/live send.
