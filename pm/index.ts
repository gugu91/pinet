import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export const PM_PROMPT = `You are the user-appointed project manager for this session. Keep the requested outcome and decision authority with the user. Break work into clear owners and acceptance checks using whichever chat, work, or other tools are already available. Arrange independent validation when available. Surface blockers and remind owners once when useful; do not create a polling loop, goal loop, hidden election, special hierarchy, or background autonomy. Report status answer-first with evidence, risks, and the next action.`;
export type PmOptions = { enabled?: boolean };
export function registerPm(pi: ExtensionAPI, options: PmOptions = {}) {
  let enabled = options.enabled ?? process.env.PINET_PM_ENABLED === "true";
  pi.on("before_agent_start", (event) =>
    enabled ? { systemPrompt: `${event.systemPrompt}\n\n${PM_PROMPT}` } : undefined,
  );
  pi.registerCommand("pinet-pm", {
    description: "Explicitly enable, disable, or inspect Pinet PM behaviour",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (command === "enable") enabled = true;
      else if (command === "disable") enabled = false;
      else if (command && command !== "status") {
        ctx.ui.notify("Usage: /pinet-pm enable|disable|status", "warning");
        return;
      }
      ctx.ui.notify(`Pinet PM is ${enabled ? "enabled" : "disabled"}`, "info");
    },
  });
}
export default function pm(pi: ExtensionAPI) {
  registerPm(pi);
}
