// Production hibernate/wake command router + executor composition.
//
// This is the SINGLE source of truth for how an operator `pinet hibernate` /
// `pinet wake` command resolves its authoritative DB, target worker, policy, and
// executor. It is extracted out of the extension closure so BOTH the live
// extension (`index.ts` `runHibernationCommand`) and the isolated production-route
// E2E drive the exact same integration code — the code that fixed the DB-topology
// and activation-authority seams — rather than re-composing the pieces by hand.
//
// The design invariants this router encodes (each has a negative regression test):
//
//   • Activation is authorized ONLY by the durable, non-reloadable, frozen
//     broker-start authority (`hibernationRuntimeActive()`), never by reloadable
//     settings. A settings reload can NEVER flip a running broker on.
//   • When active, the SUBTREE broker is the authority: it spawned and OWNS these
//     workers and authored their durable runtime specs, so target resolution, the
//     authz spec read, AND the orchestrator all run against that SAME subtree DB
//     (`getRuntimeControl().db`) — never the central broker DB.
//   • When inactive (production default) there is no runtime control, so resolution
//     falls back to the central DB and the executor stays the `activation_pending`
//     stub: a clear refusal, never a silent no-op.
//   • The repo allowlist is a security boundary authorized ONLY against the
//     broker-authored spec's canonical `owner/repo` VCS identity (captured at spawn
//     from the git remote), never a filesystem path slug or worker-declared metadata.

import {
  executeHibernateCommand,
  executeWakeCommand,
  unknownHibernationTarget,
  type HibernateCommandExecutor,
  type HibernationCommandPolicy,
  type HibernationCommandResult,
  type RuntimeLaunchContext,
  type WakeCommandExecutor,
} from "@pinet/broker-core";
import type { AgentInfo, AgentLifecycleState } from "@pinet/broker-core/types";
import type { BrokerDB } from "./schema.js";
import type { ResolvedHibernationSettings } from "../hibernation-config.js";
import {
  createHibernationOrchestrator,
  hibernationRuntimeActive,
} from "./hibernation-activation.js";

/**
 * The authoritative runtime-control surface the command path binds to when runtime
 * activation is active. Structurally identical to the subtree broker's
 * `SubtreeHibernationRuntimeControl`; kept here so the router has no import
 * dependency on the extension wiring and stays independently testable.
 */
export interface HibernationRuntimeControl {
  /** The ONE authoritative DB that owns the spawned workers + their specs. */
  db: BrokerDB;
  /** Broker instance id recorded on lifecycle leases; matches startup recovery. */
  brokerInstanceId: string;
  /** Base PINET_* env re-establishing the mesh connection for a woken worker. */
  baseLaunchEnv: Record<string, string>;
}

export interface RouteHibernationCommandInput {
  command: "hibernate" | "wake";
  target: string;
  reason?: string;
  /** Must be "broker"; any other role (or null) rejects (this session is not the broker). */
  brokerRole: string | null;
  /** Operational policy (enabled/mode/allowlist) — SEPARATE from runtime activation. */
  hib: ResolvedHibernationSettings;
  /**
   * Real accessor for the subtree broker's authoritative control surface. Invoked
   * only when the frozen activation authority is set; returns null when no subtree
   * broker is running (nothing is command-addressable).
   */
  getRuntimeControl: () => HibernationRuntimeControl | null;
  /** Central broker DB, used ONLY as the default-off fallback (never when active). */
  getFallbackDb: () => BrokerDB | null;
  /** slack-bridge extension entry a woken runtime loads (`pi -e <path>`). */
  extensionEntryPath: string;
  /** Broker env var NAMES (never values) re-exported into a woken runtime. */
  inheritedEnvKeys: string[];
  /**
   * Socket-registration RPC stand-in. PRODUCTION leaves this undefined so the
   * orchestrator's default polls the broker DB until the socket server's fenced
   * handler accepts the woken worker's generation. Injectable so an isolated E2E
   * can key acceptance off the REAL respawned process instead of a live handshake.
   */
  awaitRuntimeRegistration?: (ctx: RuntimeLaunchContext) => Promise<boolean>;
}

/**
 * Resolve and run one hibernate/wake command exactly as the live extension does.
 *
 * Ordering matters and is asserted by regression tests: activation is read from
 * the frozen authority FIRST, which decides whether the authoritative DB is the
 * subtree control DB or the central fallback, which decides whether the real
 * orchestrator or the `activation_pending` stub is composed.
 */
