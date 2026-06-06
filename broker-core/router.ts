import { DEFAULT_EXTERNAL_THREAD_SOURCE } from "./types.js";
import type { AgentInfo, BrokerDBInterface, InboundMessage, RoutingDecision } from "./types.js";

// ─── Helpers ─────────────────────────────────────────────

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildPinetOwnerToken(stableId: string): string {
  const primary = hashString(stableId).toString(16).padStart(8, "0");
  const secondary = hashString(`${stableId}:owner`).toString(16).padStart(8, "0");
  return `owner:${primary}${secondary}`;
}

export interface ThreadOwnerHint {
  agentId?: string;
  stableId?: string;
  agentOwner?: string;
  agentName?: string;
}

export type ExplicitThreadDirective =
  | { kind: "stand_down"; agent: AgentInfo }
  | { kind: "retarget"; agent: AgentInfo };

interface AgentMentionCandidate {
  agent: AgentInfo;
  term: string;
}

const THREAD_STAND_DOWN_REGEX = /\bstand down\b/i;
const THREAD_RETARGET_REGEX =
  /\b(?:take over|pick (?:this|it) up|pick this up|pick it up|handle this|grab this|you take this|reassign(?: this)?(?: to)?|switch(?: this)?(?: to)?|move(?: this)?(?: to)?|route(?: this)?(?: to)?|transfer(?: this)?(?: to)?|pass(?: this)?(?: to)?|hand(?: this)?(?: to)?|give(?: this)?(?: to)?)\b/i;

/**
 * Extract an agent name mention from message text.
 * Matches patterns like "hey AgentName," or "@AgentName" or just "AgentName"
 * at word boundaries (case-insensitive).
 *
 * When multiple agents match, the longest name wins so that "CodeBot" is
 * preferred over "Code" and similar-prefix collisions are avoided.
 */
export function findAgentMention(text: string, agents: AgentInfo[]): AgentInfo | null {
  return findBestAgentMention(text, buildAgentMentionCandidates(agents, false));
}

export function extractPiAgentThreadOwnerHint(
  replies: ReadonlyArray<Record<string, unknown>>,
): ThreadOwnerHint | null {
  for (let index = replies.length - 1; index >= 0; index -= 1) {
    const message = replies[index];
    if (!message.bot_id) continue;
    const metadata = message.metadata as
      | {
          event_type?: string;
          event_payload?: { agent?: string; agent_owner?: string };
        }
      | undefined;
    if (metadata?.event_type !== "pi_agent_msg") continue;

    const agentOwner =
      typeof metadata.event_payload?.agent_owner === "string" &&
      metadata.event_payload.agent_owner.trim().length > 0
        ? metadata.event_payload.agent_owner.trim()
        : undefined;
    const agentName =
      typeof metadata.event_payload?.agent === "string" &&
      metadata.event_payload.agent.trim().length > 0
        ? metadata.event_payload.agent.trim()
        : undefined;

    if (agentOwner || agentName) {
      return {
        ...(agentOwner ? { agentOwner } : {}),
        ...(agentName ? { agentName } : {}),
      };
    }
  }
  return null;
}

export function findExplicitThreadDirective(
  text: string,
  agents: AgentInfo[],
): ExplicitThreadDirective | null {
  if (!THREAD_STAND_DOWN_REGEX.test(text) && !THREAD_RETARGET_REGEX.test(text)) {
    return null;
  }

  const mention = findBestAgentMention(text, buildAgentMentionCandidates(agents, true));
  if (!mention) return null;

  if (THREAD_STAND_DOWN_REGEX.test(text)) {
    return { kind: "stand_down", agent: mention };
  }

  if (THREAD_RETARGET_REGEX.test(text)) {
    return { kind: "retarget", agent: mention };
  }

  return null;
}

function buildAgentMentionCandidates(
  agents: AgentInfo[],
  includeUniqueTailAlias: boolean,
): AgentMentionCandidate[] {
  const candidates: AgentMentionCandidate[] = [];
  const tailCounts = new Map<string, number>();

  for (const agent of agents) {
    const tail = getAgentTailAlias(agent.name);
    if (tail) {
      tailCounts.set(tail, (tailCounts.get(tail) ?? 0) + 1);
    }
  }

  for (const agent of agents) {
    if (agent.name.trim()) {
      candidates.push({ agent, term: agent.name.trim() });
    }

    if (!includeUniqueTailAlias) continue;
    const tail = getAgentTailAlias(agent.name);
    if (!tail || tailCounts.get(tail) !== 1) continue;
    candidates.push({ agent, term: tail });
  }

  return candidates;
}

function getAgentTailAlias(name: string): string | null {
  const tokens = name
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const tail = tokens.at(-1)?.toLowerCase() ?? "";
  return tail.length >= 4 ? tail : null;
}

