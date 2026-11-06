import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveCommand } from "@pinet/transport-core/commands";

export function defaultLockPath(): string {
  return path.join(os.homedir(), ".pi", "pinet-broker.lock");
}

// ─── Lock owner identity ─────────────────────────────────

/**
 * Identity of the process recorded in the broker leader lock.
 *
 * Legacy locks (written by older builds) contain only a PID; structured locks
 * additionally record the owner's process start time, a per-acquisition
 * instance id, hostname, and creation timestamp so a second session can tell
 * a live owner apart from a reused PID.
 */
export interface BrokerLockOwner {
  pid: number;
  processStartTime: string | null;
  instanceId: string | null;
  hostname: string | null;
  createdAt: string | null;
  /** True when the lock file only contained a bare PID (older builds). */
  legacy: boolean;
}

export type BrokerLockInspection =
  /** No lock file exists. */
  | { state: "none"; owner: null }
  /** Lock file exists but cannot be parsed — safe to reclaim. */
  | { state: "unreadable"; owner: null }
  /** Recorded PID is no longer running — safe to reclaim. */
  | { state: "stale-dead"; owner: BrokerLockOwner }
  /**
   * Recorded PID is running but its process start time differs from the one
   * recorded at lock creation — the PID was reused by an unrelated process,
   * so the lock is stale and safe to reclaim.
   */
  | { state: "stale-pid-reused"; owner: BrokerLockOwner; currentStartTime: string }
  /** Recorded PID is running and not provably stale. */
  | { state: "alive"; owner: BrokerLockOwner };

/** Injectable process probes (for tests). */
export interface BrokerLockProbes {
  isProcessRunning?: (pid: number) => boolean;
  getProcessStartTime?: (pid: number) => string | null;
}

/**
 * Deterministically capture a process's start time for PID-reuse detection.
 *
 * Uses `/proc/<pid>/stat` (field 22, clock ticks since boot) on Linux and
 * `LC_ALL=C ps -p <pid> -o lstart=` elsewhere. Values are only ever compared
 * for exact equality against a value captured by this same function, so the
 * format does not need to be parseable — only stable for a given process.
 *
 * On Linux the tick count is only unique within a single boot, so it is
 * scoped with the kernel boot id: a PID reused after a reboot can then never
 * present the same identity as the pre-reboot owner. `ps lstart` has
 * one-second resolution, so a PID reused within the same wall-clock second
 * as the original process is indistinguishable — an accepted residual risk.
 *
 * Returns null when the start time cannot be determined; callers must treat
 * null as "unknown" and never use it as evidence of staleness.
 */
export function getProcessStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      // comm (field 2) may contain spaces/parens — start after the last ")".
      const closeParen = stat.lastIndexOf(")");
      if (closeParen !== -1) {
        const fields = stat
          .slice(closeParen + 1)
          .trim()
          .split(/\s+/);
        // Fields after comm+state start at index 1 here; starttime is overall
        // field 22, i.e. index 19 of the post-state remainder.
        const startTime = fields[19];
        if (startTime && /^\d+$/.test(startTime)) {
          // starttime is measured in clock ticks since boot — scope it with
          // the boot id so identities never collide across reboots.
          let bootId = "";
          try {
            bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
          } catch {
            /* boot id unavailable — token stays valid within this boot */
          }
          return bootId ? `${bootId}:${startTime}` : startTime;
        }
      }
    } catch {
      /* fall through to ps */
    }
  }

  try {
    const output = execFileSync(resolveCommand("ps"), ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf-8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      timeout: 2000,
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

// ─── Lock file parsing ───────────────────────────────────

interface StructuredLockMetadata {
  processStartTime: string | null;
  instanceId: string | null;
  hostname: string | null;
  createdAt: string | null;
}

/** Serialized wire shape of the lock metadata line — field types unverified. */
interface RawLockMetadata {
  processStartTime?: string | null;
  instanceId?: string | null;
  hostname?: string | null;
  createdAt?: string | null;
}

function readMetadataString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parseLockContent(content: string): BrokerLockOwner | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const newlineIndex = trimmed.indexOf("\n");
  const pidLine = (newlineIndex === -1 ? trimmed : trimmed.slice(0, newlineIndex)).trim();
  if (!/^\d+$/.test(pidLine)) return null;
  const pid = parseInt(pidLine, 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;

  if (newlineIndex === -1) {
    return {
      pid,
      processStartTime: null,
      instanceId: null,
      hostname: null,
      createdAt: null,
      legacy: true,
    };
  }

  let metadata: StructuredLockMetadata | null = null;
  try {
    const raw = JSON.parse(trimmed.slice(newlineIndex + 1).trim()) as RawLockMetadata;
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      metadata = {
        processStartTime: readMetadataString(raw.processStartTime),
        instanceId: readMetadataString(raw.instanceId),
        hostname: readMetadataString(raw.hostname),
        createdAt: readMetadataString(raw.createdAt),
      };
    }
  } catch {
    metadata = null;
  }
  return {
    pid,
    processStartTime: metadata?.processStartTime ?? null,
    instanceId: metadata?.instanceId ?? null,
    hostname: metadata?.hostname ?? null,
    createdAt: metadata?.createdAt ?? null,
    legacy: metadata === null,
  };
}

/**
 * Read the current broker lock owner, or null when no lock file exists or it
 * cannot be parsed.
 */
export function readBrokerLockOwner(lockPath?: string): BrokerLockOwner | null {
  const resolved = lockPath ?? defaultLockPath();
  let content: string;
  try {
    content = fs.readFileSync(resolved, "utf-8");
  } catch {
    return null;
  }
  return parseLockContent(content);
}

/**
 * Inspect the broker leader lock and classify its owner.
 *
 * `stale-pid-reused` is only reported when both the recorded and current
 * process start times are known and differ; unknown start times classify as
 * `alive` so uncertainty never reclaims a live broker's lock.
 */
export function inspectBrokerLock(
  lockPath?: string,
  probes: BrokerLockProbes = {},
): BrokerLockInspection {
  const resolved = lockPath ?? defaultLockPath();
  let content: string;
  try {
    content = fs.readFileSync(resolved, "utf-8");
  } catch {
    return { state: "none", owner: null };
  }

  const owner = parseLockContent(content);
  if (!owner) {
    return { state: "unreadable", owner: null };
  }

  const isRunning = probes.isProcessRunning ?? isProcessRunning;
  if (!isRunning(owner.pid)) {
    return { state: "stale-dead", owner };
  }

  if (owner.processStartTime) {
    const startTimeOf = probes.getProcessStartTime ?? getProcessStartTime;
    const currentStartTime = startTimeOf(owner.pid);
    if (currentStartTime && currentStartTime !== owner.processStartTime) {
      return { state: "stale-pid-reused", owner, currentStartTime };
    }
  }

  return { state: "alive", owner };
}

/**
 * Atomically create `filePath` with `content` already in place, failing when
 * the path exists. A plain `writeFileSync("wx")` opens the file and then
 * writes, so concurrent readers can observe an empty just-created file;
 * writing a private temp file and `link()`ing it into place makes the path
 * appear with its full content in one exclusive step.
 */
function exclusiveCreateFile(filePath: string, content: string): boolean {
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.linkSync(tmpPath, filePath);
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* best effort */
    }
  }
}

