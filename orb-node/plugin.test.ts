import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WEBHOOK_KEY,
  defaultPinetOrbNodeStateDir,
  eventsLogContainsId,
  formatWebhookEventLine,
  parsePinetOrbNodeConfig,
  resolvePinetOrbNodePaths,
  writeFileAtomic,
  type AmpWebhookEvent,
} from "./plugin.js";

describe("parsePinetOrbNodeConfig", () => {
  it("applies defaults for an empty config", () => {
    const config = parsePinetOrbNodeConfig("{}");
    expect(config.role).toBe("broker");
    expect(config.keepAlive).toBe(true);
    expect(config.stateDir).toBe(defaultPinetOrbNodeStateDir());
    expect(config.webhookKey).toBe(DEFAULT_WEBHOOK_KEY);
  });

  it("defaults keepAlive to false for the worker role", () => {
    expect(parsePinetOrbNodeConfig('{"role":"worker"}').keepAlive).toBe(false);
  });

  it("lets an explicit keepAlive override the role default", () => {
    expect(parsePinetOrbNodeConfig('{"role":"worker","keepAlive":true}').keepAlive).toBe(true);
    expect(parsePinetOrbNodeConfig('{"role":"broker","keepAlive":false}').keepAlive).toBe(false);
  });

  it("accepts explicit stateDir and webhookKey", () => {
    const config = parsePinetOrbNodeConfig('{"stateDir":"/tmp/x","webhookKey":"custom"}');
    expect(config.stateDir).toBe("/tmp/x");
    expect(config.webhookKey).toBe("custom");
  });

  it("rejects invalid roles", () => {
    expect(() => parsePinetOrbNodeConfig('{"role":"observer"}')).toThrow(/role must be/);
  });

  it("rejects non-boolean keepAlive", () => {
    expect(() => parsePinetOrbNodeConfig('{"keepAlive":"yes"}')).toThrow(/keepAlive/);
  });

  it("rejects empty stateDir and webhookKey", () => {
    expect(() => parsePinetOrbNodeConfig('{"stateDir":""}')).toThrow(/stateDir/);
    expect(() => parsePinetOrbNodeConfig('{"webhookKey":""}')).toThrow(/webhookKey/);
  });

  it("rejects malformed JSON and non-object documents", () => {
    expect(() => parsePinetOrbNodeConfig("nope")).toThrow(/Invalid pinet-orb-node config/);
    expect(() => parsePinetOrbNodeConfig("[]")).toThrow(/not a JSON object/);
    expect(() => parsePinetOrbNodeConfig("null")).toThrow(/not a JSON object/);
  });
});

describe("webhook event log", () => {
  const event: AmpWebhookEvent = {
    id: "evt-1",
    payload: { body: { data: '{"probe":"x"}', encoding: "utf-8" } },
  };

  it("round-trips an event line", () => {
    const line = formatWebhookEventLine(event, "2026-07-18T21:07:30.262Z");
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line) as { recordedAt: string; id: string };
    expect(parsed.recordedAt).toBe("2026-07-18T21:07:30.262Z");
    expect(parsed.id).toBe("evt-1");
    expect(eventsLogContainsId(line, "evt-1")).toBe(true);
    expect(eventsLogContainsId(line, "evt-2")).toBe(false);
  });

  it("records a null payload for payload-less events", () => {
    const line = formatWebhookEventLine({ id: "evt-9" }, "2026-07-18T00:00:00Z");
    expect((JSON.parse(line) as { payload: null }).payload).toBeNull();
  });

  it("ignores malformed log lines when checking ids", () => {
    const log = `not-json\n${formatWebhookEventLine(event, "2026-07-18T00:00:00Z")}`;
    expect(eventsLogContainsId(log, "evt-1")).toBe(true);
    expect(eventsLogContainsId("", "evt-1")).toBe(false);
  });
});

describe("state files", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinet-orb-node-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolves the standard state file paths", () => {
    const paths = resolvePinetOrbNodePaths("/state");
    expect(paths.webhookJsonPath).toBe("/state/webhook.json");
    expect(paths.eventsLogPath).toBe("/state/webhook-events.jsonl");
    expect(paths.wakeSignalPath).toBe("/state/wake-signal.json");
    expect(paths.statusJsonPath).toBe("/state/status.json");
  });

  it("writes files atomically with the requested mode and creates parents", () => {
    const target = path.join(dir, "nested", "webhook.json");
    writeFileAtomic(target, '{"url":"secret"}\n', 0o600);
    expect(fs.readFileSync(target, "utf-8")).toBe('{"url":"secret"}\n');
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(target))).toEqual(["webhook.json"]);
  });

  it("replaces existing files without leaving temp files behind", () => {
    const target = path.join(dir, "status.json");
    writeFileAtomic(target, "one\n", 0o600);
    writeFileAtomic(target, "two\n", 0o600);
    expect(fs.readFileSync(target, "utf-8")).toBe("two\n");
    expect(fs.readdirSync(dir)).toEqual(["status.json"]);
  });
});