function findBestAgentMention(text: string, candidates: AgentMentionCandidate[]): AgentInfo | null {
  const lower = text.toLowerCase();
  let bestMatch: AgentInfo | null = null;
  let bestLength = 0;

  for (const candidate of candidates) {
    const term = candidate.term.toLowerCase();
    if (!term) continue;
    const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, "i");
    if (pattern.test(lower) && term.length > bestLength) {
      bestMatch = candidate.agent;
      bestLength = term.length;
    }
  }

  return bestMatch;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeThreadOwnerHint(
  metadata: Record<string, unknown> | undefined,
): ThreadOwnerHint | null {
  const embeddedHint =
    metadata?.threadOwnerHint &&
    typeof metadata.threadOwnerHint === "object" &&
    !Array.isArray(metadata.threadOwnerHint)
      ? (metadata.threadOwnerHint as Record<string, unknown>)
      : undefined;

  const agentId = asNonEmptyString(embeddedHint?.agentId ?? metadata?.threadOwnerAgentId);
  const stableId = asNonEmptyString(embeddedHint?.stableId ?? metadata?.threadOwnerStableId);
  const agentOwner = asNonEmptyString(embeddedHint?.agentOwner ?? metadata?.threadOwnerAgentOwner);
  const agentName = asNonEmptyString(embeddedHint?.agentName ?? metadata?.threadOwnerAgentName);
  const hint: ThreadOwnerHint = {
    ...(agentId ? { agentId } : {}),
    ...(stableId ? { stableId } : {}),
    ...(agentOwner ? { agentOwner } : {}),
    ...(agentName ? { agentName } : {}),
  };

  return Object.keys(hint).length > 0 ? hint : null;
}

function resolveAgentFromThreadOwnerHint(
  metadata: Record<string, unknown> | undefined,
  agents: AgentInfo[],
): AgentInfo | null {
  const hint = normalizeThreadOwnerHint(metadata);
  if (!hint) return null;

  if (hint.agentId) {
    const idMatch = agents.find((agent) => agent.id === hint.agentId);
    if (idMatch) return idMatch;
  }

  if (hint.stableId) {
    const stableMatch = agents.find((agent) => agent.stableId === hint.stableId);
    if (stableMatch) return stableMatch;
  }

  if (hint.agentOwner) {
    const ownerMatch = agents.find(
      (agent) => agent.stableId && buildPinetOwnerToken(agent.stableId) === hint.agentOwner,
    );
    if (ownerMatch) return ownerMatch;
  }

  if (!hint.agentName) {
    return null;
  }

  return findBestAgentMention(hint.agentName, buildAgentMentionCandidates(agents, false));
}

