import { buildAgentLifecycleStatus, type AgentLifecycleStatus } from "./hibernation-status.js";
import type { BrokerDB } from "./schema.js";
import type { AgentInfo, AgentLifecycleState } from "./types.js";

/**
 * Read-only lifecycle projection for the existing `agents`/`sessions` operator
 * read paths. Assembles the sanitized {@link AgentLifecycleStatus} for agents
 * that are in a hibernation-relevant lifecycle state, using only durable broker
 * reads. Every field is redaction-by-construction safe (see
 * {@link buildAgentLifecycleStatus} / redactRuntimeSpec): no argv, env values,
 * message bodies, tokens, or filesystem/socket paths.
 */

const HIBERNATION_RELEVANT_STATES = new Set<AgentLifecycleState>([
  "grace",
  "idle",
  "hibernating",
  "hibernated",
  "waking",
  "reap-candidate",
]);

/** True when an agent's lifecycle state is worth surfacing in operator reads. */
export function isHibernationRelevantAgent(agent: Pick<AgentInfo, "lifecycleState">): boolean {
  return HIBERNATION_RELEVANT_STATES.has(agent.lifecycleState ?? "live");
}

export interface CollectLifecycleStatusesOptions {
  now?: number;
  /** Restrict to these agent ids (e.g. the currently visible set). */
  agentIds?: string[];
  /** Include live/active agents too. Defaults false (hibernation-relevant only). */
  includeAll?: boolean;
  /** Wake capacity ceilings; when provided, capacity counters are included. */
  maxConcurrentWakes?: number;
  maxConcurrentWakesPerRepo?: number;
}

/**
 * Build lifecycle statuses from the broker DB. Pure read: performs no
 * mutations and never activates hibernation.
 */
export function collectAgentLifecycleStatuses(
  db: BrokerDB,
  options: CollectLifecycleStatusesOptions = {},
): AgentLifecycleStatus[] {
  const now = options.now ?? Date.now();
  const idFilter = options.agentIds ? new Set(options.agentIds) : null;

  const orderedWakeQueue = [...db.listWakeQueue("queued")].sort(
    (a, b) => a.priority - b.priority || a.enqueuedAt.localeCompare(b.enqueuedAt),
  );
  const recentEvents = db.getRecentAgentLifecycleEvents(undefined, 200);
  const globalInflight = db.countInflightWakes();
  const includeCapacity =
    options.maxConcurrentWakes != null && options.maxConcurrentWakesPerRepo != null;

  const statuses: AgentLifecycleStatus[] = [];
  for (const agent of db.getAllAgents()) {
    if (idFilter && !idFilter.has(agent.id)) continue;
    if (!options.includeAll && !isHibernationRelevantAgent(agent)) continue;

    const repoRootRaw = agent.metadata?.repoRoot;
    const repoRoot = typeof repoRootRaw === "string" ? repoRootRaw : null;
    const capacity = includeCapacity
      ? {
          maxConcurrentWakes: options.maxConcurrentWakes as number,
          inflightWakes: globalInflight,
          maxConcurrentWakesPerRepo: options.maxConcurrentWakesPerRepo as number,
          inflightWakesForRepo: db.countInflightWakes(repoRoot),
        }
      : undefined;

    statuses.push(
      buildAgentLifecycleStatus({
        agent,
        now,
        latestCheckpoint: db.getLatestAgentCheckpointReceipt(agent.id),
        runtimeSpec: db.getAgentRuntimeSpec(agent.id),
        orderedWakeQueue,
        recentEvents,
        capacity,
      }),
    );
  }
  return statuses;
}