export async function routeHibernationCommand(
  input: RouteHibernationCommandInput,
): Promise<HibernationCommandResult> {
  const { command, target, reason, brokerRole, hib } = input;
  if (brokerRole !== "broker") {
    throw new Error(
      `pinet ${command} is broker-managed. Connect this session as the broker (/pinet start) to hibernate or wake workers.`,
    );
  }

  // Authoritative DB unification + explicit trust boundary. When the durable,
  // non-reloadable runtime-activation authority is set, the SUBTREE broker owns
  // these workers AND authored their durable runtime specs, so hibernate/wake must
  // resolve the target, read its authz spec, AND drive the orchestrator against
  // that SAME subtree DB end to end. The operator may therefore only address
  // workers this process's subtree broker owns. In the default-off configuration
  // there is no runtime control, so resolution falls back to the central broker DB
  // and the executor stays the `activation_pending` stub (a clear refusal, never a
  // silent no-op).
  const runtimeControl = hibernationRuntimeActive() ? input.getRuntimeControl() : null;
  const db = runtimeControl?.db ?? input.getFallbackDb();
  if (!db) throw new Error("Broker database is unavailable.");

  const wanted = target.trim().replace(/^@/, "");
  const agents = db.getAllAgents();
  const lowerWanted = wanted.toLowerCase();
  const nameMatches = agents.filter((a: AgentInfo) => a.name?.toLowerCase() === lowerWanted);
  const agent =
    agents.find((a: AgentInfo) => a.id === wanted) ??
    agents.find((a: AgentInfo) => a.stableId === wanted) ??
    (nameMatches.length === 1 ? nameMatches[0] : undefined);
  if (!agent) return unknownHibernationTarget(command, target);

  const policy: HibernationCommandPolicy = {
    enabled: hib.enabled,
    mode: hib.mode,
    allowedRepos: hib.allowedRepos,
  };
  const state = (agent.lifecycleState ?? "live") as AgentLifecycleState;
  // Provenance: the repo allowlist is a security boundary, so authorization trusts
  // ONLY the broker-authored durable runtime spec's CANONICAL VCS IDENTITY
  // (`owner/repo`), captured at spawn from the runtime's git remote. Ownership is
  // NEVER inferred from filesystem directory names or worker-declared metadata.
  // When no trusted spec / resolvable remote exists the identifier stays null and
  // the fail-closed gate refuses.
  const repoIdentifier = db.getAgentRuntimeSpec(agent.id)?.vcsIdentity ?? null;

  // Live process/tmux checkpoint/respawn adapters are a separate, explicitly gated
  // activation step (default-off). When runtime activation is unset `runtimeControl`
  // is null and callers get a clear `activation_pending` refusal rather than a
  // silent no-op. When set, the real process/tmux HibernationOrchestrator is
  // composed over the SAME subtree DB that owns the worker and its spec, with
  // `brokerInstanceId` matching the spawn/startup-recovery owner so lease fencing
  // lines up. The woken worker's respawn env is the subtree broker's child-launch
  // env; inherited secret var NAMES come from the shared spawn/wake allowlist.
  const executor: HibernateCommandExecutor & WakeCommandExecutor = runtimeControl
    ? createHibernationOrchestrator({
        db: runtimeControl.db,
        brokerInstanceId: runtimeControl.brokerInstanceId,
        extensionEntryPath: input.extensionEntryPath,
        baseLaunchEnv: runtimeControl.baseLaunchEnv,
        inheritedEnvKeys: input.inheritedEnvKeys,
        config: {
          handshakeTimeoutMs: hib.handshakeTimeoutMs,
          wakeLeaseMs: hib.wakeLeaseMs,
          maxConcurrentWakes: hib.maxConcurrentWakes,
          maxConcurrentWakesPerRepo: hib.maxConcurrentWakesPerRepo,
        },
        ...(input.awaitRuntimeRegistration
          ? { awaitRuntimeRegistration: input.awaitRuntimeRegistration }
          : {}),
      })
    : {
        prepareHibernation: () => ({ ready: false, state, reason: "activation_pending" }),
        hibernate: async () => ({ ok: false, state, reason: "activation_pending" }),
        wake: async () => ({ ok: false, state, reason: "activation_pending" }),
      };

  if (command === "hibernate") {
    return executeHibernateCommand({
      executor,
      agentId: agent.id,
      state,
      repoIdentifier,
      policy,
      actor: "operator",
      reason,
    });
  }
  return executeWakeCommand({
    executor,
    agentId: agent.id,
    state,
    policy,
    actor: "operator",
    reason,
  });
}
