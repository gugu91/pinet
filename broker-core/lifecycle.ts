import type { AgentInfo, AgentLifecycleState, HibernateEligibility } from "./types.js";

export const AGENT_LIFECYCLE_STATES: readonly AgentLifecycleState[] = [
  "live",
  "active",
  "grace",
  "idle",
  "hibernating",
  "hibernated",
  "waking",
  "reap-candidate",
  "terminated",
];

const LEGAL_TRANSITIONS: Readonly<Record<AgentLifecycleState, readonly AgentLifecycleState[]>> = {
  live: ["active", "grace", "reap-candidate"],
  active: ["grace", "reap-candidate"],
  grace: ["active", "idle", "reap-candidate"],
  idle: ["active", "hibernating", "reap-candidate"],
  hibernating: ["active", "hibernated", "reap-candidate"],
  hibernated: ["waking", "reap-candidate"],
  waking: ["live", "reap-candidate"],
  "reap-candidate": ["live", "hibernated", "terminated"],
  terminated: [],
};

export function isLegalLifecycleTransition(
  from: AgentLifecycleState,
  to: AgentLifecycleState,
): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function assertLegalLifecycleTransition(
  from: AgentLifecycleState,
  to: AgentLifecycleState,
): void {
  if (!isLegalLifecycleTransition(from, to)) {
    throw new Error(`Illegal agent lifecycle transition: ${from} -> ${to}`);
  }
}

export function evaluateHibernateEligibility(agent: AgentInfo): HibernateEligibility {
  if (agent.hibernatePolicy === "never") return { eligible: false, reason: "policy_never" };
  if (!agent.stableId) return { eligible: false, reason: "missing_stable_id" };
  if (agent.parentAgentId || agent.supervisionState === "supervised") {
    return { eligible: false, reason: "supervised_subtree_unsupported" };
  }
  if (agent.status !== "idle") return { eligible: false, reason: "agent_working" };
  if (agent.pendingInboxCount && agent.pendingInboxCount > 0) {
    return { eligible: false, reason: "pending_inbox" };
  }
  const metadata = agent.metadata;
  if (metadata?.brokerManaged !== true) return { eligible: false, reason: "not_broker_managed" };
  if (metadata.hibernateSafe !== true) return { eligible: false, reason: "unsafe_or_unconfirmed" };
  for (const key of [
    "cwd",
    "repoRoot",
    "worktreePath",
    "tmuxSession",
    "brokerManagedBy",
  ] as const) {
    if (typeof metadata[key] !== "string" || metadata[key].trim().length === 0) {
      return { eligible: false, reason: `missing_${key}` };
    }
  }
  return { eligible: true, reason: "eligible" };
}
