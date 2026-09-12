import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { Miniflare } from "miniflare";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function createMiniflare(persist: string): Miniflare {
  const scriptPath = join(persist, "chat-worker.mjs");
  buildSync({
    entryPoints: [new URL("./cloudflare.ts", import.meta.url).pathname],
    outfile: scriptPath,
    bundle: true,
    format: "esm",
    platform: "neutral",
    external: ["node:*"],
  });
  return new Miniflare({
    modules: true,
    script: readFileSync(scriptPath, "utf8"),
    compatibilityDate: "2025-04-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { CHAT: { className: "ChatDurableObject", useSQLite: true } },
    durableObjectsPersist: persist,
    bindings: {
      PINET_CHAT_CREDENTIALS: JSON.stringify([
        { token: "agent-secret", principal: { kind: "agent", id: "agent" } },
        { token: "host-secret", principal: { kind: "host", id: "host" } },
      ]),
    },
  });
}

describe("Chat Durable Object parity", () => {
  it("atomically allows exactly one concurrent runtime claim", async () => {
    const persist = mkdtempSync(join(tmpdir(), "pinet-chat-claim-do-"));
    directories.push(persist);
    const mf = createMiniflare(persist);
    const agentHeaders = {
      authorization: "Bearer agent-secret",
      "content-type": "application/json",
      "x-pinet-workspace": "claims",
    };
    const created = await mf.dispatchFetch("http://local/v1/runtime/requests", {
      method: "POST",
      headers: agentHeaders,
      body: JSON.stringify({ hostId: "host", prompt: "run" }),
    });
    expect(created.status).toBe(202);
    const requestId = ((await created.json()) as { data: { id: string } }).data.id;
    const claim = () =>
      mf.dispatchFetch(`http://local/v1/runtime/requests/${requestId}/claim`, {
        method: "POST",
        headers: {
          authorization: "Bearer host-secret",
          "content-type": "application/json",
          "x-pinet-workspace": "claims",
        },
      });
    const responses = await Promise.all([claim(), claim()]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    await mf.dispose();
  });

  it("persists authenticated channels and messages across emulator restart", async () => {
    const persist = mkdtempSync(join(tmpdir(), "pinet-chat-do-"));
    directories.push(persist);
    let mf = createMiniflare(persist);
    const headers = {
      authorization: "Bearer agent-secret",
      "content-type": "application/json",
      "x-pinet-workspace": "parity",
    };
    const channelResponse = await mf.dispatchFetch("http://local/v1/channels", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "persistent" }),
    });
    expect(channelResponse.status).toBe(201);
    const channel = (await channelResponse.json()) as { data: { id: string } };
    await mf.dispatchFetch("http://local/v1/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Agent", homeChannelId: channel.data.id }),
    });
    expect(
      (
        await mf.dispatchFetch(`http://local/v1/channels/${channel.data.id}/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify({ clientId: "one", markdown: "saved" }),
        })
      ).status,
    ).toBe(201);
    await mf.dispose();

    mf = createMiniflare(persist);
    const history = await mf.dispatchFetch(
      `http://local/v1/channels/${channel.data.id}/messages?after=0`,
      { headers },
    );
    expect(history.status).toBe(200);
    expect(((await history.json()) as { data: object[] }).data).toHaveLength(1);
    await mf.dispose();
  });
});
