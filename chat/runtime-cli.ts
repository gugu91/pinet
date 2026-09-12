#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HerdrRuntimeAdapter, ProcessRuntimeAdapter, TmuxRuntimeAdapter } from "./runtime.js";
import { RuntimeManager } from "./runtime-manager.js";

const baseUrl = process.env.PINET_CHAT_URL;
const token = process.env.PINET_HOST_TOKEN;
const hostId = process.env.PINET_HOST_ID;
if (!baseUrl || !token || !hostId)
  throw new Error("PINET_CHAT_URL, PINET_HOST_TOKEN, and PINET_HOST_ID are required");
const sessionDir = process.env.PINET_SESSION_DIR ?? join(homedir(), ".pi", "agent", "sessions");
mkdirSync(sessionDir, { recursive: true });
const manager = new RuntimeManager({
  baseUrl,
  token,
  hostId,
  sessionDir,
  adapters: {
    process: new ProcessRuntimeAdapter(),
    tmux: new TmuxRuntimeAdapter(),
    herdr: new HerdrRuntimeAdapter(),
  },
});
let stopped = false;
let delay = 1000;
// agent-standards-ignore prefer-inline-single-use-helper: named polling loop keeps lifecycle and signal handling separate.
async function run(): Promise<void> {
  while (!stopped) {
    try {
      await manager.poll();
      delay = 1000;
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      delay = Math.min(delay * 2, 30000);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopped = true;
    void manager.stopOwned();
  });
}
await run();