function resolveRoutableThreadOwner(
  db: BrokerDBInterface,
  threadOwnerAgentId: string | null,
  now = new Date().toISOString(),
): AgentInfo | null {
  if (!threadOwnerAgentId) return null;

  const owner = db.getAgentById(threadOwnerAgentId);
  if (owner && isRoutableOwner(owner, now)) {
    return owner;
  }

  if (!owner) {
    const reconnectedOwner = db.getAgentByStableId(threadOwnerAgentId);
    if (
      reconnectedOwner &&
      reconnectedOwner.id !== threadOwnerAgentId &&
      isRoutableOwner(reconnectedOwner, now)
    ) {
      return reconnectedOwner;
    }
  }

  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRoutableOwner(agent: AgentInfo, now = new Date().toISOString()): boolean {
  if (!agent.disconnectedAt) return true;
  return agent.resumableUntil != null && agent.resumableUntil > now;
}

// ─── MessageRouter ───────────────────────────────────────

export class MessageRouter {
  private readonly db: BrokerDBInterface;

  constructor(db: BrokerDBInterface) {
    this.db = db;
  }

  /**
   * Route an inbound message to the right agent.
   *
   * Priority order:
   * 1. User allowlist — reject if user not allowed
   * 2. Explicit thread control — stand-down / reassignment signals in-thread
   * 3. Known-thread ownership — authoritative owner hint, then broker DB owner
   * 4. New-thread channel assignment / direct address
   * 5. Unrouted — no match found
   */
  route(msg: InboundMessage): RoutingDecision {
    // 0. Check user allowlist
    const allowedUsers = this.db.getAllowedUsers();
    if (allowedUsers !== null && !allowedUsers.has(msg.userId)) {
      return { action: "reject", reason: "User not in allowlist" };
    }

    const agents = this.db.getAgents();
    const thread = this.db.getThread(msg.threadId);
    const explicitDirective = findExplicitThreadDirective(msg.text, agents);

    if (explicitDirective) {
      if (thread) {
        if (explicitDirective.kind === "retarget") {
          this.db.updateThread(msg.threadId, {
            ownerAgent: explicitDirective.agent.id,
            ownerBinding: "explicit",
            channel: msg.channel,
            source: msg.source,
          });
        }
        return { action: "deliver", agentId: explicitDirective.agent.id };
      }
    }

    if (thread) {
      if (thread.ownerBinding === "explicit") {
        const explicitOwner = resolveRoutableThreadOwner(this.db, thread.ownerAgent);
        if (explicitOwner) {
          if (thread.ownerAgent !== explicitOwner.id) {
            this.db.updateThread(msg.threadId, { ownerAgent: explicitOwner.id });
          }
          return { action: "deliver", agentId: explicitOwner.id };
        }

        if (thread.ownerAgent !== null) {
          this.db.updateThread(msg.threadId, { ownerAgent: null });
        }

        // Explicit takeovers stay authoritative for the thread. If that owner is
        // unavailable later, require another explicit retarget instead of snapping
        // back to a stale historical adapter owner hint.
        return { action: "unrouted" };
      }

      if (thread.ownerAgent) {
        const owner = resolveRoutableThreadOwner(this.db, thread.ownerAgent);
        if (owner) {
          if (thread.ownerAgent !== owner.id) {
            this.db.updateThread(msg.threadId, { ownerAgent: owner.id });
          }
          return { action: "deliver", agentId: owner.id };
        }

        // Owner is gone or no longer routable — clear ownership and stop. Known
        // transport-thread replies must not leak to another worker through latest
        // adapter owner hints or channel-assignment fallback; a human must
        // explicitly retarget the thread if the owner is unavailable.
        this.db.updateThread(msg.threadId, { ownerAgent: null });
        return { action: "unrouted" };
      }

      const hintedOwner = resolveAgentFromThreadOwnerHint(msg.metadata, agents);
      if (hintedOwner && isRoutableOwner(hintedOwner)) {
        this.db.updateThread(msg.threadId, { ownerAgent: hintedOwner.id, channel: msg.channel });
        return { action: "deliver", agentId: hintedOwner.id };
      }

      const mentioned = findAgentMention(msg.text, agents);
      if (mentioned) {
        const claimed = this.db.claimThread(msg.threadId, mentioned.id, msg.source, msg.channel);
        if (claimed) {
          return { action: "deliver", agentId: mentioned.id };
        }

        const claimedThread = this.db.getThread(msg.threadId);
        const claimedOwner = resolveRoutableThreadOwner(this.db, claimedThread?.ownerAgent ?? null);
        if (claimedOwner) {
          return { action: "deliver", agentId: claimedOwner.id };
        }
      }

      return { action: "unrouted" };
    }

    // New thread / top-level message: channel assignment can still steer work.
    // Persist that assignment as thread ownership so later generic replies in
    // the same transport thread route back to the same agent without another
    // manual broker/human assignment. Existing known threads stay protected by
    // the `thread` branch above and do not fall back to channel assignment.
    const assignment = this.db.getChannelAssignment(msg.channel);
    if (assignment) {
      const assigned = agents.find((agent) => agent.id === assignment.agentId);
      if (assigned) {
        const claimed = this.db.claimThread(msg.threadId, assigned.id, msg.source, msg.channel);
        if (claimed) {
          return { action: "deliver", agentId: assigned.id };
        }

        const claimedThread = this.db.getThread(msg.threadId);
        const claimedOwner = resolveRoutableThreadOwner(this.db, claimedThread?.ownerAgent ?? null);
        if (claimedOwner) {
          return { action: "deliver", agentId: claimedOwner.id };
        }
      }
    }

    const mentioned = findAgentMention(msg.text, agents);
    if (mentioned) {
      const claimed = this.db.claimThread(msg.threadId, mentioned.id, msg.source, msg.channel);
      if (claimed) {
        return { action: "deliver", agentId: mentioned.id };
      }

      const claimedThread = this.db.getThread(msg.threadId);
      const claimedOwner = resolveRoutableThreadOwner(this.db, claimedThread?.ownerAgent ?? null);
      if (claimedOwner) {
        return { action: "deliver", agentId: claimedOwner.id };
      }
    }

    return { action: "unrouted" };
  }

  /**
   * Claim a thread for an agent (first-responder-wins).
   * Optionally provide the transport source and channel to store when creating
   * a new thread. Defaults to a neutral external source when callers do not
   * provide one; Slack call sites should continue passing `source: "slack"`
   * explicitly through inbound messages or compatibility wrappers.
   * Returns true if the claim succeeded, false if another agent already owns it.
   *
   * Delegates to the DB layer which performs the claim atomically
   * (single SQL statement) to avoid TOCTOU races. (#125)
   */
  claimThread(
    threadId: string,
    agentId: string,
    channel?: string,
    source = DEFAULT_EXTERNAL_THREAD_SOURCE,
  ): boolean {
    return this.db.claimThread(threadId, agentId, source, channel ?? "");
  }

  /**
   * Get the owner of a thread, or null if unclaimed / nonexistent.
   */
  getThreadOwner(threadId: string): string | null {
    const thread = this.db.getThread(threadId);
    return thread?.ownerAgent ?? null;
  }

  /**
   * List available (connected) agents for routing.
   */
  getAvailableAgents(): AgentInfo[] {
    return this.db.getAgents();
  }
}
