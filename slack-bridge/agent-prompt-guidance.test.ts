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
  it("keeps only role-invariant reaction and broker guardrails in the system prompt", async () => {
    const getIdentityGuidelines = vi.fn(() => ["IDENTITY 1", "IDENTITY 2", "IDENTITY 3"]);
    const guidance = createAgentPromptGuidance(createDeps({ getIdentityGuidelines }));

    const result = await guidance.beforeAgentStart({ systemPrompt: "BASE" });

    expect(result.systemPrompt).toContain("BASE\n\nSlack emoji reactions are ignored by default");
    expect(result.systemPrompt).toContain("🔒 BROKER PROTOCOL BOUNDARY:");
    expect(result.systemPrompt).toContain("🚫 BROKER TOOL RESTRICTION:");
    expect(result.systemPrompt).not.toContain("IDENTITY 1");
    expect(result.systemPrompt).not.toContain("COMMUNICATION STYLE:");
    expect(result.systemPrompt).not.toContain("Pinet BROKER");
    expect(result.systemPrompt).not.toContain("TASK WORKFLOW:");
    expect(getIdentityGuidelines).not.toHaveBeenCalled();
  });

  it("puts mutable identity and personality guidance in context", async () => {
    const guidance = createAgentPromptGuidance(createDeps());

    const contextUpdate = await guidance.buildContextUpdate();

    expect(contextUpdate).toContain("PINET RUNTIME STATE: off.");
    expect(contextUpdate).toContain("IDENTITY 1\nIDENTITY 2\nIDENTITY 3");
    expect(contextUpdate).toContain("COMMUNICATION STYLE:");
    expect(contextUpdate).toContain("For `Cobalt Olive Crane`, aim for a");
    expect(contextUpdate).not.toContain("Slack emoji reactions are ignored by default");
  });

  it("includes the skin guideline in context only when theme and personality are available", async () => {
    const guidance = createAgentPromptGuidance(
      createDeps({
        getActiveSkinTheme: () => "ocean-mist",
        getAgentPersonality: () => "steady, elegant, observant",
      }),
    );

    const contextUpdate = await guidance.buildContextUpdate();

    expect(contextUpdate).toContain("PINET SKIN (");
    expect(contextUpdate).toContain("steady, elegant, observant");
  });

  it("loads broker MD into context while keeping broker guardrails in the stable system prompt", async () => {
    const guidance = createAgentPromptGuidance(
      createDeps({
        getBrokerRole: () => "broker",
      }),
    );

    const systemResult = await guidance.beforeAgentStart({ systemPrompt: "BASE" });
    const contextUpdate = await guidance.buildContextUpdate();

    expect(systemResult.systemPrompt).toContain("🔒 BROKER PROTOCOL BOUNDARY:");
    expect(systemResult.systemPrompt).toContain("🚫 BROKER TOOL RESTRICTION:");
    expect(contextUpdate).toContain("PINET RUNTIME STATE: broker.");
    expect(contextUpdate).toContain("You are 🦩 Cobalt Olive Crane, the Pinet BROKER.");
    expect(contextUpdate).toContain("CUSTOM MD POLICY");
    expect(contextUpdate).toContain("DELEGATE, THEN TRACK.");
    expect(contextUpdate).not.toContain("🚫 BROKER TOOL RESTRICTION:");
    expect(contextUpdate).not.toContain("TASK WORKFLOW:");
  });

  it("adds worker workflow guidance to follower context", async () => {
    const guidance = createAgentPromptGuidance(
      createDeps({
        getBrokerRole: () => "follower",
      }),
    );

    const contextUpdate = await guidance.buildContextUpdate();

    expect(contextUpdate).toContain("PINET RUNTIME STATE: follower.");
    expect(contextUpdate).toContain("TASK WORKFLOW: When you receive work, follow these steps:");
    expect(contextUpdate).toContain("REPLY TOOL RULES:");
    expect(contextUpdate).not.toContain("Pinet BROKER");
  });

  it("keeps context order: runtime state, shared identity, then role workflow", async () => {
    const guidance = createAgentPromptGuidance(
      createDeps({
        getBrokerRole: () => "follower",
      }),
    );

    const contextUpdate = await guidance.buildContextUpdate();

    expect(contextUpdate.indexOf("PINET RUNTIME STATE:")).toBeLessThan(
      contextUpdate.indexOf("IDENTITY 1"),
    );
    expect(contextUpdate.indexOf("IDENTITY 1")).toBeLessThan(
      contextUpdate.indexOf("TASK WORKFLOW:"),
    );
    expect(contextUpdate.indexOf("TASK WORKFLOW:")).toBeLessThan(
      contextUpdate.indexOf("HELPER / DELEGATION RULES:"),
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

    const contextUpdate = await guidance.buildContextUpdate();

    expect(reportBrokerPromptWarning).toHaveBeenCalledWith(
      "[slack-bridge] broker prompt: workspace override rejected (over 65536 bytes); continuing",
    );
    expect(reportBrokerPromptDiagnostic).toHaveBeenCalledWith(
      "[slack-bridge] broker prompt: user-local override loaded",
    );
    expect(String(reportBrokerPromptWarning.mock.calls)).not.toContain("PRIVATE PROMPT BODY");
    expect(String(reportBrokerPromptDiagnostic.mock.calls)).not.toContain("PRIVATE PROMPT BODY");
    expect(contextUpdate).toContain("PRIVATE PROMPT BODY");
  });

  it("keeps the system prompt byte-stable after a follower role and identity change", async () => {
    let role: "follower" | null = null;
    let name = "Cobalt Olive Crane";
    const guidance = createAgentPromptGuidance(
      createDeps({
        getAgentName: () => name,
        getIdentityGuidelines: () => [`IDENTITY ${name}`],
        getBrokerRole: () => role,
      }),
    );

    const beforeFollow = await guidance.beforeAgentStart({ systemPrompt: "BASE" });
    role = "follower";
    name = "Hyper Slate Horse";
    const afterFollow = await guidance.beforeAgentStart({ systemPrompt: "BASE" });
    const contextUpdate = await guidance.buildContextUpdate();

    expect(afterFollow.systemPrompt).toBe(beforeFollow.systemPrompt);
    expect(afterFollow.systemPrompt).not.toContain("Cobalt Olive Crane");
    expect(afterFollow.systemPrompt).not.toContain("Hyper Slate Horse");
    expect(afterFollow.systemPrompt).not.toContain("TASK WORKFLOW:");
    expect(contextUpdate).toContain("IDENTITY Hyper Slate Horse");
    expect(contextUpdate).toContain("TASK WORKFLOW:");
  });

  it("can build initial runtime context before the first agent turn", async () => {
    const guidance = createAgentPromptGuidance(
      createDeps({
        getBrokerRole: () => "follower",
      }),
    );

    const contextUpdate = await guidance.buildContextUpdate();

    expect(contextUpdate).toContain("PINET RUNTIME STATE: follower.");
    expect(contextUpdate).toContain("TASK WORKFLOW:");
  });

  it("revokes earlier role-specific guidance in the appended inactive snapshot", async () => {
    let role: "follower" | null = "follower";
    const guidance = createAgentPromptGuidance(
      createDeps({
        getBrokerRole: () => role,
      }),
    );

    const followerUpdate = await guidance.buildContextUpdate();
    role = null;
    const inactiveUpdate = await guidance.buildContextUpdate();

    expect(followerUpdate).toContain("TASK WORKFLOW:");
    expect(inactiveUpdate).toContain("PINET RUNTIME STATE: off.");
    expect(inactiveUpdate).toContain(
      "Do not apply earlier broker- or follower-specific workflow guidance",
    );
    expect(inactiveUpdate).not.toContain("TASK WORKFLOW:");
  });
});
