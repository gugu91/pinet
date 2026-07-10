# Threat model

## Protected assets

Provider credentials, approved rendered content integrity, single-use approvals, truthful execution state, and body-free audit records.

## Adversaries

An unprivileged Pi/worker process able to call the Unix socket, run `curl`/`shm`, race or replay requests, alter request JSON, and crash the service. Root compromise and a malicious signed release are out of scope.

## Controls

- Ed25519 verification over canonical receipt and attestation bytes; pinned public root/key ID.
- Exact user and executor process-instance binding plus receipt expiry.
- Service-only System Keychain ACL, root-owned signed binaries/config/state, fixed helper path/hash.
- Fixed Unix-socket execute/status surface; no URLs, executables, signer keys, credentials, or config accepted.
- Rerender and canonical SHA-256 comparison before durable claim.
- One SQLite WAL journal is the sole claim/status authority. Unique receipt ID/hash and `BEGIN IMMEDIATE` serialize competing processes.
- Claim is durable before POST. No retry follows a claimed/unknown state.
- Audit schema cannot carry rendered fields.

## Residual risks

Superhuman does not provide a transactional coupling between local journal and remote delivery. A crash after POST but before response/commit is necessarily `unknown`; the service chooses no retry to preserve at-most-once POST. Availability depends on the pinned helper and provider contract. Operational release review must replace the helper hash sentinel and validate actual `shm` JSON schemas before any rollout.

## Negative bypass proof

As the worker account: `security find-generic-password -w -s ai.pinet.superhuman-send-executor -a root /Library/Keychains/System.keychain` must fail, ordinary `shm` must report no authentication, and raw `curl` has no bearer/cookie material. These are rollout checks, not automated here because this change must not provision credentials or send.
