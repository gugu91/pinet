# Slack approval receipt issuer (`shm-approval-receipt/v1`)

Tracking: [#920](https://github.com/gugu91/extensions/issues/920)

## Security boundary

`SlackApprovalIssuer` is an issuer protocol, not an executor and not a provider transport. It accepts only semantic `create`, `status`, and `cancel` operations and authorizes one configured Slack principal (`U0AF5S3LQ5C` in the Nexcade deployment). It deliberately exposes no `sign(bytes)` operation.

The broker process receives an `ApprovalSigner` capability whose only method is `issueApproval(ApprovalClaims)`. Production packaging **must** back that capability with a separately supervised signer process or hardware-backed service that:

1. owns the Ed25519 private key outside Pi/worker processes;
2. does not put the key in environment variables, files readable by Pi, command lines, IPC responses, crash reports, or descendant processes;
3. independently parses and validates `shm-approval-receipt/v1` claims before signing;
4. authenticates the broker issuer identity rather than trusting arbitrary local callers; and
5. exposes no generic signing operation.

Provider credentials belong only to the executor/provider process. The signer must not receive them. The broker and signer must not inherit provider credentials.

The executor must compile in (or load from a root-owned, non-caller-writable deployment resource) the exact Ed25519 SPKI public root and expected key ID. A public key supplied in a create request, environment variable controlled by a worker, or receipt is not trusted. The production root is intentionally not committed until the separately provisioned signer exists.

## Exact external-signer provisioning contract

The broker-side adapter must implement only this logical request/response contract over an administrator-owned authenticated IPC endpoint:

```text
request:  { operation: "issueApproval", claims: ApprovalClaims }
response: { keyId: string, signature: base64url(Ed25519(canonicalClaims)) }
```

The endpoint must reject every other operation, especially raw byte signing. Before signing it must parse the complete claims object, require version `shm-approval-receipt/v1`, require the configured Thomas Slack principal, require `expiresAt - issuedAt` in `(0, 300000]` milliseconds, and reject unknown/missing fields. It must authenticate the broker service identity using an administrator-owned OS credential or mutually authenticated local channel; filesystem location or loopback reachability alone is not authentication. The signer must return neither private material nor provider credentials.

The executor trust bundle must contain exactly `{ keyId, ed25519SpkiSha256, ed25519PublicKeyPem }`. Its artifact checksum must be recorded with the release. The installed bundle and every parent directory must be owned by the operator/root, non-writable by the Pi account, broker workers, signer service account, and provider executor caller. Receipt-supplied keys, caller parameters, worker environment variables, and writable configuration are never trust roots.

### Minimum later operator actions (not authorized by #920)

1. Create a dedicated non-login signer service identity that is not the Pi/worker or provider-executor identity.
2. Generate/import the Ed25519 key inside that identity's hardware-backed or non-exportable keystore; record only the public SPKI, its SHA-256 fingerprint, and key ID.
3. Install the signer service and authenticated IPC ACL so only the broker issuer identity can call `issueApproval`; prove Pi/workers and descendants cannot read the key or invoke the endpoint directly.
4. Install the public trust bundle into the executor artifact/location with operator ownership and no caller write permission; verify its checksum and ACLs independently.
5. Place provider credentials only in the executor identity's credential store; verify the signer and broker environments cannot access them, and the executor cannot access signer material.
6. Run the staging-only protocol and adversarial suite, attach ACL/process/environment evidence and exact artifact checksums, then obtain an independent exact-head security review.
7. Only under separate rollout authorization, install/reload the pinned artifacts. No step above authorizes a provider send.

## Receipt and audit

Receipts expire no later than five minutes after issuance and bind the account, Slack thread, draft ID and fingerprint, attestation, complete payload, complete recipient envelope, renderer build, screenshot digests, send ID, delay/schedule, action, and provider. Canonical claims are Ed25519-signed.

SQLite audit rows contain identifiers, timestamps, key ID, envelope digest, and signature digest. They never contain message bodies, rendered payloads, or recipients. Unique constraints on approval ID, send ID, and envelope digest provide durable replay exclusion under concurrent requests. `cancel` uses `BEGIN IMMEDIATE`.

Executor consumption is outside #920. It must atomically record first consumption before provider activity, verify the pinned root, reject mismatches/expiry/cancellation, and never treat issuer status alone as authorization.

## Install evidence checklist (not executed in #920)

Before install/reload:

- [ ] Build and package checks pass from the exact commit.
- [ ] Signer identity and pinned public root are provisioned by an administrator outside Pi.
- [ ] File/socket ACL inspection proves Pi/workers cannot read signer material or rewrite the trust root.
- [ ] Process-environment and descendant inspection proves signer/provider credential separation.
- [ ] A staging-only protocol test covers forged, replayed, mismatched, expired, wrong-user, and concurrent requests without sending a message.
- [ ] Exact-head independent GPT-5.6 security review is attached to the PR.
- [ ] Package checksum and installed artifact checksum match.

This issue does not authorize executing those deployment steps.

## Rollback

1. Disable the semantic approval endpoint at the broker boundary.
2. Stop the external signer endpoint; do not export its private key.
3. Restore the previous package artifact by recorded checksum.
4. Preserve the body-free audit database for incident analysis.
5. Revoke the signer identity and rotate the pinned root before any re-enable.
6. Confirm no receipt from the disabled key ID remains within its validity window (at most five minutes).

Rollback must not install an executor, invoke provider transport, or perform a synthetic/live send.
