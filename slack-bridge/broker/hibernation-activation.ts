// Phase B live-runtime activation composition.
//
// Wires the reviewed, approved hibernation RUNTIME ADAPTERS (real process/tmux
// controllers + spawn-authored runtime-spec builder + git-remote VCS identity)
// into the broker's three live seams, all behind the DEFAULT-OFF durable,
// non-reloadable activation authority (see hibernation-activation-authority.ts;
// `hibernationRuntimeActive()`):
//
//   1. createHibernationOrchestrator  — the real orchestrator-backed executor
//      that replaces the `activation_pending` stub ONLY under the gate.
//   2. persistSpawnedRuntimeSpec      — records a durable, broker-authored
//      runtime spec (canonical git-remote VCS identity) at worker spawn.
//   3. recoverStrandedWakesBeforeRegistrations — reconciles crash-stranded wake
//      rows at broker startup, before the socket accepts new registrations.
//
// Keeping the composition here (rather than inline in index.ts / the subtree
// runtime) makes every seam unit- and E2E-testable against REAL dependencies
// (real BrokerDB, real git, real tmux/pi) with no production side effects.

import {
  HibernationOrchestrator,
  type HibernationOrchestratorConfig,
  type RuntimeLaunchContext,
  type StrandedWakeRecovery,
} from "@pinet/broker-core";
import type { AgentRuntimeSpec } from "@pinet/broker-core/types";
import type { BrokerDB } from "./schema.js";
import {
  createHibernationProcessController,
  createHibernationTmuxController,
  resolveVcsIdentity,
} from "./hibernation-runtime-adapters.js";
import {
  buildRuntimeSpecInput,
  type SpawnAuthoredRuntimeFacts,
} from "./hibernation-runtime-helpers.js";
import { hibernationActivationAuthorized } from "./hibernation-activation-authority.js";

/** Optional command runner override (git remote resolution); defaults to real `execFile`. */
type VcsRunner = Parameters<typeof resolveVcsIdentity>[1];

/**
 * The DEFAULT-OFF live-runtime gate. Live process/tmux composition happens ONLY
 * when the durable, process-lifetime activation authority — captured at broker
 * start from the external launch environment, never agent-editable settings — is
 * set. Config reloads and settings edits can NEVER flip it, so the production
 * default (authority unset) keeps the broker on the `activation_pending` stub
 * with zero live-runtime side effects. Operational permission (enabled / mode /
 * repo allowlist) is a SEPARATE settings policy enforced by the command layer;
 * this gate only decides whether the real machinery is wired in at all.
 */
export function hibernationRuntimeActive(): boolean {
  return hibernationActivationAuthorized();
}

export interface HibernationRuntimeDeps {
  db: BrokerDB;
  /** Broker owner id recorded as `brokerOwnerId`/`brokerInstanceId` on managed rows. */
  brokerInstanceId: string;
  /** slack-bridge extension entry a woken runtime loads (`pi -e <path>`). */
  extensionEntryPath: string;
  /** Base PINET_* env re-establishing the mesh connection for a woken worker. */
  baseLaunchEnv: Record<string, string>;
  /** Broker env var NAMES (never values) re-exported into a woken runtime when present. */
  inheritedEnvKeys: string[];
  config?: Partial<HibernationOrchestratorConfig>;
  /**
   * Confirm the woken runtime registered and its reserved generation was accepted.
   * PRODUCTION leaves this undefined: the orchestrator's default polls the broker
   * DB until the socket server's fenced-registration handler accepts the woken
   * worker's generation. Injectable so an isolated E2E can key acceptance off the
   * REAL respawned process coming back alive instead of a live socket handshake.
   */
  awaitRuntimeRegistration?: (ctx: RuntimeLaunchContext) => Promise<boolean>;
}

/**
 * Seam 1 — compose the real orchestrator-backed executor.
 *
 * The process and tmux controllers are constructed INDEPENDENTLY: the immutable
 * launch generation rides inside the attempt handle `respawnRuntime` returns, so
 * attempt-scoped stop/liveness bind to the exact launched process with no shared
 * registry. The returned {@link HibernationOrchestrator} structurally satisfies
 * `HibernateCommandExecutor & WakeCommandExecutor`, so it drops directly into the
 * command executor slot in place of the `activation_pending` stub — but only the
 * caller's {@link hibernationRuntimeActive} gate decides when to use it.
 */
export function createHibernationOrchestrator(
  deps: HibernationRuntimeDeps,
): HibernationOrchestrator {
  const process = createHibernationProcessController({
    pendingInboxCount: (agentId: string) => deps.db.getUnreadInboxCount(agentId),
  });
  const tmux = createHibernationTmuxController({
    extensionEntryPath: deps.extensionEntryPath,
    baseLaunchEnv: deps.baseLaunchEnv,
    inheritedEnvKeys: deps.inheritedEnvKeys,
  });
  return new HibernationOrchestrator({
    db: deps.db,
    process,
    tmux,
    brokerInstanceId: deps.brokerInstanceId,
    ...(deps.config ? { config: deps.config } : {}),
    ...(deps.awaitRuntimeRegistration
      ? { awaitRuntimeRegistration: deps.awaitRuntimeRegistration }
      : {}),
  });
}

/** Broker-authored spawn facts minus the VCS identity (derived here from the git remote). */
export type SpawnRuntimeSpecFacts = Omit<SpawnAuthoredRuntimeFacts, "vcsIdentity">;

/**
 * Seam 2 — persist a durable, broker-authored runtime spec at worker spawn.
 *
 * The canonical `owner/repo` VCS identity (the ONLY value the repo allowlist
 * authorizes against) is resolved HERE from the runtime's actual git `origin`
 * remote — never from filesystem directory names. Fails closed: an unresolvable
 * remote records `vcsIdentity: null` (the fail-closed gate then refuses), and a
 * spec that could not be safely hibernated/woken (missing session/tmux/repo
 * locators) is never written. Returns the persisted spec, or null when the facts
 * do not compose a durable spec.
 */
export async function persistSpawnedRuntimeSpec(
  db: BrokerDB,
  facts: SpawnRuntimeSpecFacts,
  runner?: VcsRunner,
): Promise<AgentRuntimeSpec | null> {
  const vcsIdentity = await resolveVcsIdentity(facts.repoRoot, runner);
  const input = buildRuntimeSpecInput({ ...facts, vcsIdentity });
  if (!input) return null;
  return db.upsertAgentRuntimeSpec(input);
}

/**
 * Seam 3 — reconcile crash-stranded wake state at broker startup.
 *
 * Must run BEFORE the broker socket accepts new registrations so a stranded
 * `waking`/`dispatching` row is completed, quarantined, or requeued deterministically
 * rather than racing an incoming (possibly duplicate) wake registration. This is a
 * synchronous DB reconciliation; it launches nothing.
 */
export function recoverStrandedWakesBeforeRegistrations(
  orchestrator: HibernationOrchestrator,
): StrandedWakeRecovery[] {
  return orchestrator.recoverStrandedWakes();
}
