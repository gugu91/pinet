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
