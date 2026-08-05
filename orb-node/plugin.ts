/**
 * pinet-orb-node — Amp system plugin that turns an Amp orb into a Pinet mesh
 * node (see plans/amp-orbs-as-mesh-nodes.md).
 *
 * On activation it:
 *
 * - Registers a durable Amp webhook (`amp.createWebhook`) and persists the
 *   capability URL to `<stateDir>/webhook.json` (0600) so orb-local processes
 *   can report it to the mesh. A POST to that URL resumes a paused orb
 *   (verified empirically 2026-07-18), so it doubles as a machine-callable
 *   wake channel.
 * - Optionally holds an `executor.keepAlive()` lease so a broker orb never
 *   auto-pauses (`keepAlive` defaults to true for the broker role).
 * - Appends delivered webhook events to `<stateDir>/webhook-events.jsonl`
 *   (idempotent on the server-owned event id) and rewrites
 *   `<stateDir>/wake-signal.json` so orb-local processes can watch for wakes.
 *
 * This file MUST stay self-contained (no local imports): the setup script
 * copies it verbatim to `~/.config/amp/plugins/pinet-orb-node.ts`, where Amp
 * executes it with Bun. The exports besides the default function exist for
 * test coverage only.
 *
 * The Amp plugin APIs used here (`createWebhook`, `executor.keepAlive`) are
 * marked @experimental upstream; the plugin fails soft (logs and records
 * status) instead of crashing the plugin host when they are unavailable.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Minimal structural types for the Amp plugin API surface we use ─────────
// Declared locally instead of depending on `@ampcode/plugin` so the file works
// standalone when copied into ~/.config/amp/plugins/.

export type JsonLike =
  | string
  | number
  | boolean
  | null
  | JsonLike[]
  | { [key: string]: JsonLike | undefined };

export interface AmpWebhookEvent {
  /** Stable server-owned event ID; used as the idempotency key. */
  id: string;
  /** JSON-compatible request payload accepted by the webhook ingress. */
  payload?: JsonLike;
  /** Ingress receive time, when provided by the platform. */
  receivedAt?: string;
}

export interface AmpSubscription {
  unsubscribe(): void;
}

export interface AmpPluginApi {
  logger: {
    log(message: string): void;
    error(message: string): void;
  };
  system: {
    executor: {
      readonly kind: string;
      keepAlive(): Promise<AmpSubscription>;
    };
  };
  createWebhook(options: {
    key: string;
    handler: (event: AmpWebhookEvent) => void | Promise<void>;
  }): Promise<{ url: string }>;
}

// ─── Configuration ───────────────────────────────────────────────────────────

export type PinetOrbNodeRole = "broker" | "worker";

export interface PinetOrbNodeConfig {
  role: PinetOrbNodeRole;
  /** Hold an executor keepAlive lease. Defaults to true for the broker role. */
  keepAlive: boolean;
  /** Directory for webhook registration, event log, wake signal, and status. */
  stateDir: string;
  /** Stable webhook key (stable key ⇒ stable capability URL across reloads). */
  webhookKey: string;
}

export const DEFAULT_WEBHOOK_KEY = "pinet-orb-node";

export function defaultPinetOrbNodeConfigPath(): string {
  return path.join(os.homedir(), ".config", "pinet-orb-node.json");
}

export function defaultPinetOrbNodeStateDir(): string {
  return path.join(os.homedir(), ".pinet", "orb-node");
}

interface PinetOrbNodeConfigDto {
  role?: JsonLike;
  keepAlive?: JsonLike;
  stateDir?: JsonLike;
  webhookKey?: JsonLike;
}

/**
 * Parse the plugin config file contents. Unset fields get safe defaults;
 * present-but-invalid fields fail loudly rather than being silently coerced.
 */