// ─── Leader lock ─────────────────────────────────────────

/**
 * Leader election via lock file.
 *
 * Only one broker process should run at a time. The leader creates the lock
 * file with an exclusive create (`O_CREAT | O_EXCL`), writing its PID on the
 * first line (kept legacy-compatible so older builds still see a live owner)
 * followed by a JSON metadata line recording process start time and a
 * per-acquisition instance id.
 *
 * Exclusive creation is the only way the lock comes into existence, so
 * simultaneous contenders on an empty path get exactly one winner from the
 * kernel. Stale locks (dead PID, reused PID, unreadable content) are only
 * ever unlinked while holding an exclusively-created reclaim mutex file,
 * with staleness re-verified under that mutex — so a fresh lock can never be
 * destroyed by a concurrent reclaimer, and the lock path never goes empty
 * while a live owner's lock exists.
 *
 * Known mixed-version limitation: builds that predate the structured format
 * replace a lock they consider stale with a plain rename over the lock path,
 * which can overwrite a just-acquired v2 lock when an old and a new build
 * race over the same stale lock. Exclusive acquisition is therefore only
 * guaranteed among processes running this code; the window disappears once
 * no pre-v2 sessions remain. A representation old builds cannot overwrite
 * (such as a lock directory) would also break their ability to read the
 * owner PID, which this format deliberately preserves.
 */
export class LeaderLock {
  private readonly lockPath: string;
  private readonly probes: BrokerLockProbes;
  private acquired = false;
  private instanceId: string | null = null;

  constructor(lockPath?: string, probes: BrokerLockProbes = {}) {
    this.lockPath = lockPath ?? defaultLockPath();
    this.probes = probes;
  }

