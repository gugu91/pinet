import { describe, expect, it, vi } from "vitest";
import {
  createAgentPromptGuidance,
  type AgentPromptGuidanceDeps,
} from "./agent-prompt-guidance.js";
import { setDiagnosticSink, type DiagnosticLevel } from "@pinet/transport-core/diagnostics";

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
    ...overrides,
  };
}

async function renderGuidance(deps: AgentPromptGuidanceDeps): Promise<string> {
  return (await createAgentPromptGuidance(deps).buildPromptGuidelines()).join("\n");
}

describe("createAgentPromptGuidance", () => {
  it("builds shared identity, personality, and reaction guidance", async () => {
    const getIdentityGuidelines = vi.fn(() => ["IDENTITY 1", "IDENTITY 2", "IDENTITY 3"]);

    const result = await renderGuidance(createDeps({ getIdentityGuidelines }));

    expect(getIdentityGuidelines).toHaveBeenCalledTimes(1);
    expect(result).toContain("IDENTITY 1\nIDENTITY 2\nIDENTITY 3");
    expect(result).toContain("COMMUNICATION STYLE:");
    expect(result).toContain("For `Cobalt Olive Crane`, aim for a");
    expect(result).toContain("Slack emoji reactions are ignored by default");
    expect(result).not.toContain("PINET SKIN (");
    expect(result).not.toContain("Pinet BROKER");
    expect(result).not.toContain("TASK WORKFLOW:");
    expect(result.indexOf("IDENTITY 1")).toBeLessThan(result.indexOf("COMMUNICATION STYLE:"));
    expect(result.indexOf("COMMUNICATION STYLE:")).toBeLessThan(
      result.indexOf("Slack emoji reactions are ignored by default"),
    );
  });

  it("includes the skin guideline only when both theme and personality are available", async () => {
    const result = await renderGuidance(
      createDeps({
        getActiveSkinTheme: () => "ocean-mist",
        getAgentPersonality: () => "steady, elegant, observant",
      }),
    );

    expect(result).toContain("PINET SKIN (");
    expect(result).toContain("steady, elegant, observant");
  });

  it("adds loaded broker guidance and guardrails for the broker role", async () => {
    const result = await renderGuidance(createDeps({ getBrokerRole: () => "broker" }));

    expect(result).toContain("You are 🦩 Cobalt Olive Crane, the Pinet BROKER.");
    expect(result).toContain("CUSTOM MD POLICY");
    expect(result).toContain("DELEGATE, THEN TRACK.");
    expect(result).toContain("🔒 BROKER PROTOCOL BOUNDARY:");
    expect(result).toContain("🚫 BROKER TOOL RESTRICTION:");
    expect(result).not.toContain("TASK WORKFLOW:");
  });

  it("adds worker workflow guidance for follower runtimes", async () => {
    const result = await renderGuidance(createDeps({ getBrokerRole: () => "follower" }));

    expect(result).toContain("TASK WORKFLOW: When you receive work, follow these steps:");
    expect(result).toContain("REPLY TOOL RULES:");
    expect(result).not.toContain("Pinet BROKER");
    expect(result).not.toContain("🚫 BROKER TOOL RESTRICTION:");
    expect(result.indexOf("IDENTITY 1")).toBeLessThan(result.indexOf("TASK WORKFLOW:"));
    expect(result.indexOf("TASK WORKFLOW:")).toBeLessThan(
      result.indexOf("HELPER / DELEGATION RULES:"),
    );
  });

  it("keeps broker guidance in the required order", async () => {
    const result = await renderGuidance(
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

    expect(result.indexOf("IDENTITY 1")).toBeLessThan(result.indexOf("LOADED BROKER MD"));
    expect(result.indexOf("LOADED BROKER MD")).toBeLessThan(
      result.indexOf("🔒 BROKER PROTOCOL BOUNDARY:"),
    );
    expect(result.indexOf("🔒 BROKER PROTOCOL BOUNDARY:")).toBeLessThan(
      result.indexOf("🚫 BROKER TOOL RESTRICTION:"),
    );
  });

  it("reports broker prompt loader diagnostics without exposing prompt content", async () => {
    const diagnostics: Array<[DiagnosticLevel, string]> = [];
    setDiagnosticSink((level, message) => diagnostics.push([level, message]));
    let result: string;
    try {
      result = await renderGuidance(
        createDeps({
          getBrokerRole: () => "broker",
          loadBrokerPrompt: async () => ({
            source: "user",
            content: "PRIVATE PROMPT BODY",
            diagnostic: "broker prompt: user-local override loaded",
            warnings: [
              {
                source: "workspace",
                reason: "too_large",
                message:
                  "broker prompt: workspace override rejected (over 65536 bytes); continuing",
              },
            ],
          }),
        }),
      );
    } finally {
      setDiagnosticSink(null);
    }

    expect(diagnostics).toEqual([
      [
        "warning",
        "[slack-bridge] broker prompt: workspace override rejected (over 65536 bytes); continuing",
      ],
      ["info", "[slack-bridge] broker prompt: user-local override loaded"],
    ]);
    expect(result).toContain("PRIVATE PROMPT BODY");
  });
});
