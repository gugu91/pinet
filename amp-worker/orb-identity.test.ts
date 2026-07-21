import { describe, expect, it } from "vitest";
import { AMP_ORB_OIDC_ISSUER, decodeAmpOrbIdentityToken } from "./orb-identity.js";

function makeToken(claims: Record<string, string | number | string[]>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

const validClaims = {
  iss: AMP_ORB_OIDC_ISSUER,
  aud: "pinet-mesh",
  sub: "orb:workspace/thread",
  exp: Math.floor(Date.now() / 1000) + 300,
  token_use: "exchanged",
  thread_id: "T-abc12345",
  workspace_id: "W-1",
  project_id: "P-1",
};

describe("decodeAmpOrbIdentityToken", () => {
  it("decodes identity claims from a valid token", () => {
    const identity = decodeAmpOrbIdentityToken(makeToken(validClaims), "pinet-mesh");
    expect(identity).toEqual({
      issuer: AMP_ORB_OIDC_ISSUER,
      audience: "pinet-mesh",
      subject: "orb:workspace/thread",
      tokenUse: "exchanged",
      ampThreadId: "T-abc12345",
      workspaceId: "W-1",
      projectId: "P-1",
    });
  });

  it("accepts audience arrays containing the expected audience", () => {
    const identity = decodeAmpOrbIdentityToken(
      makeToken({ ...validClaims, aud: ["other", "pinet-mesh"] }),
      "pinet-mesh",
    );
    expect(identity.audience).toBe("pinet-mesh");
  });

  it("never returns the raw token material", () => {
    const token = makeToken(validClaims);
    const identity = decodeAmpOrbIdentityToken(token, "pinet-mesh");
    for (const value of Object.values(identity)) {
      expect(String(value)).not.toContain("fake-signature");
      expect(token).not.toBe(value);
    }
  });

  it("rejects non-JWT input", () => {
    expect(() => decodeAmpOrbIdentityToken("not-a-jwt", "pinet-mesh")).toThrow(/not a JWT/);
  });

  it("rejects issuer mismatches", () => {
    expect(() =>
      decodeAmpOrbIdentityToken(
        makeToken({ ...validClaims, iss: "https://evil.example.com" }),
        "pinet-mesh",
      ),
    ).toThrow(/issuer mismatch/);
  });

  it("rejects audience mismatches", () => {
    expect(() =>
      decodeAmpOrbIdentityToken(makeToken({ ...validClaims, aud: "other" }), "pinet-mesh"),
    ).toThrow(/audience mismatch/);
  });

  it("rejects token_use mismatches", () => {
    expect(() =>
      decodeAmpOrbIdentityToken(makeToken({ ...validClaims, token_use: "id" }), "pinet-mesh"),
    ).toThrow(/token_use mismatch/);
  });

  it("rejects expired tokens", () => {
    expect(() =>
      decodeAmpOrbIdentityToken(
        makeToken({ ...validClaims, exp: Math.floor(Date.now() / 1000) - 10 }),
        "pinet-mesh",
      ),
    ).toThrow(/expired/);
  });
});