  /**
   * Try to acquire the lock. Returns true if this process is now the leader.
   */
  tryAcquire(): boolean {
    if (this.acquired) return true;

    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });

    // Two passes: exclusive create, and one stale-reclaim + retry.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.tryExclusiveCreate()) {
        return true;
      }

      const inspection = inspectBrokerLock(this.lockPath, this.probes);
      if (inspection.state === "alive") {
        // Another live process holds the lock.
        return false;
      }
      if (inspection.state === "none") {
        // The holder released between our create attempt and inspection.
        continue;
      }
      if (!this.reclaimStaleLock()) {
        // The lock is no longer stale, or another contender is reclaiming
        // it. Back off conservatively.
        return false;
      }
    }
    return false;
  }

  /**
   * Create the lock file exclusively. Returns true when this process now
   * holds the lock; false when another lock file already exists.
   */
  private tryExclusiveCreate(): boolean {
    const pid = process.pid;
    const instanceId = crypto.randomUUID();
    const startTimeOf = this.probes.getProcessStartTime ?? getProcessStartTime;
    const metadata: StructuredLockMetadata & { version: number } = {
      version: 2,
      processStartTime: startTimeOf(pid),
      instanceId,
      hostname: os.hostname(),
      createdAt: new Date().toISOString(),
    };
    const content = `${pid}\n${JSON.stringify(metadata)}\n`;
    // Exclusive create with full content — the kernel picks exactly one
    // winner among simultaneous contenders, and no reader can ever observe a
    // partially-written lock.
    if (!exclusiveCreateFile(this.lockPath, content)) {
      return false;
    }

    // Paranoia read-back: if the file somehow no longer records our identity,
    // treat the acquisition as lost and leave the file to its current owner.
    const written = readBrokerLockOwner(this.lockPath);
    if (!written || written.pid !== pid || written.instanceId !== instanceId) {
      return false;
    }

    this.acquired = true;
    this.instanceId = instanceId;
    return true;
  }

  /**
   * Remove a stale lock under an exclusive reclaim mutex.
   *
   * The mutex file (`<lockPath>.reclaim`) is created with `O_EXCL` and
   * records the reclaimer's PID plus start identity, so at most one
   * reclaimer proceeds at a time, and staleness is re-verified while holding
   * it. Because stale locks are only ever unlinked under this mutex, the
   * lock path cannot go empty while a live owner's lock exists — which is
   * what makes the exclusive create in `tryAcquire` a sound arbiter. A mutex
   * left behind by a crashed reclaimer (dead PID, or a PID provably reused
   * by an unrelated process) is itself reclaimed.
   *
   * Returns true when the caller may retry an exclusive create.
   */
  private reclaimStaleLock(): boolean {
    const mutexPath = `${this.lockPath}.reclaim`;
    const isRunning = this.probes.isProcessRunning ?? isProcessRunning;
    const startTimeOf = this.probes.getProcessStartTime ?? getProcessStartTime;

    let holdsMutex = false;
    for (let campaign = 0; campaign < 2 && !holdsMutex; campaign++) {
      if (exclusiveCreateFile(mutexPath, `${process.pid}\n${startTimeOf(process.pid) ?? ""}\n`)) {
        holdsMutex = true;
      } else {
        // Mutex exists — held by a live reclaimer, or left by a crashed one.
        let holderRaw: string;
        try {
          holderRaw = fs.readFileSync(mutexPath, "utf-8").trim();
        } catch {
          continue; // vanished — retry the campaign
        }
        const [pidLine = "", startLine = ""] = holderRaw.split("\n");
        const holderPid = /^\d+$/.test(pidLine.trim()) ? parseInt(pidLine.trim(), 10) : null;
        const recordedStart = startLine.trim();
        if (holderPid !== null && holderPid > 0 && isRunning(holderPid)) {
          // The PID is live, but it may be an unrelated process that reused
          // a crashed reclaimer's PID. Back off unless the recorded start
          // identity provably belongs to a different process — uncertainty
          // always means "assume the reclaimer is alive".
          const currentStart = startTimeOf(holderPid);
          if (!recordedStart || currentStart === null || currentStart === recordedStart) {
            return false; // a live reclaimer is working — back off
          }
        }
        // Crashed reclaimer. Remove its mutex only if it still records the
        // dead holder we just read, then retry the campaign.
        try {
          if (fs.readFileSync(mutexPath, "utf-8").trim() === holderRaw) {
            fs.unlinkSync(mutexPath);
          }
        } catch {
          /* already gone */
        }
      }
    }
    if (!holdsMutex) return false;

    try {
      // Re-verify staleness while holding the mutex. We are now the only
      // process allowed to unlink the lock, so no fresh lock can be created
      // (the path stays occupied) until we decide.
      const current = inspectBrokerLock(this.lockPath, this.probes);
      if (current.state === "alive") {
        return false;
      }
      if (current.state !== "none") {
        try {
          fs.unlinkSync(this.lockPath);
        } catch {
          /* already gone */
        }
      }
      return true;
    } finally {
      try {
        fs.unlinkSync(mutexPath);
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Release the lock if we hold it.
   */
  release(): void {
    if (!this.acquired) return;

    try {
      // Only remove the lock when it still records THIS acquisition — PID
      // alone is not enough, because a later broker instance in the same
      // process may have legitimately re-acquired with a new instance id.
      const owner = readBrokerLockOwner(this.lockPath);
      if (owner && owner.pid === process.pid && owner.instanceId === this.instanceId) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // Best-effort cleanup
    }

    this.acquired = false;
    this.instanceId = null;
  }

  /**
   * Check if this instance currently holds the lock.
   */
  isLeader(): boolean {
    return this.acquired;
  }

  /**
   * Get the lock file path (for testing).
   */
  getLockPath(): string {
    return this.lockPath;
  }

  /**
   * Per-acquisition instance id, set while the lock is held.
   */
  getInstanceId(): string | null {
    return this.instanceId;
  }
}

/**
 * Check if a process with the given PID is currently running.
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
