import { execFileSync } from "node:child_process";
import type { AgentInfo } from "./types.js";

export type GhostReaperSignal = "SIGTERM" | "SIGKILL";

export interface ProcessSnapshot {
  pid: number;
  command: string;
  startedAt?: string | null;
}

export interface GhostReaperDeps {
  inspectProcess?: (pid: number) => ProcessSnapshot | null;
  signalProcess?: (pid: number, signal: GhostReaperSignal) => void;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  now?: () => number;
  brokerAgentId?: () => string | null;
  getAgentById?: (agentId: string) => AgentInfo | null;
}

export interface BrokerGhostReaperOptions {
  killAfterMs?: number;
}

export type GhostReapDecision =
  | { eligible: true; agentId: string; pid: number; command: string }
  | { eligible: false; agentId: string; pid?: number; reason: string };

export interface GhostReapAttempt {
  agentId: string;
  pid?: number;
  action: "sigterm" | "sigkill" | "skipped" | "pending" | "failed";
  reason?: string;
}

export interface GhostReapResult {
  attempts: GhostReapAttempt[];
  signaledAgentIds: string[];
  skippedAgentIds: string[];
}

const DEFAULT_KILL_AFTER_MS = 10_000;
const PS_LSTART_MAX_FRACTION_MS = 999;
const CLOCK_SKEW_TOLERANCE_MS = 1_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

type GhostAgentIdentity = Pick<AgentInfo, "metadata"> & Partial<Pick<AgentInfo, "stableId">>;

function isCredentialWorkerAgent(agent: GhostAgentIdentity): boolean {
  // The reserved stable-ID kind also fences rows written before principal markers existed.
  return agent.stableId?.split(":")[1] === "worker" || agent.metadata?.pinetWorkerPrincipal != null;
}

export function isBrokerManagedAgent(agent: GhostAgentIdentity): boolean {
  if (isCredentialWorkerAgent(agent)) return false;
  const metadata = asRecord(agent.metadata);
  if (!metadata) return false;
  if (metadata.brokerManaged === true) return true;
  const managed = asRecord(metadata.pinetBrokerManaged);
  return managed?.brokerManaged === true;
}

function getBrokerManagedBy(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  const direct = asString(metadata.brokerManagedBy);
  if (direct) return direct;
  const managed = asRecord(metadata.pinetBrokerManaged);
  return asString(managed?.brokerAgentId);
}

function commandLooksLikePiFollower(command: string): boolean {
  const lower = command.toLowerCase();
  return lower.includes("pi-coding-agent") || /(^|[/\s])pi(\s|$)/.test(lower);
}

