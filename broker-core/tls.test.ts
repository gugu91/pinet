import { describe, expect, it } from "vitest";
import {
  assertBrokerClientTlsOptions,
  assertTlsListenTargetSecurity,
  certificateFingerprintMatches,
  describeTlsPeerVerificationFailure,
  normalizeCertSha256Fingerprint,
} from "./tls.js";

const FINGERPRINT_HEX = "a".repeat(64);
const FINGERPRINT_COLONED = Array.from({ length: 32 }, () => "AA").join(":");

describe("normalizeCertSha256Fingerprint", () => {
  it("normalizes colon-separated uppercase fingerprints to lowercase hex", () => {
    expect(normalizeCertSha256Fingerprint(FINGERPRINT_COLONED)).toBe(FINGERPRINT_HEX);
  });

  it("accepts plain hex with surrounding whitespace", () => {
    expect(normalizeCertSha256Fingerprint(`  ${FINGERPRINT_HEX}  `)).toBe(FINGERPRINT_HEX);
  });

  it("rejects fingerprints of the wrong length", () => {
    expect(() => normalizeCertSha256Fingerprint("abcd")).toThrow(/64 hex digits/);
  });

  it("rejects non-hex fingerprints", () => {
    expect(() => normalizeCertSha256Fingerprint("z".repeat(64))).toThrow(/64 hex digits/);
  });
});

describe("certificateFingerprintMatches", () => {
  it("matches equivalent fingerprints regardless of formatting", () => {
    expect(certificateFingerprintMatches(FINGERPRINT_HEX, FINGERPRINT_COLONED)).toBe(true);
  });

  it("does not match a different fingerprint", () => {
    expect(certificateFingerprintMatches(FINGERPRINT_HEX, "b".repeat(64))).toBe(false);
  });

  it("does not match when the peer fingerprint is missing", () => {
    expect(certificateFingerprintMatches(FINGERPRINT_HEX, null)).toBe(false);
  });

  it("does not match (rather than throw) on a malformed pin", () => {
    expect(certificateFingerprintMatches("not-a-fingerprint", FINGERPRINT_HEX)).toBe(false);
  });
});

describe("assertBrokerClientTlsOptions", () => {
  it("requires at least one trust anchor", () => {
    expect(() => assertBrokerClientTlsOptions({}, "test target")).toThrow(/trust anchor/);
    expect(() => assertBrokerClientTlsOptions({ ca: "  " }, "test target")).toThrow(/trust anchor/);
  });

  it("accepts a CA bundle alone", () => {
    expect(() =>
      assertBrokerClientTlsOptions({ ca: "-----BEGIN CERTIFICATE-----" }, "test target"),
    ).not.toThrow();
  });

  it("accepts a pinned fingerprint alone", () => {
    expect(() =>
      assertBrokerClientTlsOptions({ pinnedCertSha256: FINGERPRINT_COLONED }, "test target"),
    ).not.toThrow();
  });

  it("rejects a malformed pinned fingerprint up front", () => {
    expect(() =>
      assertBrokerClientTlsOptions({ pinnedCertSha256: "bogus" }, "test target"),
    ).toThrow(/64 hex digits/);
  });
});

describe("assertTlsListenTargetSecurity", () => {
  it("requires key and cert for any TLS bind", () => {
    expect(() =>
      assertTlsListenTargetSecurity({
        host: "127.0.0.1",
        hasKey: false,
        hasCert: true,
        hasMeshAuth: true,
      }),
    ).toThrow(/private key and a certificate/);
    expect(() =>
      assertTlsListenTargetSecurity({
        host: "127.0.0.1",
        hasKey: true,
        hasCert: false,
        hasMeshAuth: true,
      }),
    ).toThrow(/private key and a certificate/);
  });

  it("allows a loopback TLS bind without mesh auth", () => {
    expect(() =>
      assertTlsListenTargetSecurity({
        host: "127.0.0.1",
        hasKey: true,
        hasCert: true,
        hasMeshAuth: false,
      }),
    ).not.toThrow();
  });

  it("refuses a non-loopback TLS bind without mesh auth", () => {
    expect(() =>
      assertTlsListenTargetSecurity({
        host: "0.0.0.0",
        hasKey: true,
        hasCert: true,
        hasMeshAuth: false,
      }),
    ).toThrow(/mesh authentication/);
  });

  it("allows a non-loopback TLS bind when key, cert, and mesh auth are configured", () => {
    expect(() =>
      assertTlsListenTargetSecurity({
        host: "0.0.0.0",
        hasKey: true,
        hasCert: true,
        hasMeshAuth: true,
      }),
    ).not.toThrow();
  });
});

describe("describeTlsPeerVerificationFailure", () => {
  it("passes when the CA chain verified and no pin is configured", () => {
    expect(
      describeTlsPeerVerificationFailure(
        { ca: "pem" },
        { authorized: true, authorizationError: null, peerFingerprint256: FINGERPRINT_COLONED },
      ),
    ).toBeNull();
  });

  it("fails when a CA is configured but the chain did not verify", () => {
    expect(
      describeTlsPeerVerificationFailure(
        { ca: "pem" },
        {
          authorized: false,
          authorizationError: "self-signed certificate",
          peerFingerprint256: FINGERPRINT_COLONED,
        },
      ),
    ).toMatch(/chain verification failed/);
  });

  it("passes pin-only verification on a matching fingerprint even when unauthorized", () => {
    expect(
      describeTlsPeerVerificationFailure(
        { pinnedCertSha256: FINGERPRINT_HEX },
        {
          authorized: false,
          authorizationError: "self-signed certificate",
          peerFingerprint256: FINGERPRINT_COLONED,
        },
      ),
    ).toBeNull();
  });

  it("fails pin verification on a mismatched fingerprint", () => {
    expect(
      describeTlsPeerVerificationFailure(
        { pinnedCertSha256: FINGERPRINT_HEX },
        { authorized: true, authorizationError: null, peerFingerprint256: "b".repeat(64) },
      ),
    ).toMatch(/pinned SHA-256/);
  });

  it("fails pin verification when the peer fingerprint is unavailable", () => {
    expect(
      describeTlsPeerVerificationFailure(
        { pinnedCertSha256: FINGERPRINT_HEX },
        { authorized: true, authorizationError: null, peerFingerprint256: null },
      ),
    ).toMatch(/fingerprint is unavailable/);
  });

  it("enforces both CA verification and the pin when both are configured", () => {
    expect(
      describeTlsPeerVerificationFailure(
        { ca: "pem", pinnedCertSha256: FINGERPRINT_HEX },
        { authorized: true, authorizationError: null, peerFingerprint256: "b".repeat(64) },
      ),
    ).toMatch(/pinned SHA-256/);
  });
});
