import { describe, expect, it, vi } from "vitest";
import {
  initTheme,
  ModelSelectorComponent,
  type ModelRuntime,
  type RegistryModel,
} from "@earendil-works/pi-coding-agent";

// Drives Pi's real /model component against the same registry-backed adapter
// index.ts builds, so a Pi upgrade that makes the picker call a fifth runtime
// method fails here instead of as a TypeError in the user's terminal.
describe("ModelSelectorComponent on the registry adapter", () => {
  it("constructs, filters, selects, and only touches the four adapted methods", async () => {
    initTheme();
    const shape = { api: "anthropic-messages", contextWindow: 200_000, maxTokens: 8_000 };
    const haiku = { ...shape, provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku" };
    const sonnet = { ...shape, provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet" };
    const offScope = { ...shape, provider: "openai", id: "gpt-5-mini", name: "Mini" };
    const all: RegistryModel[] = [haiku, sonnet, offScope];
    const registry = {
      getAvailable: vi.fn(() => all),
      find: vi.fn((provider: string, id: string) =>
        all.find((model) => model.provider === provider && model.id === id),
      ),
      getError: vi.fn(() => undefined),
      refresh: vi.fn(async (_options?: { signal?: AbortSignal }) => ({
        aborted: false,
        errors: new Map<string, Error>(),
      })),
    };
    const runtime: ModelRuntime = {
      getAvailableSnapshot: () => registry.getAvailable(),
      getModel: (provider, modelId) => registry.find(provider, modelId),
      getError: () => registry.getError(),
      refresh: (options) => registry.refresh(options),
    };
    const picked: RegistryModel[] = [];
    let cancelled = false;
    const component = new ModelSelectorComponent(
      { requestRender: () => {} },
      haiku,
      runtime,
      [{ model: haiku }, { model: sonnet, thinkingLevel: "high" }],
      (model) => picked.push(model),
      () => (cancelled = true),
    );
    const strip = (line: string) =>
      line
        .split("\u001b")
        .map((part, index) => (index === 0 ? part : part.replace(/^\[[0-9;]*m/, "")))
        .join("");
    const visible = () => component.render(100).map(strip).join("\n");

    // Scoped view: shortlist only, current model ticked.
    expect(visible()).toContain("✓ claude-haiku-4-5");
    expect(visible()).toContain("claude-sonnet-4-5");
    expect(visible()).not.toContain("gpt-5-mini");

    // Background catalog refresh settles through the adapter (refresh → getError).
    await vi.waitFor(() => expect(registry.getError).toHaveBeenCalled());
    expect(registry.refresh).toHaveBeenCalled();
    expect(registry.getAvailable).toHaveBeenCalled();
    expect(registry.find).toHaveBeenCalledWith("anthropic", "claude-haiku-4-5");

    for (const char of "sonn") component.handleInput(char);
    expect(visible()).not.toContain("claude-haiku-4-5");
    component.handleInput("\r");

    expect(picked.map((model) => `${model.provider}/${model.id}`)).toEqual([
      "anthropic/claude-sonnet-4-5",
    ]);
    expect(cancelled).toBe(false);
    component.dispose();
  });
});
