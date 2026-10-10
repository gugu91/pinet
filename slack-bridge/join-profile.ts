import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BrokerClientOptions } from "./broker/client.js";
import { assertPrivateTcpHost } from "./broker/private-network.js";
import { workerStableId, type WorkerCredential } from "./broker/membership.js";

export interface JoinProfile extends WorkerCredential {
  version: 1;
  endpoint: { path: string } | { host: string; port: number; privateNetwork: true };
  repos: string[];
  capabilities: string[];
}

export const defaultJoinProfilePath = path.join(os.homedir(), ".pi", "agent", "pinet", "join.json");

export function readJoinProfile(filename: string): JoinProfile {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new Error("Pinet join profile must be an owner-only regular file (chmod 600).");
    }
    let parsed: Partial<JoinProfile>;
    try {
      parsed = JSON.parse(fs.readFileSync(fd, "utf8")) as Partial<JoinProfile>;
    } catch {
      throw new Error("Invalid JSON in Pinet join profile.");
    }
    if (
      !parsed ||
      parsed.version !== 1 ||
      !parsed.endpoint ||
      ![parsed.credentialId, parsed.credentialSecret, parsed.hostId, parsed.workerId].every(
        (v) => typeof v === "string" && v.trim().length > 0,
      ) ||
      !Array.isArray(parsed.repos) ||
      !parsed.repos.every((v) => typeof v === "string") ||
      !Array.isArray(parsed.capabilities) ||
      !parsed.capabilities.every((v) => typeof v === "string")
    ) {
      throw new Error(
        "Invalid Pinet join profile: require version, endpoint, hostId, workerId, credential and repo/capability lists.",
      );
    }
    const endpoint = parsed.endpoint;
    if ("path" in endpoint) {
      if (typeof endpoint.path !== "string" || !path.isAbsolute(endpoint.path))
        throw new Error("Join socket path must be absolute.");
    } else {
      if (
        typeof endpoint.host !== "string" ||
        !Number.isInteger(endpoint.port) ||
        endpoint.port < 1 ||
        endpoint.port > 65535
      )
        throw new Error("Invalid join TCP endpoint.");
      assertPrivateTcpHost(endpoint.host, endpoint.privateNetwork === true);
    }
    return parsed as JoinProfile;
  } finally {
    fs.closeSync(fd);
  }
}

export function writeJoinProfile(filename: string, profile: JoinProfile): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filename, JSON.stringify(profile, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}

export function resolveJoinProfilePath(explicit?: string): string | null {
  const configured = explicit?.trim() || process.env.PINET_JOIN_PROFILE?.trim();
  return configured || (fs.existsSync(defaultJoinProfilePath) ? defaultJoinProfilePath : null);
}

export function joinClientOptions(profile: JoinProfile): BrokerClientOptions {
  return {
    ...profile.endpoint,
    credentialId: profile.credentialId,
    credentialSecret: profile.credentialSecret,
  };
}

export function joinIdentity(profile: JoinProfile): string {
  return workerStableId(profile);
}