function parsePsSnapshot(pid: number, output: string): ProcessSnapshot | null {
  const line = output.trim();
  if (!line) return null;
  const match = line.match(/^(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  if (!match) return null;
  const parsedPid = Number(match[1]);
  if (!Number.isFinite(parsedPid) || parsedPid !== pid) return null;
  return {
    pid: parsedPid,
    startedAt: match[2] ?? null,
    command: match[3]?.trim() ?? "",
  };
}

export function inspectProcess(pid: number): ProcessSnapshot | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const output = execFileSync(
      "ps",
      ["-p", String(pid), "-o", "pid=", "-o", "lstart=", "-o", "command="],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return parsePsSnapshot(pid, output);
  } catch {
    return null;
  }
}

function defaultSignalProcess(pid: number, signal: GhostReaperSignal): void {
  process.kill(pid, signal);
}

function parseIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function decideGhostReapEligibility(
  agent: AgentInfo,
  snapshot: ProcessSnapshot | null,
  brokerAgentId?: string | null,
  now = Date.now(),
): GhostReapDecision {
  const metadata = asRecord(agent.metadata);
  const pid = agent.pid;
  if (isCredentialWorkerAgent(agent)) {
    return { eligible: false, agentId: agent.id, reason: "credential_principal" };
  }
  if (!Number.isInteger(pid) || pid <= 1) {
    return { eligible: false, agentId: agent.id, reason: "missing_or_unsafe_pid" };
  }
  if (pid === process.pid) {
    return { eligible: false, agentId: agent.id, pid, reason: "refuse_current_process" };
  }
  if (agent.metadata?.role === "broker") {
    return { eligible: false, agentId: agent.id, pid, reason: "broker_role" };
  }
  if (!isBrokerManagedAgent(agent)) {
    return { eligible: false, agentId: agent.id, pid, reason: "not_broker_managed" };
  }
  const managedBy = getBrokerManagedBy(metadata);
  if (!brokerAgentId) {
    return { eligible: false, agentId: agent.id, pid, reason: "missing_broker_identity" };
  }
  if (!managedBy) {
    return { eligible: false, agentId: agent.id, pid, reason: "missing_broker_managed_by" };
  }
  if (managedBy !== brokerAgentId) {
    return { eligible: false, agentId: agent.id, pid, reason: "managed_by_different_broker" };
  }
  if (!agent.disconnectedAt) {
    return { eligible: false, agentId: agent.id, pid, reason: "agent_not_disconnected" };
  }
  if (!snapshot) {
    return { eligible: false, agentId: agent.id, pid, reason: "process_not_found" };
  }
  if (snapshot.pid !== pid) {
    return { eligible: false, agentId: agent.id, pid, reason: "pid_mismatch" };
  }
  if (!commandLooksLikePiFollower(snapshot.command)) {
    return { eligible: false, agentId: agent.id, pid, reason: "unexpected_command" };
  }
  const startedAtMs = parseIso(snapshot.startedAt);
  if (startedAtMs == null) {
    return { eligible: false, agentId: agent.id, pid, reason: "missing_process_start_time" };
  }
  const connectedAtMs = parseIso(agent.connectedAt);
  if (connectedAtMs == null) {
    return { eligible: false, agentId: agent.id, pid, reason: "missing_agent_connected_at" };
  }
  const disconnectedAtMs = parseIso(agent.disconnectedAt);
  if (disconnectedAtMs == null) {
    return { eligible: false, agentId: agent.id, pid, reason: "missing_agent_disconnected_at" };
  }
  if (startedAtMs + PS_LSTART_MAX_FRACTION_MS >= disconnectedAtMs) {
    return { eligible: false, agentId: agent.id, pid, reason: "pid_reused_after_disconnect" };
  }
  if (startedAtMs + PS_LSTART_MAX_FRACTION_MS >= connectedAtMs) {
    return { eligible: false, agentId: agent.id, pid, reason: "pid_reused_after_registration" };
  }
  if (disconnectedAtMs > now + CLOCK_SKEW_TOLERANCE_MS) {
    return { eligible: false, agentId: agent.id, pid, reason: "disconnect_time_in_future" };
  }

  return { eligible: true, agentId: agent.id, pid, command: snapshot.command };
}

export interface BrokerGhostReaper {
  reapGhosts: (agents: AgentInfo[]) => GhostReapResult;
  dispose: () => void;
}

export function createBrokerGhostReaper(
  deps: GhostReaperDeps = {},
  options: BrokerGhostReaperOptions = {},
): BrokerGhostReaper {
  const inspect = deps.inspectProcess ?? inspectProcess;
  const signal = deps.signalProcess ?? defaultSignalProcess;
  const schedule = deps.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel =
    deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = deps.now ?? (() => Date.now());
  const killAfterMs = options.killAfterMs ?? DEFAULT_KILL_AFTER_MS;
  const pendingKills = new Map<number, unknown>();

  function scheduleBoundedKill(agent: AgentInfo, pid: number): void {
    if (pendingKills.has(pid)) return;
    const handle = schedule(() => {
      pendingKills.delete(pid);
      const latestAgent = deps.getAgentById?.(agent.id) ?? agent;
      if (!latestAgent || latestAgent.pid !== pid) return;
      const snapshot = inspect(pid);
      const decision = decideGhostReapEligibility(
        latestAgent,
        snapshot,
        deps.brokerAgentId?.(),
        now(),
      );
      if (!decision.eligible) return;
      try {
        signal(pid, "SIGKILL");
      } catch {
        // Best effort: maintenance should never crash while cleaning up ghosts.
      }
    }, killAfterMs);
    pendingKills.set(pid, handle);
  }

  function reapGhosts(agents: AgentInfo[]): GhostReapResult {
    const attempts: GhostReapAttempt[] = [];
    const signaledAgentIds: string[] = [];
    const skippedAgentIds: string[] = [];

    for (const agent of agents) {
      const pid = Number.isInteger(agent.pid) ? agent.pid : undefined;
      if (pid != null && pendingKills.has(pid)) {
        attempts.push({
          agentId: agent.id,
          pid,
          action: "pending",
          reason: "bounded_kill_pending",
        });
        continue;
      }

      const snapshot = pid != null ? inspect(pid) : null;
      const decision = decideGhostReapEligibility(agent, snapshot, deps.brokerAgentId?.(), now());
      if (!decision.eligible) {
        skippedAgentIds.push(agent.id);
        attempts.push({ agentId: agent.id, pid, action: "skipped", reason: decision.reason });
        continue;
      }

      try {
        signal(decision.pid, "SIGTERM");
        signaledAgentIds.push(agent.id);
        attempts.push({ agentId: agent.id, pid: decision.pid, action: "sigterm" });
        scheduleBoundedKill(agent, decision.pid);
      } catch (error) {
        attempts.push({
          agentId: agent.id,
          pid: decision.pid,
          action: "failed",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { attempts, signaledAgentIds, skippedAgentIds };
  }

  function dispose(): void {
    for (const handle of pendingKills.values()) {
      cancel(handle);
    }
    pendingKills.clear();
  }

  return { reapGhosts, dispose };
}
