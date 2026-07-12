# Pinet hibernation — live activation wiring (follow-up to #923 / PR #924)

Status: **runtime mechanics proven and merged-ready; live-broker wiring scoped
below and pending review before any production activation.**

The merged #923 landed the durable primitives (fenced leases, CAS lifecycle,
runtime specs, checkpoint receipts, generation reservations, wake queue,
telemetry), the `HibernationOrchestrator`, the operator commands, and full
socket-server **wake-fence enforcement** (`enforceWakeFence` →
`registerAgentWithGenerationAcceptance`). What it deliberately did NOT wire is
the live process/tmux side and the production instantiation. This branch adds
the real adapters + proof and the spec builder; the remaining wiring is below.

## Landed on this branch (tested, committed)

- `broker/hibernation-runtime-adapters.ts` — real `HibernationProcessController`
  - `HibernationTmuxController` + `resolveVcsIdentity` (git origin remote) +
    `createExecFileRunner`. `stopRuntime` self-ensures `remain-on-exit on` on the
    pane before killing Pi, so hibernation needs **no worker spawn-path change**
    for pane survival.
- `broker/hibernation-runtime-helpers.ts` — pure, tested helpers:
  `deriveVcsIdentity`, `sessionResumeRefFromStableId`, `resumePathFromSessionRef`,
  `buildWakeFenceEnv`, `parseWakeFenceEnv`, `buildResumeLauncherScript`, and
  `buildRuntimeSpecInput` (spawn-authored spec composer, fail-closed).
- `broker/hibernation-runtime-adapters.e2e.test.ts` — opt-in
  (`HIBERNATION_E2E=1`, skipped in CI) proof that the adapters drive a REAL Pi
  runtime through hibernate→wake on a throwaway tmux socket: checkpoint-safe →
  stop (pi dies, tmux session survives + attachable, session `.jsonl` intact) →
  respawn (`pi --session <path>` into the surviving pane, woken pi alive on a
  fresh pid bound to the same session) → attempt-bound cleanup. Green in ~6s.
- 38 unit tests across adapters + helpers; full `broker/` suite 536 pass / 1
  skipped; tsc + eslint + `lint:agent-standards` clean.

## Remaining live-broker wiring (needs review before activation)

### 1. Deterministic session path at spawn (enables spec authoring)

`buildLauncherScript` (`subtree-broker-runtime.ts`) currently launches
`pi -e <entry> <startupPrompt>` with **no `--session`**, so the worker's session
path (and thus its stable id `host:session:<path>`) is auto-generated and
unknown to the broker until the worker registers.

To author a durable runtime spec keyed to a worker, the broker must know the
stable id ahead of registration. Assign a broker-chosen
`--session <sessionDir>/<launchId>.jsonl` at spawn. Tradeoff to review: this
moves the session file off Pi's default session dir; confirm session listing /
resume / recap features tolerate an explicit path (they key off the stable id,
which still embeds the path, so this should be transparent).

### 2. Spawn-facts capture + register-time spec authoring (SECURITY-CRITICAL)

Record broker-KNOWN spawn facts keyed by the (now-known) stable id at spawn:
`{ tmuxSocket, tmuxSession, tmuxTarget, repoRoot, cwd, worktreePath,
extensionEntryPath, envAllowlist, launchSource, configFingerprint,
expectedUser }`. At register (`socket-server.handleRegister`), after the agent
id + stable id are resolved and (for wakes) the fence is accepted, look up the
spawn facts by stable id, resolve `vcsIdentity` via `resolveVcsIdentity(repoRoot)`,
call `buildRuntimeSpecInput(...)`, and `db.upsertAgentRuntimeSpec(...)`.

**Do NOT trust worker-reported tmux/cwd for these operational locators.** A
worker able to name another worker's pane could get the broker to
checkpoint/kill/respawn THAT pane. `buildRuntimeSpecInput` already takes only
`SpawnAuthoredRuntimeFacts` and fails closed on non-resumable identities /
missing locators; the caller must feed it broker-recorded facts, not register
params. Authorization uses solely the broker-derived `vcsIdentity`.

Persistence tradeoff to review: an in-memory `Map<stableId, SpawnFacts>` is
simplest but is lost on broker restart (hibernation of pre-restart workers
degrades until they re-register). A durable spawn-facts table avoids that at the
cost of a broker-core schema change.

### 3. Orchestrator instantiation + real executor (`index.ts`)

Instantiate once when the broker role is established:
`new HibernationOrchestrator({ db, process: createHibernationProcessController(...),
tmux: createHibernationTmuxController({ extensionEntryPath, baseLaunchEnv,
inheritedEnvKeys }), brokerInstanceId })`. `awaitRuntimeRegistration` needs NO
socket wiring — the default DB-polls `runtimeGeneration === reservedGeneration`,
which the socket-server's fenced register already advances.

`baseLaunchEnv` = the broker-level reconnect env used at spawn (PINET_SOCKET_PATH,
PINET_BROKER_MANAGED=1, PINET_PARENT/ROOT/SPAWNED_BY_AGENT_ID = broker self id,
PINET_LAUNCH_SOURCE) so the woken worker reconnects to the same broker.
`inheritedEnvKeys` = the same list `buildLauncherScript` inherits (PI_CODING_AGENT_DIR,
PI_CODING_AGENT_SESSION_DIR, PI_OFFLINE, PI_SETTINGS_PATH, PINET_MESH_SECRET,
PINET_MESH_SECRET_PATH, SLACK_APP_TOKEN, SLACK_BOT_TOKEN). The orchestrator IS a
`HibernateCommandExecutor & WakeCommandExecutor` (matching method signatures), so
the hibernate/wake command handler passes the orchestrator instance directly,
replacing the `activation_pending` stub — gated behind
`resolveHibernationSettings(settings).enabled` AND an explicit activation flag so
it stays inert (honest `activation_pending`) while disabled.

### 4. Startup stranded-wake recovery (`index.ts`)

Call `orchestrator.recoverStrandedWakes()` during broker startup **before the
socket accepts registrations**, so a broker crash mid-hibernate/wake reconciles
(complete-to-live / quarantine / requeue) before new work races the durable rows.

### 5. Worker-side wake-fence + reconnect (`client.ts` register RPC)

A woken worker's launcher exports `PINET_WAKE_*` (via `buildWakeFenceEnv`). The
client must `parseWakeFenceEnv(process.env)` and, when present, include
`wakeLeaseId / fenceToken / runtimeGeneration / reservationNonce` in its register
params so the socket-server's `enforceWakeFence` accepts the reserved generation.
Ordinary spawns set none of these and stay fence-free (backward compatible).

## Activation (only after 1–5 + review)

1. Enable in `~/.pi/agent/settings.json` slack-bridge hibernation config
   (enabled + activation flag + `allowedRepos`), rebuild `broker-core/dist`.
2. Controlled local hibernate→wake of ONE disposable broker-managed worker on
   the live mesh; verify operator surfaces stay fingerprinted, the tmux session
   survives + is attachable, and the woken worker re-registers under the same
   identity and drains its inbox.
3. Keep the `snapshot/pre-hibernation-merge` rollback tag until soaked.
