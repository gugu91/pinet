# Threat model

## Protected assets

Provider credentials, exact approved envelope integrity, single-use approvals, at-most-one provider POST, truthful execution state, and body-free audit records.

## Adversary

An unprivileged Pi/worker able to call the group-owned Unix socket, run `curl`/`shm`, race/replay/mutate JSON, and crash the daemon. Root compromise, malicious pinned signing identity, and a malicious reviewed provider adapter are out of scope.

## Controls

- Exact broker-core `shm-approval-receipt/v1` parser/canonical claims; strict unpadded-base64url Ed25519.
- Deployment-pinned one/two-root verifier set, expected principal, canonical ISO instants, and maximum five-minute receipt lifetime.
- Complete rerender equality across every signed `ApprovalEnvelope` field; no reduced executor-specific receipt.
- One issuer/executor SQLite WAL journal. One `BEGIN IMMEDIATE` transaction consumes the exact active issuer reservation and inserts the execution claim.
- Unique approval ID/hash and durable claim before provider invocation; replay never invokes again.
- Revision plus approved draft fingerprint passed to the signed provider adapter for atomic conditional send.
- Typed definitive pre-POST failure versus ambiguous outcome; ambiguous and interrupted claims are never retried.
- Security.framework native credential bridge, EUID-0 check, root-owned `0500` mode, signed-hash pin, and fixed verbs/paths.
- Fixed execute/status socket API; no URLs, executable, signer key, credential, or config accepted.
- Strict named parsers at request, policy, render, and send-result boundaries; bounded body and field sizes.
- Atomic SQLite body-free transitions; bounded JSONL mirror; generic external errors and request timeouts.
- Signed app release with pinned designated requirement, post-copy verification, atomic version pointer, retained signed rollback.

## Residual risks

No local transaction can couple SQLite to remote provider delivery. A crash after POST but before durable confirmation is necessarily `unknown`; no retry preserves at-most-one POST. Availability and TOCTOU integrity depend on the reviewed pinned `shm` honoring its declared atomic revision/fingerprint contract. Release review and credential-free adapter contract testing are therefore authority gates.

## Negative bypass proof

CI compiles the native bridge and proves a non-root invocation fails with `root_required` before Keychain access. At rollout, the worker's direct Keychain read and execution of the installed `0500` bridge must fail; ordinary `shm` and raw `curl` must have no authentication; and the installed app must satisfy the root-pinned signing requirement. Credential-backed checks cannot be performed in this no-provision/no-send PR and remain explicit rollout blockers.