export function parsePinetOrbNodeConfig(text: string): PinetOrbNodeConfig {
  let dto: PinetOrbNodeConfigDto;
  try {
    const parsed = JSON.parse(text) as PinetOrbNodeConfigDto;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("config is not a JSON object");
    }
    dto = parsed;
  } catch (err) {
    throw new Error(
      `Invalid pinet-orb-node config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let role: PinetOrbNodeRole;
  if (dto.role === undefined || dto.role === "broker") {
    role = "broker";
  } else if (dto.role === "worker") {
    role = "worker";
  } else {
    throw new Error(
      `Invalid pinet-orb-node config: role must be "broker" or "worker", got ${JSON.stringify(dto.role)}`,
    );
  }

  let keepAlive: boolean;
  if (dto.keepAlive === undefined) {
    keepAlive = role === "broker";
  } else if (typeof dto.keepAlive === "boolean") {
    keepAlive = dto.keepAlive;
  } else {
    throw new Error("Invalid pinet-orb-node config: keepAlive must be a boolean");
  }

  let stateDir: string;
  if (dto.stateDir === undefined) {
    stateDir = defaultPinetOrbNodeStateDir();
  } else if (typeof dto.stateDir === "string" && dto.stateDir.length > 0) {
    stateDir = dto.stateDir;
  } else {
    throw new Error("Invalid pinet-orb-node config: stateDir must be a non-empty string");
  }

  let webhookKey: string;
  if (dto.webhookKey === undefined) {
    webhookKey = DEFAULT_WEBHOOK_KEY;
  } else if (typeof dto.webhookKey === "string" && dto.webhookKey.length > 0) {
    webhookKey = dto.webhookKey;
  } else {
    throw new Error("Invalid pinet-orb-node config: webhookKey must be a non-empty string");
  }

  return { role, keepAlive, stateDir, webhookKey };
}

// ─── State files ─────────────────────────────────────────────────────────────

export interface PinetOrbNodePaths {
  webhookJsonPath: string;
  eventsLogPath: string;
  wakeSignalPath: string;
  statusJsonPath: string;
}

export function resolvePinetOrbNodePaths(stateDir: string): PinetOrbNodePaths {
  return {
    webhookJsonPath: path.join(stateDir, "webhook.json"),
    eventsLogPath: path.join(stateDir, "webhook-events.jsonl"),
    wakeSignalPath: path.join(stateDir, "wake-signal.json"),
    statusJsonPath: path.join(stateDir, "status.json"),
  };
}

/**
 * Write a file atomically (temp + fsync + rename) so watchers never observe a
 * partial write. The containing directory is created 0700 when missing.
 */
export function writeFileAtomic(filePath: string, contents: string, mode: number): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  const fd = fs.openSync(tempPath, "w", mode);
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, filePath);
}

// ─── Webhook event log ───────────────────────────────────────────────────────

interface WebhookEventLineDto {
  id?: JsonLike;
}

export function formatWebhookEventLine(event: AmpWebhookEvent, recordedAt: string): string {
  return `${JSON.stringify({ recordedAt, id: event.id, payload: event.payload ?? null })}\n`;
}

/** At-least-once delivery guard: has this server event id already been logged? */
export function eventsLogContainsId(logText: string, eventId: string): boolean {
  for (const line of logText.split("\n")) {
    if (line === "") continue;
    try {
      const dto = JSON.parse(line) as WebhookEventLineDto;
      if (typeof dto === "object" && dto !== null && dto.id === eventId) return true;
    } catch {
      // Ignore malformed lines; they can never match a server-owned id.
    }
  }
  return false;
}

// ─── Plugin entry point ──────────────────────────────────────────────────────

export type KeepAliveState = "held" | "unavailable" | "disabled";

export interface PinetOrbNodeStatus {
  role: PinetOrbNodeRole;
  executorKind: string;
  webhookKey: string;
  keepAlive: KeepAliveState;
  keepAliveError?: string;
  startedAt: string;
}

// Retain the lease for the plugin process lifetime (dropping it releases it).
let keepAliveSubscription: AmpSubscription | null = null;

export default async function pinetOrbNode(amp: AmpPluginApi): Promise<void> {
  const configPath = process.env.PINET_ORB_NODE_CONFIG ?? defaultPinetOrbNodeConfigPath();
  const config = fs.existsSync(configPath)
    ? parsePinetOrbNodeConfig(fs.readFileSync(configPath, "utf-8"))
    : parsePinetOrbNodeConfig("{}");
  const paths = resolvePinetOrbNodePaths(config.stateDir);

  const registration = await amp.createWebhook({
    key: config.webhookKey,
    handler: (event) => {
      const recordedAt = new Date().toISOString();
      const existing = fs.existsSync(paths.eventsLogPath)
        ? fs.readFileSync(paths.eventsLogPath, "utf-8")
        : "";
      if (eventsLogContainsId(existing, event.id)) return;
      fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(paths.eventsLogPath, formatWebhookEventLine(event, recordedAt), {
        mode: 0o600,
      });
      writeFileAtomic(
        paths.wakeSignalPath,
        `${JSON.stringify({ eventId: event.id, recordedAt })}\n`,
        0o600,
      );
      amp.logger.log(`[pinet-orb-node] webhook event ${event.id} recorded`);
    },
  });

  // The capability URL is a bearer credential: 0600, never logged.
  writeFileAtomic(
    paths.webhookJsonPath,
    `${JSON.stringify({ url: registration.url, key: config.webhookKey, registeredAt: new Date().toISOString() })}\n`,
    0o600,
  );

  let keepAlive: KeepAliveState = "disabled";
  let keepAliveError: string | undefined;
  if (config.keepAlive) {
    try {
      keepAliveSubscription = await amp.system.executor.keepAlive();
      keepAlive = "held";
    } catch (err) {
      keepAlive = "unavailable";
      keepAliveError = err instanceof Error ? err.message : String(err);
    }
  }

  const status: PinetOrbNodeStatus = {
    role: config.role,
    executorKind: amp.system.executor.kind,
    webhookKey: config.webhookKey,
    keepAlive,
    ...(keepAliveError !== undefined ? { keepAliveError } : {}),
    startedAt: new Date().toISOString(),
  };
  writeFileAtomic(paths.statusJsonPath, `${JSON.stringify(status)}\n`, 0o600);

  amp.logger.log(
    `[pinet-orb-node] active: role=${config.role} webhook=${config.webhookKey} keepAlive=${keepAlive}` +
      (keepAliveSubscription === null && config.keepAlive ? ` (${keepAliveError ?? "?"})` : ""),
  );
}
