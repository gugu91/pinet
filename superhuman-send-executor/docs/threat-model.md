# Threat model

## Protected assets

Provider credentials, approved rendered content integrity, single-use approvals, truthful execution state, and body-free audit records.

## Adversaries

An unprivileged Pi/worker process able to call the Unix socket, run `curl`/`shm`, race or replay requests, alter request JSON, and crash the service. Root compromise and a malicious signed release are out of scope.

## Controls

- Ed25519 verification over canonical receipt and attestation bytes; pinned public root/key ID.
- Exact user and executor process-instance binding, finite receipt window, and five-minute attestation freshness.
- Service-only System Keychain ACL to a Security.framework native bridge; root-owned signed binaries/config/state, bridge EUID-0 check, `0500` mode, and fixed helper path/hash.
- Fixed Unix-socket execute/status surface; no URLs, executables, signer keys, credentials, or config accepted.
- Strict named parsers at request, policy, render, and send-result boundaries.
- Rerender and canonical SHA-256 comparison before durable claim; conditional send binds the provider operation to that revision and expected hash.
- One SQLite WAL journal is the sole claim/status authority. Unique receipt ID/hash and `BEGIN IMMEDIATE` serialize competing processes.
- Claim is durable before POST. No retry follows a claimed/unknown state.
- Audit schema cannot carry rendered fields.

## Residual risks

Superhuman does not provide a transactional coupling between local journal and remote delivery. A crash after POST but before response/commit is necessarily `unknown`; the service chooses no retry to preserve at-most-once POST. Availability depends on the pinned helper and provider contract. The release must pin a reviewed `shm` implementing atomic `--if-revision` plus `--expected-rendered-sha256`; release and synthetic contract tests must reject an adapter lacking either guarantee.

## Negative bypass proof

The native bridge is compiled in CI and a non-root invocation must fail with `root_required` before Keychain access. At rollout, the worker account's direct Security.framework/Keychain read must fail, executing the `0500` bridge must fail, ordinary `shm` must report no authentication, and raw `curl` must have no bearer/cookie material. Credential-backed checks require the separately approved provisioning/rollout phase; this PR neither provisions nor sends.
