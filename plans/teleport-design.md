# Teleport: remote tools, parent restart, and active children

Status: **design proposal, not implementation or activation approval**. Based on
`78b24b7`, the maintainer roadmap, and the installed Pi public APIs. This document
supports [#1073](https://github.com/gugu91/pinet/issues/1073),
[#1074](https://github.com/gugu91/pinet/issues/1074),
[#1075](https://github.com/gugu91/pinet/issues/1075), and
[#1076](https://github.com/gugu91/pinet/issues/1076). Implement the standalone
Durable provider [#1071](https://github.com/gugu91/pinet/issues/1071) first;
[#1072](https://github.com/gugu91/pinet/issues/1072) owns upstream ambiguous-dispatch
reconciliation. No real host enrollment, transfer, release, or infrastructure
change is authorized here.

## 1. Modes and evidence boundary

| Mode                      | Parent                                              | Execution                                                                           | Initial scope                                                     |
| ------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Remote tools (#1073)      | Existing local Pi conversation/runtime              | Selected tools on one explicitly selected host/workspace                            | `read`, `write`, `edit`, `bash`; all other tools explicitly local |
| Discovery (#1074)         | Unchanged                                           | No execution by discovery                                                           | Optional Tailscale inventory correlated with approved SSH hosts   |
| Parent move (#1075)       | Quiesce source; restart compatible Pi on target     | New accepted runtime generation                                                     | Transcript/runtime restart, not live process migration            |
| Child portability (#1076) | Parent can move only after child eligibility passes | Leave eligible jobs on execution host, or separately checkpoint/move supported jobs | No native/CLI-to-Durable conversion                               |

Remote tools do not move the parent, its SDK cwd, model credentials, UI, Pinet
membership, or children. Full migration does not transfer arbitrary processes,
TCP connections, terminal state, or undocumented extension memory.

The `/tmp/teleport-durable-poc` experiment used Durable **1.1.0**, pi-subagents
**0.76.1**, and Node **24.21.0**. Its recorded local SIGKILL experiment reattached
two children after handles were persisted: two starts, two reattachments, four
safe-tool invocations, two explicitly idempotent logical effects. The lost-handle
window reproduced `start-dispatch-abandoned`, then `start-redispatch-blocked`;
manual test-only provider retry found the original child. This design did not
rerun that experiment. Neither it nor a green #1071 adapter suite proves parent
migration, persistent cross-host supervision, remote cancellation, power-loss
safety, or exactly-once effects. Tool/model/transport replay remains possible.

## 2. Reuse existing owners; no parallel control plane

- [#1067](https://github.com/gugu91/pinet/issues/1067) owns launcher-independent
  membership, host identity/metadata, protected join profiles, revocable
  credentials, private outbound worker connections, and host/runtime adapters.
  Teleport consumes/extends that contract, not a second host registry or mesh.
  SSH authentication authorizes the selected account/helper; broker membership
  authentication separately authorizes Pinet registration. Neither implies the
  other. Followers must not need Slack credentials.
- [Hibernation safety](pinet-hibernation-dogfood.md) and
  [activation wiring](hibernation-live-activation.md) own lifecycle leases,
  generation reservations, per-attempt nonces, acceptance receipts, CAS recovery,
  broker-authored spawn facts, and attempt-bound stop proofs. Their documented
  isolated tests are not live activation. V1 is same-host/same-user root workers;
  cross-host runtime adapters and transfer reservations are **new work**, not
  existing guarantees.
- [#961](https://github.com/gugu91/pinet/issues/961) owns daemon spawn,
  idempotent prelaunch handles, restart reconciliation and the unresolved
  **central registration versus isolated subtree DB** topology. [#962](https://github.com/gugu91/pinet/issues/962)
  owns subtree eligibility, parent/child checkpoint and wake ordering, orphan
  policy, and child lifecycle fences. [Current subtrees](761-pinet-worker-subtrees.md)
  have parent-in-process endpoints; their persisted DB alone cannot supervise
  children when that parent exits. #1076 cannot silently centralize these DBs or
  lift `supervised_subtree_unsupported`.

A parent move requires one reachable existing broker authority for its identity.
Broker migration/federated consensus is out of scope. If that authority is
unavailable, fail closed rather than let hosts elect themselves. Current stable
IDs can embed host/session paths: #1067 must define a portable logical identity
and map it to host-local resume locators before #1075 implementation. Do not
rewrite identity by substituting a target path.

## 3. Host selection and SSH protocol (#1073, #1074)

Configured SSH works without Tailscale. Select a protected profile by opaque host
ID, not arbitrary `user@host` text from the model. The profile stores SSH alias,
user/port, approved host-key policy, workspace mappings, and permitted actions.
Use native `spawn` with argv; strict host verification and batch authentication
must fail closed. No agent/key forwarding or ambient environment forwarding.
SSH may interpret its remote command through a shell: invoke only a fixed,
operator-installed helper entrypoint, with all request data on framed stdin.
Do not concatenate paths, peer names, argv, or script content into that command.
The helper belongs to #1067's host-runner adapter, not a new always-on daemon.

Handshake binds protocol version, request nonce, configured host identity and
workspace to the authenticated connection. Verify actual cwd, canonical repo
identity, revision/worktree, OS/arch, shell and tool/runtime versions against
policy. Peer claims are data to validate, not sufficient authorization. Reject
unsupported versions/capabilities before dispatch. No silent bootstrap install.

Protocol sketches below are **proposed Teleport DTOs**, not upstream APIs. Parse
JSON/config/CLI/peer data at each boundary into named DTOs with strict schemas,
bounded strings/arrays, positive safe-integer epochs, nonnegative safe-integer
source/current generations, digest format, allowed enum values and frame size.
Reserved/accepted target generations must be positive safe integers derived by
the existing authority as source/current generation + 1, never caller-selected.
Never propagate generic records or unparsed values into routing. Repeated request
ID with different digest is a conflict.

```typescript
type ToolCapability = "read" | "write" | "edit" | "bash";
interface HostHandshakeDto {
  protocol: 1;
  nonce: string;
  hostId: string;
  workspaceId: string;
  cwd: string;
  repoIdentity: string;
  revision: string;
  dirty: boolean;
  os: string;
  arch: string;
  shell: string;
  versions: { name: string; version: string }[];
  capabilities: ToolCapability[];
}
type ToolPayloadDto =
  | { action: "read"; path: string; offset: number; limit: number }
  | { action: "write"; path: string; content: string }
  | { action: "edit"; path: string; oldText: string; newText: string }
  | { action: "bash"; script: string; timeoutMs: number };
interface ToolDispatchDto {
  protocol: 1;
  requestId: string;
  requestDigest: string;
  hostId: string;
  workspaceId: string;
  environmentEpoch: number;
  maxOutputBytes: number;
  payload: ToolPayloadDto;
}
interface ToolResultDto {
  protocol: 1;
  requestId: string;
  hostId: string;
  workspaceId: string;
  environmentEpoch: number;
  status: "completed" | "failed" | "cancelled" | "indeterminate";
  output: string;
  truncated: boolean;
  exitCode: number | null;
  errorCode: string | null;
}
interface CancelRequestDto {
  protocol: 1;
  requestId: string;
  hostId: string;
  environmentEpoch: number;
}
```

`bash.script` is intentional agent shell code executed by the verified target
shell, not an SSH transport command. Shell access is not a workspace sandbox;
a profile permitting bash grants account-level execution and needs explicit
operator approval. Filesystem tools resolve paths beneath the selected root,
reject traversal/symlink escapes and serialize mutations. Preserve built-in read
image/truncation behavior via public operation adapters; negotiate binary frames
where needed rather than treating arbitrary bytes as text. Above sketches omit
binary encoding details; freeze those before transport implementation.

Transport enforces output/frame/time/concurrency bounds independent of agent
arguments. Cancel addresses the helper-owned request/process group; closing SSH
alone is not evidence the command stopped. On disconnect or missing stop proof,
mark `indeterminate`, retain request identity for inspection, and never replay a
mutation automatically. This initial remote-tools protocol does not promise a
durable job ledger; use a durable backend for long-lived work.

Tailscale is an **opt-in discovery adapter** over bounded `tailscale status
--json` output, with versioned fixtures. Correlate immutable device identity with
#1067 host IDs and configured SSH targets. Names/MagicDNS/IPs are hints; renames
retain identity, removed/offline entries retain distinct status, collisions are
refused. Default is ordinary SSH over the private tailnet. Tailscale SSH is a
separate explicit profile mode subject to its policy/check flow; it is not a
host-key-verification bypass for ordinary SSH. No CLI installation, login,
auth-key minting, ACL edits, automatic enrollment or public listener. Revocation
must block new dispatch even if discovery still lists the host.

## 4. Environment epochs and public Pi seam

Use the public `createReadTool`, `createWriteTool`, `createEditTool`,
`createBashTool` operation interfaces and `registerTool` wrappers, as illustrated
by installed `examples/extensions/ssh.ts`. That example proves the public seam,
not production quoting, cancellation or fencing; do not copy its interpolated
SSH commands or string-prefix path replacement. Register tools during extension
loading, acquire resources on `session_start`/explicit selection, and release
idempotently on `session_shutdown`. Unsupported/local-only tools are identified;
never impersonate all tools as remote. `!` execution stays explicitly local in
initial scope; remote user-bash routing needs separate operator opt-in.

Target switching is an idle-boundary transaction:

1. Freeze routed admissions, including parallel/nested tool calls. Wait for
   settled work; optionally request cancellation. An indeterminate outstanding
   mutation blocks switching until operator reconciliation, not forced fallback.
2. Authenticate/handshake target and verify workspace/capabilities. Failure keeps
   old target and epoch; explicit local restore runs the same checks/barrier.
3. Persist the new target and monotonically increased epoch on the active branch.
   Store machine state with `appendEntry`; emit one concise trusted custom
   environment-change message with `sendMessage` before releasing admissions.
   A crash between writes keeps routing frozen until startup reconstruction
   completes the missing event. Events carry an epoch ID for deduplication.
4. Update TUI status (host/cwd/epoch) and structured tool details. Non-TUI modes
   receive the same metadata/event without requiring a dialog. Results retain
   their dispatch host/epoch; late old-epoch output cannot become new-host output.

The agent sees execution host, actual cwd, repo/revision, OS/shell, allowed tools,
and changed facts. Before the next model request, update structured prompt cwd
and execution guidance through `before_agent_start`, not wholesale historical
prompt replacement. Local-only tools still use local SDK cwd. Old messages stay
historical; do not assert prior files/processes exist on the target. Keep one
small stable capability summary, not repeated full inventories. Detailed host
help/schema and transfer recipes are cold-path docs/skills, not permanent tools.

Public Pi SDK supports `SessionManager`, explicit cwd/resource loader and session
restart/import; it does not supply cross-host authority, arbitrary extension
snapshots or OS-process migration. Capture the active leaf, compaction/branch
state and complete session file; use public session APIs, not raw assignment to
agent messages. New runtime subscriptions/contexts must be rebound. Extension
compatibility needs declared restore support; unregistered volatile state blocks
migration. `agent_end` alone is not quiescence: wait for settled/idle plus empty
steer/follow-up/retry/control queues and no live tool work.

## 5. Workspace, compatibility and secrets

Both modes require an approved canonical repo identity and explicit local-root
to target-root mapping. Missing repo, wrong revision, divergent/dirty target or
source changes produce a dry-run conflict plan. Initial policy is refuse until
operator selects a clean target or approves an allowlisted dirty-file transfer;
no automatic stash, overwrite, fetch or home-directory sync. Record file hashes,
size bounds and expected base revision. Reject absolute/traversal/archive links,
symlink escapes, special files and unsafe modes on import into an isolated
staging root; verify hashes before atomic activation.

Migration manifest references exact Pi/Durable/provider/extension/schema versions,
model/provider availability, capabilities, workspace plan and store snapshots.
No silent model/extension substitution. Export SQLite via a supported consistent
backup or clean closed-store snapshot, never a live main file without its WAL.
If public storage APIs do not support safe export/reopen, that capability is
unavailable until an adapter is reviewed; do not deep-import it.

Credentials are target-provisioned references/presence checks, never bundled
values. No `.env`, SSH keys, token-bearing settings, auth stores, mesh secrets or
Slack credentials in workspace allowlists. Transcript/tool output may already
contain secrets: treat session/store bundles as sensitive, require destination
trust and explicit data-transfer consent, and protect storage/transport. Log only
IDs, generations, digests, machine error codes and bounded sanitized summaries;
no credentials, prompts, raw host claims or unrestricted paths.

## 6. Parent ownership state machine (#1075)

Extend the existing broker lifecycle authority; the following transfer phases
are operation metadata, **not a competing lease/state system**. Persist transfer
intent, checkpoint/import receipts and acceptance receipt through that owner.
Do not repurpose ordinary wake authorization without reviewed cross-host checks.

```typescript
interface TransferManifestDto {
  protocol: 1;
  transferId: string;
  logicalSessionId: string;
  sourceHostId: string;
  targetHostId: string;
  sourceGeneration: number;
  environmentEpoch: number;
  activeLeafId: string;
  transcriptDigest: string;
  compatibility: { component: string; version: string }[];
  workspace: { repoIdentity: string; revision: string; mappingId: string };
  files: { relativePath: string; digest: string; bytes: number }[];
  stores: { storeId: string; snapshotDigest: string; schemaVersion: number }[];
  children: ChildInventoryDto[];
}
interface TransferAcceptanceDto {
  transferId: string;
  logicalSessionId: string;
  targetHostId: string;
  generation: number;
  fenceToken: number;
  reservationNonce: string;
  manifestDigest: string;
}
```

| Phase           | Durable evidence and permitted action                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Preflight       | Host/auth/compatibility/workspace/child eligibility; no source ownership change                                                   |
| Quiesce         | Hold existing lifecycle operation authority; freeze tools and incoming work (queue durably); no new source work                   |
| Checkpoint      | Safe transcript/store/child-delivery receipts; prove source runtime stopped by attempt-bound handle before any target reservation |
| Transfer        | Integrity-bound manifest copied to isolated target staging; neither runtime may dispatch                                          |
| Validate/import | Target validates bundle and credentials; imported runtime remains dispatch-disabled                                               |
| Reserve         | Existing authority reserves next generation and fresh attempt nonce, bound to target and manifest digest                          |
| Accept          | Registration and generation acceptance commit atomically, with receipt; only that runtime becomes owner                           |
| Retire          | Complete lifecycle bookkeeping; delete staging/source artifacts only after retention/ACK policy; source cannot resume             |

Invariant: at most one execution-enabled parent generation and one owner of each
moved store. Target launch without a returned attempt handle is ambiguous and
cannot justify retry. Renew existing operation leases as required; expiration
alone never proves target absence. Fences reject stale registration, tool
admission, mailbox ACK and child-supervision operations; a fence cannot undo an
external shell effect, hence source stop proof is mandatory.

Before acceptance, rollback is possible **only** after an atomic authority settle
consumes this exact target reservation (`fenced-unaccepted`), proves any target
attempt stopped, and restores source via the existing fenced resume path. After
acceptance, only forward reconciliation is safe. On lost ACK/query failure,
classify `accepted`, `fenced-unaccepted`, or `unknown`; never turn `unknown` into
absence, kill a possibly accepted target or resume source. Retain recovery-pending
state/quarantine according to existing lifecycle policy. Startup recovery runs
before admitting registrations; exact receipt replay rebinds the winning runtime
without another generation advance. Rollback failure also remains quarantined.

Acceptance makes the target owner but keeps dispatch gated until its persisted
environment event and child routing are ready. Historical inbox and result IDs
survive transfer. Delivery is at-least-once with persistent dedup/ACK, never
exactly-once shell/tool effects. Moving the broker itself is not part of rollback.

## 7. Active children and persistent delivery (#1076)

```typescript
interface ChildInventoryDto {
  childId: string;
  parentSessionId: string;
  kind: "durable" | "native-pi" | "cli" | "external";
  provider: string | null;
  providerJobId: string | null;
  storeId: string | null;
  executionHostId: string;
  supervisorGeneration: number;
  capabilities: ("reattach" | "cancel" | "checkpoint-export" | "persistent-delivery")[];
  endpointId: string | null;
  lastAcknowledgedResultId: string | null;
}
interface ChildResultDeliveryDto {
  childId: string;
  parentSessionId: string;
  supervisorGeneration: number;
  resultId: string;
  sequence: number;
  digest: string;
  output: string;
}
```

| Kind                       | Leave in place while parent moves                                                                        | Migrate child runtime/store                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Durable external job       | Only with persistent authenticated endpoint and fenced delivery owner; local reattach alone insufficient | Optional compatible safe checkpoint/export/reopen, source stopped and single-writer fence proven; not established by PoC |
| Native Pi supervised child | Only after #961 endpoint topology and #962 orphan/wake policy support it                                 | Separate native restart support plus #962 child fencing; otherwise unavailable                                           |
| CLI/process child          | Only with already durable persistent supervisor and result channel                                       | Arbitrary live CLI/process transfer unavailable                                                                          |
| Other external provider    | Only declared persistent endpoint/reattach/ACK capability, verified against policy                       | Provider-specific explicit capability; absent means unavailable                                                          |
| Uninventoried child/state  | Block move                                                                                               | Block move                                                                                                               |

For each ineligible child, offer **wait**, authorized **cancel** with stop proof,
or **leave with an existing persistent supervisor** if supported. Cancel is not
assumed from the provider name. Never silently orphan or convert active children.

Proposed delivery protocol, implemented under #961/#962 ownership:

1. Inventory all children and pending deliveries while parent admissions freeze.
   Endpoint must outlive both parent runtimes. Children may keep running only if
   their mailbox/supervisor and durable result queue already meet this condition.
2. Persist transfer intent with old supervisor generation, next generation and
   child IDs. Endpoint queues results throughout transfer; source stops consuming
   before checkpoint. A result arriving now is neither lost nor sent to staging.
3. Broker acceptance is the authority for delivery-owner change. Endpoint verifies
   the exact acceptance receipt and CAS-advances each child delivery generation;
   retries are idempotent. Until all advances are acknowledged, target stays
   dispatch-disabled and results buffered. Before acceptance abort keeps old
   ownership; after acceptance partial changes are reconciled forward, not undone.
4. Target durably records `(childId, resultId, digest)` before sending a generation-
   bound ACK. Duplicate same-ID/same-digest delivery is acknowledged without a
   second context insertion; conflicting digest is quarantined. Old-generation
   poll/ACK cannot consume or clean up new-generation results. Cleanup requires
   ACK plus retention policy, not a successful socket write.

Execution/store ownership and delivery supervision are separate: leave-in-place
changes only supervision, whereas child migration must separately stop/fence its
writer and validate snapshots. Endpoint unavailability blocks transfer acceptance
readiness, not child re-execution. Apply #962 ordering: obtain a safe child
checkpoint/endpoint receipt before final parent checkpoint; wake endpoint before
any child needing delivery. If endpoint still lives inside parent, parent must
stay alive or movement is refused. Parent crash invokes #961/#962 orphan recovery,
not a new Teleport orphan daemon.

**Missing upstream support:** pi-subagents 0.76.1 public
`pi-subagents/external-job-provider` exposes `start`, optional `followUp`, `status`,
`result`, `reattach`; no cancel/steer/export/transfer, supervisor-generation ACK,
persistent remote endpoint, or ambiguous-dispatch reconciliation method. Its
originating-Pi local file bridge cannot serve leave-in-place jobs after that Pi
moves/dies. A persistent endpoint must be supplied by reviewed host/backend
adapters through the existing membership/lifecycle architecture, with a public
provider integration agreed where needed. Do not production-import runner,
bridge or native factories. #1072 separately proposes opt-in reconcile versus
idempotent-start using full immutable request digest and logical dispatch identity;
stock fail-closed redispatch guards remain until agreement and regression proof.

## 8. Threat/crash matrix and acceptance gates

These are required future tests, not results of this documentation change. Use
fake transports/authority clocks first, then disposable two-host fixtures with
explicit approval; no real credential enrollment or host mutations in design CI.

| Test ID / boundary or threat                             | Expected behavior and decisive assertion                                                                                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1 Host injection/key mismatch/revocation                | Untrusted names/paths never enter SSH command; wrong host key or denied profile executes zero requests; revoked broker membership rejected separately                                                                    |
| T2 Discovery missing/offline/renamed/collision/malformed | Configured SSH unaffected by absent CLI; rename retains device binding; collisions/oversized or unsupported JSON rejected; no login/ACL changes                                                                          |
| T3 Parallel calls and target switch                      | Freeze all admissions; event precedes first new dispatch; metadata/UI match cwd/epoch; late old result remains old; failed preflight restores unchanged epoch                                                            |
| T4 Cancel/disconnect/output flood/unsupported tool       | Helper bounds output/time; proven cancel versus indeterminate distinguished; no local write fallback or automatic mutation replay; local-only tools identified                                                           |
| T5 Workspace/secret/archive attacks                      | Dirty/missing/divergent workspace blocks; dry-run allowlist excludes keys/settings; reject traversal, symlinks and unsafe files; corrupted manifest/store fails import                                                   |
| T6 Crash before checkpoint/source stop proof             | Source can resume only via proven authority; unproven source death blocks reservation; pending control/retry/tool work cannot pass quiescence                                                                            |
| T7 Crash during copy/import/reserve/launch               | Staging cannot dispatch; exact-nonce atomic settle plus attempt stop proof precedes rollback/retry; no-handle launch quarantined                                                                                         |
| T8 Lost acceptance ACK / partition / settle fault        | Receipt replay accepts no second generation; `unknown` never kills target/resumes source; crash after accept before bookkeeping recovers forward                                                                         |
| T9 Stale source/target registration or writer            | Source generation 0 reserves/accepts target generation 1 through the existing authority; wrong host/digest/generation/nonce denied atomically; only accepted target writes; stale store writer rejected before reopening |
| T10 Two running children and result during transfer      | Same child/job IDs; buffered result eventually reaches new parent, duplicate produces one durable insertion; stale supervisor ACK cannot delete it                                                                       |
| T11 Parent/endpoint crash and partial child-owner update | Endpoint survives where capability declared; postaccept partial CAS reconciles forward; endpoint loss blocks readiness; #962 orphan policy invoked                                                                       |
| T12 Nonportable CLI/native child / absent APIs           | Move refused with wait/cancel/eligible-leave choices; no conversion, deep import or capability invented; lost provider handle stays fail-closed pending #1072                                                            |
| T13 Session/extension compatibility and environment      | Preserve leaf/compaction/history via public APIs; incompatible model/volatile extension blocks; no tool before trusted new environment event; non-TUI has same contract                                                  |

Each crash test kills only fixture-created processes, reopens persisted state,
asserts ownership/result counts and includes a negative control (e.g. remove nonce
check, replay mutation or accept stale ACK) that fails the assertion. Report exact
revision, dependency versions, commands and untested paths. Repository
lint/typecheck/test plus independent review are necessary gates, not proof of
cross-host behavior. Stop rollout on duplicate enabled generations, lost/incorrect
ACK, stale-fence acceptance, unproven process ownership, or sensitive log content.

## 9. Dependency DAG and exclusive implementation lanes

```text
#1071 package + crash evidence -> #1072 upstream proposal/agreement (lost handles)
#1067 host/auth/identity contract -> #1073 transport + environment routing
                                -> #1074 optional discovery
#961 topology + persistent spawn/endpoint -> #962 subtree lifecycle
#1071 public backend + #1067 + #961/#962 -> #1076 persistent child delivery
#1073 verified host/environment + hibernation cross-host adapter
  + #1076 eligibility/delivery + workspace/restore contract -> #1075 parent move
```

#1072 blocks **automatic ambiguous-start recovery**, not remote tools or
persisted-handle reattachment. #1074 is optional, never a prerequisite for SSH.
#1075 can first test childless fixtures, but must refuse active children until
#1076 eligibility is integrated. Durable subtree migration can remain unavailable
while verified leave-in-place delivery is implemented.

After design review, PM assigns concrete paths in separate worktrees before any
writer starts. Proposed non-overlapping lanes (no package metadata edits here):

| Lane / exclusive owner          | Owns                                                                         | Entry gate / handoff                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Membership owner (#1067)        | Existing membership/host registry/auth schemas and portable identity mapping | Approve host trust and shared DTO contract; no other lane edits registry/schema                            |
| SSH transport owner (#1073)     | Helper transport framing, operations, cancellation, fake/isolated SSH tests  | Frozen #1067 handshake and binary/output contract; hand off public adapter interface, T1/T4/T5             |
| Environment owner (#1073)       | Pi routing, epoch barrier, context/status and restore tests                  | Frozen transport interface; fake implementation permits parallel work; T3/T13 before integration           |
| Discovery owner (#1074)         | Tailscale parser/fixtures and registry projection adapter only               | Frozen registry consumer interface; T2; cannot change membership or credentials                            |
| Subtree owners (#961 then #962) | Daemon endpoint topology/spawn, then local lifecycle/orphan ordering         | Resolve topology centrally first; serialized shared schema/transactions, not a concurrent Teleport rewrite |
| Delivery owner (#1076)          | External job endpoint adapter, inventory, fenced result handoff tests        | #961/#962 receipts and #1071 public backend; negotiate absent upstream methods; T10–T12                    |
| Migration owner (#1075)         | Manifest/workspace export/import and lifecycle transfer adapter/tests        | Frozen restore/identity/delivery contracts; single writer for authority transactions; T5–T9/T13            |
| Integration owner               | Cross-lane wiring and final gates only                                       | Component commits reviewed; run all tests, independent exact-head review; report seam changes to PM        |

Independent work is transport versus fake-backed environment routing versus
optional discovery **after shared contracts freeze**. Lifecycle SQL, acceptance
receipts and child ownership are not independent writers. Public docs/tool
schemas stay compact; cold transfer/discovery help is loaded on demand.

Unresolved decisions belong to existing owners: #1067 portable identity and
credential authority; #961 isolated-versus-central topology; #962 orphan/wake
policy; upstream #1072 reconciliation contract; public store export and optional
provider lifecycle capabilities. These are gates, not PoC-proven assumptions.
Recommended sequence: review #1071 evidence and this design; settle #1067 and
#961/#962 contracts; ship SSH remote-tools/epochs with discovery optional; prove
persistent leave-in-place child delivery; then prove childless parent restart,
active-child restart, and only afterward optional child-store migration. Activation
always requires separate maintainer approval and an exact-head independent review.
