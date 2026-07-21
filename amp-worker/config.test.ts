import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AMP_WORKER_USAGE,
  DEFAULT_POLL_INTERVAL_MS,
  parseAmpWorkerArgs,
  resolveAmpWorkerConfig,
} from "./config.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "amp-worker-config-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("parseAmpWorkerArgs", () => {
  it("parses defaults", () => {
    const args = parseAmpWorkerArgs([]);
    expect(args).toMatchObject({
      help: false,
      socketPath: null,
      host: null,
      port: null,
      mode: "medium",
      ampCommand: "amp",
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      orbAudience: null,
    });
  });

  it("parses a full remote TLS invocation", () => {
    const args = parseAmpWorkerArgs([
      "--host",
      "broker.example.com",
      "--port",
      "7433",
      "--tls-ca",
      "/tmp/ca.pem",
      "--tls-pin",
      "AA:BB",
      "--tls-servername",
      "broker.internal",
      "--mesh-secret-file",
      "/tmp/secret",
      "--name",
      "amp-runner",
      "--emoji",
      "🤖",
      "--stable-id",
      "amp-1",
      "--mode",
      "high",
      "--cwd",
      "/tmp",
      "--poll-interval-ms",
      "500",
      "--orb-audience",
      "pinet-mesh",
    ]);
    expect(args).toMatchObject({
      host: "broker.example.com",
      port: 7433,
      tlsCaPath: "/tmp/ca.pem",
      tlsPin: "AA:BB",
      tlsServername: "broker.internal",
      meshSecretPath: "/tmp/secret",
      name: "amp-runner",
      emoji: "🤖",
      stableId: "amp-1",
      mode: "high",
      cwd: "/tmp",
      pollIntervalMs: 500,
      orbAudience: "pinet-mesh",
    });
  });

  it("rejects unknown flags, bad ports, bad intervals, and bad modes", () => {
    expect(() => parseAmpWorkerArgs(["--bogus"])).toThrow(/Unknown argument/);
    expect(() => parseAmpWorkerArgs(["--host", "h", "--port", "0"])).toThrow(/Invalid --port/);
    expect(() => parseAmpWorkerArgs(["--host", "h", "--port", "x"])).toThrow(/Invalid --port/);
    expect(() => parseAmpWorkerArgs(["--poll-interval-ms", "50"])).toThrow(
      /Invalid --poll-interval-ms/,
    );
    expect(() => parseAmpWorkerArgs(["--mode", "turbo"])).toThrow(/Invalid Amp mode/);
    expect(() => parseAmpWorkerArgs(["--mode"])).toThrow(/Missing value/);
  });

  it("rejects mixing socket and TCP endpoints, and TLS without a host", () => {
    expect(() => parseAmpWorkerArgs(["--socket", "/tmp/s", "--host", "h", "--port", "1"])).toThrow(
      /either --socket or --host\/--port/,
    );
    expect(() => parseAmpWorkerArgs(["--host", "h"])).toThrow(/must be provided together/);
    expect(() => parseAmpWorkerArgs(["--port", "9000"])).toThrow(/must be provided together/);
    expect(() => parseAmpWorkerArgs(["--tls-ca", "/tmp/ca.pem"])).toThrow(
      /TLS options require --host\/--port/,
    );
  });

  it("documents the exact Amp modes in usage", () => {
    expect(AMP_WORKER_USAGE).toContain("low | medium | high | ultra");
  });
});

describe("resolveAmpWorkerConfig", () => {
  it("defaults to the Unix socket endpoint", () => {
    const config = resolveAmpWorkerConfig(parseAmpWorkerArgs(["--cwd", tempDir]));
    expect(config.connect.kind).toBe("socket");
    expect(config.cwd).toBe(fs.realpathSync(tempDir) === tempDir ? tempDir : config.cwd);
    expect(config.name).toMatch(/^amp-/);
    expect(config.stableId).toMatch(/^amp-worker:/);
    expect(config.stateFilePath).toContain("amp-worker");
  });

  it("keeps plaintext TCP available without TLS flags (loopback enforcement lives in BrokerClient)", () => {
    const config = resolveAmpWorkerConfig(
      parseAmpWorkerArgs(["--host", "127.0.0.1", "--port", "7433", "--cwd", tempDir]),
    );
    expect(config.connect).toEqual({ kind: "tcp", host: "127.0.0.1", port: 7433 });
  });

  it("builds TLS connect options from files and pins", () => {
    const caPath = path.join(tempDir, "ca.pem");
    fs.writeFileSync(caPath, "PEM CA");
    const config = resolveAmpWorkerConfig(
      parseAmpWorkerArgs([
        "--host",
        "broker.example.com",
        "--port",
        "7433",
        "--tls-ca",
        caPath,
        "--tls-pin",
        "AA:BB:CC",
        "--tls-servername",
        "broker.internal",
        "--cwd",
        tempDir,
      ]),
    );
    expect(config.connect).toEqual({
      kind: "tls",
      host: "broker.example.com",
      port: 7433,
      tls: { ca: "PEM CA", pinnedCertSha256: "AA:BB:CC", servername: "broker.internal" },
    });
  });

  it("prefers the PINET_MESH_SECRET environment variable over secret files", () => {
    const secretPath = path.join(tempDir, "secret");
    fs.writeFileSync(secretPath, "file-secret");
    const config = resolveAmpWorkerConfig(
      parseAmpWorkerArgs(["--mesh-secret-file", secretPath, "--cwd", tempDir]),
      { PINET_MESH_SECRET: "env-secret" },
    );
    expect(config.meshSecret).toBe("env-secret");
    expect(config.meshSecretPath).toBeNull();
  });

  it("falls back to the --mesh-secret-file path when no env secret is set", () => {
    const secretPath = path.join(tempDir, "secret");
    fs.writeFileSync(secretPath, "file-secret");
    const config = resolveAmpWorkerConfig(
      parseAmpWorkerArgs(["--mesh-secret-file", secretPath, "--cwd", tempDir]),
      {},
    );
    expect(config.meshSecret).toBeNull();
    expect(config.meshSecretPath).toBe(secretPath);
  });

  it("derives a filesystem-safe state file from the stable ID", () => {
    const config = resolveAmpWorkerConfig(
      parseAmpWorkerArgs(["--stable-id", "amp worker:one/two", "--cwd", tempDir]),
    );
    expect(path.basename(config.stateFilePath)).toBe("amp-worker-one-two.state.json");
  });

  it("honors an explicit state file path", () => {
    const statePath = path.join(tempDir, "custom.state.json");
    const config = resolveAmpWorkerConfig(
      parseAmpWorkerArgs(["--state-file", statePath, "--cwd", tempDir]),
    );
    expect(config.stateFilePath).toBe(statePath);
  });
});
