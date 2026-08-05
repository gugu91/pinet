/**
 * Shared TLS contracts and verification helpers for the encrypted remote
 * broker transport.
 *
 * Trust model:
 * - Raw TCP stays loopback-only (see raw-tcp-loopback.ts). TLS is the only
 *   transport allowed to leave the broker host.
 * - A TLS listener may bind a non-loopback host only when both a key/cert pair
 *   AND mesh authentication (shared secret) are configured, so transport
 *   encryption is never mistaken for authentication.
 * - A TLS client must configure an explicit trust anchor: a PEM CA bundle,
 *   a pinned server-certificate SHA-256 fingerprint, or both. There is no
 *   "trust whatever answers" mode.
 *
 * Never log or embed secrets, tokens, or message bodies in errors produced
 * here; certificate fingerprints are public values but are still kept out of
 * error strings.
 */

import { isLoopbackTcpHost } from "./raw-tcp-loopback.js";

// ─── Server-side config ──────────────────────────────────

/** PEM contents (not paths) for a broker TLS listener. */
export interface BrokerTlsServerConfig {
  /** PEM private key contents. */
  key: string;
  /** PEM certificate (or full chain) contents. */
  cert: string;
  /**
   * Optional PEM CA bundle for verifying client certificates (mTLS). When set,
   * clients must present a certificate signed by this CA.
   */
  clientCa?: string;
}

export interface TlsListenSecurityInput {
  host: string;
  hasKey: boolean;
  hasCert: boolean;
  hasMeshAuth: boolean;
}

/**
 * Fail-closed guard for binding a broker TLS listener. Key and cert are always
 * required; a non-loopback bind additionally requires mesh authentication so
 * an encrypted-but-unauthenticated broker is never exposed to the network.
 */
export function assertTlsListenTargetSecurity(input: TlsListenSecurityInput): void {
  if (!input.hasKey || !input.hasCert) {
    throw new Error(
      "Broker TLS listener requires both a private key and a certificate. Configure tls.key and tls.cert (PEM contents).",
    );
  }
  if (!isLoopbackTcpHost(input.host) && !input.hasMeshAuth) {
    throw new Error(
      `Refusing to bind broker TLS listener on non-loopback host "${input.host}" without mesh authentication. Configure a mesh secret (meshSecret/meshSecretPath) before exposing the broker beyond loopback.`,
    );
  }
}

// ─── Client-side config ──────────────────────────────────

/**
 * Explicit trust anchors for a TLS broker connection. At least one of `ca`
 * or `pinnedCertSha256` must be provided.
 */
export interface BrokerClientTlsOptions {
  /** PEM CA bundle contents used for standard chain + hostname verification. */
  ca?: string;
  /**
   * Expected server-certificate SHA-256 fingerprint (hex, colons optional,
   * case-insensitive). When set, the peer leaf certificate must match exactly.
   * Pinning works with self-signed certificates and needs no CA.
   */
  pinnedCertSha256?: string;
  /** SNI / hostname-verification name override (useful when dialing by IP). */
  servername?: string;
  /** Optional PEM client-certificate private key contents (mTLS). */
  key?: string;
  /** Optional PEM client-certificate contents (mTLS). */
  cert?: string;
}

const SHA256_HEX_LENGTH = 64;

/**
 * Canonicalize a SHA-256 certificate fingerprint to lowercase hex without
 * separators. Throws on anything that is not a 64-digit hex fingerprint.
 */
export function normalizeCertSha256Fingerprint(value: string): string {
  const normalized = value.replace(/[:\s]/g, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length !== SHA256_HEX_LENGTH) {
    throw new Error(
      "Invalid TLS certificate SHA-256 fingerprint: expected 64 hex digits (colons optional).",
    );
  }
  return normalized;
}

export function certificateFingerprintMatches(
  pinnedCertSha256: string,
  peerFingerprint256: string | null,
): boolean {
  if (!peerFingerprint256) {
    return false;
  }
  try {
    return (
      normalizeCertSha256Fingerprint(pinnedCertSha256) ===
      normalizeCertSha256Fingerprint(peerFingerprint256)
    );
  } catch {
    return false;
  }
}

/**
 * Fail-closed guard for client TLS options: an explicit trust anchor is
 * mandatory and a malformed pin is rejected up front rather than at match time.
 */
export function assertBrokerClientTlsOptions(
  options: BrokerClientTlsOptions,
  targetDescription: string,
): void {
  const hasCa = typeof options.ca === "string" && options.ca.trim().length > 0;
  const hasPin =
    typeof options.pinnedCertSha256 === "string" && options.pinnedCertSha256.trim().length > 0;
  if (!hasCa && !hasPin) {
    throw new Error(
      `Refusing ${targetDescription} without an explicit TLS trust anchor. Provide tls.ca (PEM contents) and/or tls.pinnedCertSha256 (server certificate SHA-256 fingerprint).`,
    );
  }
  if (hasPin) {
    normalizeCertSha256Fingerprint(options.pinnedCertSha256 ?? "");
  }
}

// ─── Peer verification ───────────────────────────────────

export interface TlsPeerVerificationInput {
  /** Result of chain verification (tls socket `authorized`). */
  authorized: boolean;
  /** Chain verification error description, if any. */
  authorizationError: string | null;
  /** Peer leaf certificate SHA-256 fingerprint (tls `fingerprint256`), if available. */
  peerFingerprint256: string | null;
}

/**
 * Evaluate the configured trust anchors against the connected peer. Returns a
 * human-readable failure description, or null when the peer satisfies every
 * configured anchor. CA verification and pinning are both enforced when both
 * are configured.
 */
export function describeTlsPeerVerificationFailure(
  options: BrokerClientTlsOptions,
  peer: TlsPeerVerificationInput,
): string | null {
  const hasCa = typeof options.ca === "string" && options.ca.trim().length > 0;
  if (hasCa && !peer.authorized) {
    return `Broker TLS certificate chain verification failed: ${peer.authorizationError ?? "unknown verification error"}.`;
  }

  const pin = options.pinnedCertSha256?.trim();
  if (pin) {
    if (!peer.peerFingerprint256) {
      return "Broker TLS peer certificate fingerprint is unavailable; cannot verify certificate pin.";
    }
    if (!certificateFingerprintMatches(pin, peer.peerFingerprint256)) {
      return "Broker TLS peer certificate does not match the pinned SHA-256 fingerprint.";
    }
  }

  return null;
}
