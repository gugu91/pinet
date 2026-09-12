import { describe, expect, it, vi } from "vitest";
import { PM_PROMPT, registerPm } from "./index.js";
describe("Pinet PM opt-in", () => {
  it("does not alter prompts until explicitly enabled and stops after disable", async () => {
    let before: (event: { systemPrompt: string }) => { systemPrompt: string } | undefined = () =>
      undefined;
    let command: (
      args: string,
      ctx: { ui: { notify: () => void } },
    ) => Promise<void> = async () => {};
    const pi = {
      on: vi.fn((_name: string, handler: typeof before) => {
        before = handler;
      }),
      registerCommand: vi.fn((_name: string, value: { handler: typeof command }) => {
        command = value.handler;
      }),
    };
    registerPm(pi as never);
    expect(before({ systemPrompt: "base" })).toBeUndefined();
    await command("enable", { ui: { notify: () => {} } });
    expect(before({ systemPrompt: "base" })?.systemPrompt).toContain(PM_PROMPT);
    await command("disable", { ui: { notify: () => {} } });
    expect(before({ systemPrompt: "base" })).toBeUndefined();
  });
});
