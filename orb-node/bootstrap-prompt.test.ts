import { describe, expect, it } from "vitest";
import { buildBrokerOrbBootstrapPrompt, DEFAULT_BROKER_SERVICE_NAME } from "./bootstrap-prompt.js";

describe("buildBrokerOrbBootstrapPrompt", () => {
  it("tells the orb agent to run the idempotent setup script from the repo root", () => {
    const prompt = buildBrokerOrbBootstrapPrompt();
    expect(prompt).toContain("bash orb-node/setup/orb-broker-setup.sh");
    expect(prompt).toContain(`PINET_ORB_SERVICE_NAME=${DEFAULT_BROKER_SERVICE_NAME}`);
    expect(prompt).toContain("idempotent");
  });

  it("includes every verification gate", () => {
    const prompt = buildBrokerOrbBootstrapPrompt();
    expect(prompt).toContain("webhook.json");
    expect(prompt).toContain('"keepAlive":"held"');
    expect(prompt).toContain(`amp orb service status ${DEFAULT_BROKER_SERVICE_NAME}`);
    expect(prompt).toContain(`tmux has-session -t ${DEFAULT_BROKER_SERVICE_NAME}`);
  });

  it("threads a custom service name through command, checks, and constraints", () => {
    const prompt = buildBrokerOrbBootstrapPrompt({ serviceName: "mesh-hub" });
    expect(prompt).toContain("PINET_ORB_SERVICE_NAME=mesh-hub");
    expect(prompt).toContain("amp orb service status mesh-hub");
    expect(prompt).toContain("tmux has-session -t mesh-hub");
    expect(prompt).not.toContain(DEFAULT_BROKER_SERVICE_NAME);
  });

  it("forbids commits, pushes, and archiving", () => {
    const prompt = buildBrokerOrbBootstrapPrompt();
    expect(prompt).toContain("do NOT commit or push");
    expect(prompt).toContain("do NOT archive this thread");
  });
});
