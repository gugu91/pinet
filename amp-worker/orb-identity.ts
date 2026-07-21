/**
 * Amp orb workload identity.
 *
 * Inside an Amp orb, `amp orb id-token --audience <aud>` mints a short-lived
 * OIDC token (issuer https://ampcode.com/api/workload-identity, RS256, exact
 * audience, `token_use=exchanged`) whose claims identify the orb's Amp
 * thread/workspace/project. The worker decodes those claims locally to attach
 * *identity metadata* to its mesh registration.
 *
 * Trust model: the mesh authentication mechanism remains the shared mesh
 * secret (plus TLS for remote transports). The decoded claims are advertised
 * as identity/location metadata, not as an authentication factor — the broker
 * does not verify OIDC signatures today. The raw token is never logged,
 * persisted, or forwarded to the broker.
 */

import { spawnSync } from "node:child_process";

export const AMP_ORB_OIDC_ISSUER = "https://ampcode.com/api/workload-identity";

/** Boundary DTO for the decoded JWT payload; fields re-validated after parse. */
interface AmpOrbTokenClaimsDto {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  token_use?: string;
  thread_id?: string;
  workspace_id?: string;
  project_id?: string;
}

export interface AmpOrbIdentity {
  issuer: string;
  audience: string;
  subject: string | null;
  tokenUse: string | null;
  ampThreadId: string | null;
  workspaceId: string | null;
  projectId: string | null;
}

/**
 * Decode (without signature verification — see module docs) the claims of an
 * Amp orb OIDC token. Fails closed on issuer/audience/token_use mismatches so
 * a wrong or replayed token never becomes registration metadata.
 */
export function decodeAmpOrbIdentityToken(token: string, expectedAudience: string): AmpOrbIdentity {
  const parts = token.trim().split(".");
  if (parts.length !== 3) {
    throw new Error("Amp orb id-token is not a JWT (expected three dot-separated segments).");
  }

  let claims: AmpOrbTokenClaimsDto;
  try {
    const parsed = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8"),
    ) as AmpOrbTokenClaimsDto;
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("payload is not an object");
    }
    claims = parsed;
  } catch (err) {
    throw new Error(
      `Failed to decode Amp orb id-token payload: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (claims.iss !== AMP_ORB_OIDC_ISSUER) {
    throw new Error(`Amp orb id-token issuer mismatch (expected ${AMP_ORB_OIDC_ISSUER}).`);
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expectedAudience)) {
    throw new Error("Amp orb id-token audience mismatch.");
  }
  if (claims.token_use !== "exchanged") {
    throw new Error('Amp orb id-token token_use mismatch (expected "exchanged").');
  }
  if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) {
    throw new Error("Amp orb id-token is expired.");
  }

  return {
    issuer: AMP_ORB_OIDC_ISSUER,
    audience: expectedAudience,
    subject: typeof claims.sub === "string" ? claims.sub : null,
    tokenUse: typeof claims.token_use === "string" ? claims.token_use : null,
    ampThreadId: typeof claims.thread_id === "string" ? claims.thread_id : null,
    workspaceId: typeof claims.workspace_id === "string" ? claims.workspace_id : null,
    projectId: typeof claims.project_id === "string" ? claims.project_id : null,
  };
}

/**
 * Run `amp orb id-token --audience <aud>` and decode its claims. Returns null
 * when the command fails (typically: not running inside an orb).
 */
export function captureAmpOrbIdentity(
  ampCommand: string,
  audience: string,
  cwd: string,
): AmpOrbIdentity | null {
  const result = spawnSync(ampCommand, ["orb", "id-token", "--audience", audience], {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  const token = result.stdout.trim();
  if (!token) {
    return null;
  }
  return decodeAmpOrbIdentityToken(token, audience);
}
