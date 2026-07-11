# External approval signer deployment contract and runbook

**Status: specification only; non-production; not executed by PR #921.** This file does not provision a key, credential, identity, endpoint, trust root, route, executor, or provider transport. Every command-shaped example below is a review template, not authorization to run it.

Tracking: issuer [#920](https://github.com/gugu91/extensions/issues/920), executor [#919](https://github.com/gugu91/extensions/issues/919).

## 1. Required deployment topology

Use three mutually isolated service identities:

| identity          | may hold                                                                  | must not hold                                         |
| ----------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| broker issuer     | Slack signing-secret capability; authenticated signer client capability   | Ed25519 private key; provider credential              |
| approval signer   | non-exportable Ed25519 private key; broker-auth policy; operation journal | Slack secret; provider credential; arbitrary-sign API |
| provider executor | pinned public roots; provider credential; consumption/execution journal   | signer private key; Slack secret                      |

Pi/workers are none of these identities. They must be unable to read or rewrite signer state, trust policy, executor state, or credentials. A loopback port, Unix-socket pathname, filesystem location, UID string supplied by a caller, or possession of public material is not authentication.

The administrator chooses the service manager, hardware/non-exportable keystore, and authenticated local IPC mechanism. Production readiness requires recorded proof of peer identity and ACLs on the selected platform; this repository intentionally provides no production adapter or fallback.

## 2. Exact signer API

The signer exposes one authenticated operation and no generic signing primitive.

```json
{
  "operation": "issueApproval",
  "operationId": "UUID",
  "claims": {
    "version": "shm-approval-receipt/v1",
    "keyId": "operator-assigned-key-id",
    "approvalId": "string",
    "principal": "U0AF5S3LQ5C",
    "issuedAt": "canonical ISO instant",
    "expiresAt": "canonical ISO instant",
    "envelope": "exact ApprovalEnvelope object"
  }
}
```

Success has exactly these fields:

```json
{
  "algorithm": "Ed25519",
  "keyId": "operator-assigned-key-id",
  "signature": "strict unpadded base64url, exactly 64 decoded bytes"
}
```

The signature input is the UTF-8 bytes returned by `serializeApprovalClaims`: recursive JSON object-key sorting by UTF-16 code-unit order, arrays kept in order, standard JSON scalar encoding, and no whitespace. The signer must use a separately implemented conformance fixture rather than trusting broker-provided bytes.

Before signing, parse into the exact named v1 DTO and reject unknown/missing fields, noncanonical instants/digests/signature encodings, unsupported algorithm/version/key ID, a principal other than `U0AF5S3LQ5C`, issue time outside the configured clock-skew policy, lifetime outside `(0, 300000]` ms, empty recipient union, empty screenshot digests, and invalid envelope fields. Never accept a caller-selected key, public key, algorithm, policy, URL, or command.

### Durable operation semantics

Before cryptographic work, atomically reserve `(authenticatedBrokerIdentity, operationId, canonicalClaimsSha256)`. Exactly one of these outcomes is allowed:

- first use: reserve, sign once, durably store the complete success response, then respond;
- same identity/ID/digest: join in-flight work or return the byte-identical stored response;
- same identity/ID with another digest: reject permanently as `operation_conflict`;
- authenticated but policy-invalid before reservation/signing: definitive `pre_sign_rejected` carrying the same operation ID;
- disconnect, timeout, storage ambiguity, or failure after reservation: retain the operation and reconcile; never report a definitive pre-sign rejection.

A broker abort may stop work only if no durable result exists. It never deletes a completed operation. Retain operation records for at least the maximum receipt lifetime plus clock-skew and incident-recovery window.

### Error contract

Return a bounded code and correlation ID only—never claims, payload, recipient, signature, key bytes, or credential data.

| code                               | retry meaning                                                 |
| ---------------------------------- | ------------------------------------------------------------- |
| `pre_sign_rejected`                | definitive; broker may release only when operation ID matches |
| `operation_conflict`               | permanent security fault; do not retry with that ID           |
| `unauthenticated` / `unauthorized` | permanent until deployment repair                             |
| `busy`                             | ambiguous after request delivery; retain/reuse operation ID   |
| `internal_ambiguous`               | ambiguous; retain/reuse operation ID and reconcile            |

Transport adapters must map only a proven `pre_sign_rejected` to `ApprovalSignerPreSignRejection`. All other errors remain ambiguous.

## 3. Pinned-root artifact

The executor and broker response verifier read an operator-owned immutable manifest, never a request value:

```json
{
  "contract": "shm-approval-receipt/v1",
  "generation": 7,
  "roots": [
    {
      "keyId": "approval-2026q3",
      "algorithm": "Ed25519",
      "publicKeySpkiSha256": "lowercase hex SHA-256",
      "publicKeySpkiPem": "operator-reviewed public SPKI"
    }
  ]
}
```

Production parsing must reject duplicate key IDs, unknown fields/algorithms, hash mismatch, empty roots, rollback to a lower generation, and resources writable by broker/Pi/worker identities. `PinnedApprovalVerifierSet` models bounded overlap in library code; it selects only among roots preloaded from this manifest. Receipt fields can never add a root.

## 4. Staged deployment procedure (administrator-owned; not run here)

### Prepare, without enabling

1. Record exact source commit, dependency lock checksum, reproducible build checksum, signer binary signature, and signer protocol conformance result.
2. Create a non-login signer identity with no inherited broker, worker, or provider environment.
3. Generate/import Ed25519 material directly in the chosen non-exportable keystore. Record only key ID and public SPKI/fingerprint.
4. Create root-owned signer policy and operation-journal locations. Deny broker/Pi/worker read/write except the broker's narrowly authenticated IPC invocation right.
5. Materialize pinned-root generation `N` independently for broker response verification and executor verification. Verify ownership, mode/ACL, generation, SPKI hash, and artifact checksum.
6. Configure an authenticated IPC peer policy naming only the broker issuer identity. Confirm every other operation and peer is rejected.
7. Keep the broker route disabled. Start no provider executor and invoke no provider transport.

### Pre-enable proof

Run under each identity and retain sanitized evidence:

- signer can open only its key handle and operation journal;
- broker can call only `issueApproval` and cannot export/read key material or mutate signer policy;
- Pi/worker cannot call signer, read key material, or rewrite either pinned-root artifact;
- signer cannot read Slack/provider credentials; broker cannot read provider credentials;
- malformed/unknown operations and operation-ID conflicts fail closed;
- synthetic conformance uses newly generated ephemeral test keys, never the production key;
- broker verifies signer responses against its pinned artifact before finalizing;
- executor compatibility accepts the exact issuer v1 wire receipt and rejects every altered field without a provider adapter.

### Separately authorized enablement

Only a named administrator with rollout approval may enable in this order: verifier artifacts, signer, signer health/readiness, broker signer adapter, Slack semantic route, executor last. Keep provider execution disabled until all receipt-only checks and independent exact-head review pass. Record artifact checksums and timestamps. Nothing in PR #921 grants this approval.

## 5. Root rotation and revocation

Receipt lifetime is at most five minutes, but use a conservative overlap of maximum TTL + maximum accepted clock skew + deployment propagation margin.

### Planned rotation

1. **Prepare:** create new key `K2`; append its public root in manifest generation `N+1` while retaining `K1`. Do not switch signing.
2. **Distribute:** deploy the `[K1,K2]` manifest to broker verifier and every executor. Prove all instances report generation `N+1` and both fingerprints. A partial fleet blocks progression.
3. **Canary without transport:** issue synthetic receipts with `K2` in an isolated harness and verify them at every executor compatibility boundary. No provider adapter or send.
4. **Switch:** atomically configure the signer/issuer to issue only `K2`. Never choose a key per request.
5. **Observe:** keep `[K1,K2]` until the final possible `K1` receipt has expired plus skew and propagation margin; monitor unknown-key and signature-rejection counters.
6. **Retire:** deploy generation `N+2` containing only `K2`; disable the `K1` key handle; retain audit/journal evidence according to policy. Destroy `K1` only under a separate key-destruction procedure.

Rollback before step 4 removes `K2` with a strictly higher manifest generation. Rollback after step 4 first switches issuance back to an uncompromised `K1`, then retains both roots through the same bounded drain. Never roll back the manifest generation number.

### Emergency revocation

If a private key or signer identity may be compromised, availability loses to safety:

1. Disable approval issuance and provider execution immediately.
2. Revoke signer IPC identity and disable the affected key handle.
3. Deploy a higher-generation manifest excluding the compromised key to broker and all executors—no overlap.
4. Treat every unexpired receipt from that key as revoked. Preserve body-free audit and operation journals; do not retry or send.
5. Provision a new identity/key and follow the full prepare/distribute/canary flow.

Because revocation is represented by absence from the immutable pinned set, `RotatingApprovalReceiptVerifier` rejects the old key before signature verification or consumption.

## 6. Health and body-free observability

Readiness is true only when authenticated IPC is listening, key handle is usable for its configured key ID, policy and pinned-root generations match expectation, operation journal passes an integrity check, clock skew is within policy, and no key/fallback sentinel is present. Liveness proves only that the process event loop responds; it must not sign.

The broker audit health payload is aggregate-only:

```json
{
  "status": "ok",
  "checkedAt": "canonical ISO instant",
  "pending": 0,
  "stalePending": 0,
  "active": 0,
  "cancelled": 0,
  "expired": 0,
  "consumed": 0
}
```

`ApprovalAuditStore.health()` executes SQLite `quick_check` and returns this schema. Health, metrics, and logs must never contain raw Slack bodies/headers/signatures, claims JSON, payload/body/subject, recipients, draft content, signer signatures, keys, provider data, or credentials. Allowed dimensions are bounded result/error code, configured key ID, manifest generation, service version, and aggregate counters. Correlation IDs must be random service IDs—not payload-derived values. Alert on signer unready, root-generation disagreement, unknown key ID, signature failure, operation conflict, stale pending growth, clock skew, audit integrity failure, or any attempt to invoke an unsupported operation.

## 7. Rollback

1. Disable provider execution, then disable the Slack semantic approval route.
2. Stop new signer calls; preserve pending operations for reconciliation.
3. If compromise is suspected, follow emergency revocation rather than ordinary rollback.
4. Restore the previously recorded broker/signer artifact only if its key remains trusted and its schema/database migration is backward compatible.
5. Use a new, monotonically higher trust-manifest generation even when restoring older roots.
6. Keep all roots needed for already-issued, uncompromised receipts through their bounded drain; otherwise intentionally revoke them.
7. Preserve body-free issuer audit and signer/executor journals. Never delete them to make rollback pass.
8. Re-run integrity, ACL, credential-separation, root-fingerprint, version, and synthetic compatibility checks before any re-enable.

Rollback must not install/reload an executor, invoke provider transport, reconcile by resending, or perform a synthetic/live send.
