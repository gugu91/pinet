# Issuer-to-executor compatibility gate

**Non-production receipt-only gate. No credentials, provider adapter, transport, or send.**

Coordination: issuer [#920](https://github.com/gugu91/extensions/issues/920) / PR #921; executor [#919](https://github.com/gugu91/extensions/issues/919) / `origin/feat/superhuman-send-executor-919`.

## Canonical shared contract

The hand-off is the JSON round-trip of broker-core's `ApprovalReceipt`:

```text
{
  claims: {
    version: "shm-approval-receipt/v1",
    keyId, approvalId, principal, issuedAt, expiresAt,
    envelope: { accountId, threadId, draftId, draftFingerprint, attestation,
                payload, recipients: {to, cc, bcc}, rendererBuild,
                screenshotDigests, sendId, delayMs, scheduledFor, action, provider }
  },
  signature: strict-unpadded-base64url-Ed25519(canonical claims)
}
```

The executor must consume this object directly and apply the same canonicalization and complete semantic match. It must not define another object with the same version string. Process attestation, if retained by #919, is a separate executor-authentication object and cannot replace, rename, weaken, or re-sign receipt claims.

`broker-core/approval-receipts.compatibility.test.ts` is the local compatibility harness. It:

1. creates fresh process-local Ed25519 keypairs;
2. issues old- and new-root receipts through `SlackApprovalIssuer`;
3. JSON-round-trips the receipt at the executor boundary;
4. verifies and atomically consumes it with the production receipt verifier but no provider capability;
5. proves bounded two-root overlap and old-root revocation; and
6. checks aggregate body-free health output.

The file suffix `.test.ts` means the repository build excludes it; broker-core exports no harness or synthetic signer. It has no environment/config switch and no key loading, network, provider, or send API. Thus it cannot become a production signer fallback.

Run only:

```text
pnpm --filter @pinet/broker-core test -- approval-receipts.compatibility.test.ts
```

## Inspection of executor branch

Inspected commit `c9ce285a04fc90a0aa41ad32685f1a5554842d40` with `git show` only; it was not merged. Its current `superhuman-send-executor/src/contracts.ts`, `canonical.ts`, and `verify.ts` do **not** implement the shared receipt above:

| issuer v1                                      | executor branch at inspected commit                |
| ---------------------------------------------- | -------------------------------------------------- |
| `{claims, signature}`                          | `{kind, id, issuerKeyId, approved, signature}`     |
| base64url signature over canonical claims      | base64 signature over a different unsigned receipt |
| complete envelope and Thomas Slack principal   | reduced account/draft/user/rendered hash           |
| five-minute maximum lifetime                   | no maximum-lifetime check                          |
| locale-independent key order                   | `localeCompare` ordering                           |
| issuer audit cancellation/one-time consumption | separate executor journal only                     |

Therefore the actual cross-branch compatibility result at that commit is **incompatible/fail closed**; claiming an issuer-to-current-executor E2E pass would be false. #919 must adopt/import the broker-core receipt contract and run this receipt-only gate (or an equivalent fixture sourced from broker-core) before either PR is authority-ready. This incompatibility does not justify merging the branch, adding provider credentials/transport, or performing a send.

## Required executor-side acceptance gate

Before rollout, #919 must prove against the exact PR #921 package artifact:

- valid JSON-round-tripped receipt accepted once;
- altered version/key ID/principal/time/signature or any envelope field rejected;
- expired/cancelled/replayed receipt rejected;
- overlap accepts only pre-pinned old/new roots;
- emergency manifest excludes the revoked root immediately;
- rerender comparison uses the complete approved envelope semantics;
- no provider method is present or callable in the compatibility lane;
- audit/health output contains no body, subject, recipient, token, signature, or provider response.
