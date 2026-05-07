import { describe, expect, it, vi } from "vitest";
import {
  createAgentPromptGuidance,
  type AgentPromptGuidanceDeps,
} from "./agent-prompt-guidance.js";

function createDeps(overrides: Partial<AgentPromptGuidanceDeps> = {}): AgentPromptGuidanceDeps {
  return {
    getIdentityGuidelines: () => ["IDENTITY 1", "IDENTITY 2", "IDENTITY 3"],
    getAgentName: () => "Cobalt Olive Crane",
    getAgentEmoji: () => "🦩",
    getActiveSkinTheme: () => null,
    getAgentPersonality: () => null,
    getBrokerRole: () => null,
    loadBrokerPrompt: async () => ({
      source: "packaged",
      content:
        "You are {{agentEmoji}} {{agentName}}, the Pinet BROKER. CUSTOM MD POLICY. DELEGATE, THEN TRACK.",
      warnings: [],
      diagnostic: "broker prompt: packaged default loaded",
    }),
    reportBrokerPromptDiagnostic: () => undefined,
    reportBrokerPromptWarning: () => undefined,
    ...overrides,
  };
}

describe("createAgentPromptGuidance", () => {
  it("appends identity, personality, and reaction guidance for non-mesh sessions", async () => {
    const getIdentityGuidelines = vi.fn(() => ["IDENTITY 1", "IDENTITY 2", "IDENTITY 3"]);
    const guidance = createAgentPromptGuidance(
      createDeps({
        getIdentityGuidelines,
      }),
    );

    const result = await guidance.beforeAgentStart({ systemPrompt: "BASE" });

    expect(getIdentityGuidelines).toHaveBeenCalledTimes(1);
    expect(result.systemPrompt).toContain("BASE\n\nIDENTITY 1\nIDENTITY 2\nIDENTITY 3");
    expect(result.systemPrompt).toContain("COMMUNICATION STYLE:");
    expect(result.systemPrompt).toContain("For `Cobalt Olive Crane`, aim for a");
    expect(result.systemPrompt).toContain("Reaction-triggered requests may appear");
    expect(result.systemPrompt).not.toContain("PINET SKIN (");
    expect(result.systemPrompt).not.toContain("Pinet BROKER");
    expect(result.systemPrompt).not.toContain("PINET PRIMER:");
    expect(result.systemPrompt).not.toContain("TASK WORKFLOW:");
    expect(result.systemPrompt.indexOf("IDENTITY 1")).toBeLessThan(
      result.systemPrompt.indexOf("COMMUNICATION STYLE:"),
    );
    expect(result.systemPrompt.indexOf("COMMUNICATION STYLE:")).toBeLessThan(
      result.systemPrompt.indexOf("Reaction-triggered requests may appear"),
    );
  });

  it("includes the skin guideline only when both theme and personality are available", async () => {
    const guidance = createAgentPromptGuidance(
      createDeps({
        getActiveSkinTheme: () => "ocean-mist",
        getAgentPersonality: () => "steady, elegant, observant",
      }),
    );

    const result = await guidance.beforeAgentStart({ systemPrompt: "BASE" });

    expect(result.systemPrompt).toContain("PINET SKIN (");
    expect(result.systemPrompt).toContain("steady, elegant, observant");
  });

  it("adds loaded broker MD guidance, protocol guardrails, and tool guardrails for the broker role", async () => {
    const guidance = createAgentPromptGuidance(
      createDeps({
        getBrokerRole: () => "broker",
      }),
    );

    const result = await guidance.beforeAgentStart({ systemPrompt: "BASE" });

    expect(result.systemPrompt).toContain("PINET PRIMER:");
    expect(result.systemPrompt).toContain("pointer=pinet action=read args.thread_id=...");
    expect(result.systemPrompt).toContain("action parameters inside `args`");
    expect(result.systemPrompt).toContain("You are 🦩 Cobalt Olive Crane, the Pinet BROKER.");
    expect(result.systemPrompt).toContain("CUSTOM MD POLICY");
    expect(result.systemPrompt).toContain("DELEGATE, THEN TRACK.");
    expect(result.systemPrompt).toContain("🔒 BROKER PROTOCOL BOUNDARY:");
    expect(result.systemPrompt).toContain("🚫 BROKER TOOL RESTRICTION:");
    expect(result.systemPrompt).not.toContain("TASK WORKFLOW:");
  });

  it("adds worker workflow guidance for follower runtimes", async () => {
    const guidance = createAgentPromptGuidance(
      createDeps({
        getBrokerRole: () => "follower",
      }),
    );

    const result = await guidance.beforeAgentStart({ systemPrompt: "BASE" });

    expect(result.systemPrompt).toContain("PINET PRIMER:");
    expect(result.systemPrompt).toContain("`read` retrieves durable inbox context");
    expect(result.systemPrompt).toContain(
      "TASK WORKFLOW: When you receive work, follow these steps:",
    );
    expect(result.systemPrompt).toContain("REPLY TOOL RULES:");
    expect(result.systemPrompt).not.toContain("Pinet BROKER");
    expect(result.systemPrompt).not.toContain("🚫 BROKER TOOL RESTRICTION:");
  });

  it("keeps broker prompt order: base, shared guidance, loaded MD, protocol boundary, tool restriction", async () => {
    const guidance = createAgentPromptGuidance(
      createDeps({
        getBrokerRole: () => "broker",
        loadBrokerPrompt: async () => ({
          source: "workspace",
          content: "LOADED BROKER MD",
          warnings: [],
          diagnostic: "broker prompt: workspace override loaded",
        }),
      }),
    );

    const result = await guidance.beforeAgentStart({ systemPrompt: "BASE" });

    expect(result.systemPrompt.indexOf("BASE")).toBeLessThan(
      result.systemPrompt.indexOf("IDENTITY 1"),
    );
    expect(result.systemPrompt.indexOf("IDENTITY 1")).toBeLessThan(
      result.systemPrompt.indexOf("PINET PRIMER:"),
    );
    expect(result.systemPrompt.indexOf("PINET PRIMER:")).toBeLessThan(
      result.systemPrompt.indexOf("LOADED BROKER MD"),
    );
    expect(result.systemPrompt.indexOf("LOADED BROKER MD")).toBeLessThan(
      result.systemPrompt.indexOf("🔒 BROKER PROTOCOL BOUNDARY:"),
    );
    expect(result.systemPrompt.indexOf("🔒 BROKER PROTOCOL BOUNDARY:")).toBeLessThan(
      result.systemPrompt.indexOf("🚫 BROKER TOOL RESTRICTION:"),
    );
  });

  it("reports broker prompt loader diagnostics without exposing prompt content", async () => {
    const reportBrokerPromptWarning = vi.fn();
    const reportBrokerPromptDiagnostic = vi.fn();
    const guidance = createAgentPromptGuidance(
      createDeps({
        getBrokerRole: () => "broker",
        reportBrokerPromptWarning,
        reportBrokerPromptDiagnostic,
        loadBrokerPrompt: async () => ({
          source: "user",
          content: "PRIVATE PROMPT BODY",
          diagnostic: "broker prompt: user-local override loaded",
          warnings: [
            {
              source: "workspace",
              reason: "too_large",
              message: "broker prompt: workspace override rejected (over 65536 bytes); continuing",
            },
          ],
        }),
      }),
    );

    const result = await guidance.beforeAgentStart({ systemPrompt: "BASE" });

    expect(reportBrokerPromptWarning).toHaveBeenCalledWith(
      "[slack-bridge] broker prompt: workspace override rejected (over 65536 bytes); continuing",
    );
    expect(reportBrokerPromptDiagnostic).toHaveBeenCalledWith(
      "[slack-bridge] broker prompt: user-local override loaded",
    );
    expect(String(reportBrokerPromptWarning.mock.calls)).not.toContain("PRIVATE PROMPT BODY");
    expect(String(reportBrokerPromptDiagnostic.mock.calls)).not.toContain("PRIVATE PROMPT BODY");
    expect(result.systemPrompt).toContain("PRIVATE PROMPT BODY");
  });

  it("keeps identity guidance ahead of follower workflow guidance", async () => {
    const guidance = createAgentPromptGuidance(
      createDeps({
        getBrokerRole: () => "follower",
      }),
    );

    const result = await guidance.beforeAgentStart({ systemPrompt: "BASE" });

    expect(result.systemPrompt.indexOf("IDENTITY 1")).toBeLessThan(
      result.systemPrompt.indexOf("TASK WORKFLOW:"),
    );
    expect(result.systemPrompt.indexOf("TASK WORKFLOW:")).toBeLessThan(
      result.systemPrompt.indexOf("HELPER / DELEGATION RULES:"),
    );
  });
});
