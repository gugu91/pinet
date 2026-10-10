import { isIP } from "node:net";
import { isLoopbackTcpHost } from "./raw-tcp-loopback.js";

/** Literal private addresses only: no wildcard binds or DNS rebinding. Encryption is supplied by the private overlay (e.g. Tailscale). */
export function isPrivateTcpHost(host: string): boolean {
  if (isLoopbackTcpHost(host)) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return isIP(host) === 6 && /^(fc|fd)/i.test(host);
}

export function assertPrivateTcpHost(host: string, enabled: boolean): void {
  if (isLoopbackTcpHost(host)) return;
  if (!enabled || !isPrivateTcpHost(host)) {
    throw new Error(
      "Pinet is loopback-only by default. Non-loopback requires an explicit privateNetwork opt-in and a literal private IP; public/wildcard endpoints are forbidden.",
    );
  }
}
