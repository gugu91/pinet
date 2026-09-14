import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { Miniflare } from "miniflare";
import chatWorker, { ChatDurableObject, type ChatWorkerEnv } from "./cloudflare.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const defaultCredentials = [
  { token: "agent-secret", principal: { kind: "agent", id: "agent" } },
  { token: "host-secret", principal: { kind: "host", id: "host" } },
];

function miniflareOptions(persist: string, credentials: object[] = defaultCredentials) {
  const scriptPath = join(persist, "chat-worker.mjs");
  buildSync({
    entryPoints: [new URL("./cloudflare.ts", import.meta.url).pathname],
    outfile: scriptPath,
    bundle: true,
    format: "esm",
    platform: "neutral",
    external: ["node:*"],
  });
  return {
    modules: true as const,
    script: readFileSync(scriptPath, "utf8"),
    compatibilityDate: "2025-04-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { CHAT: { className: "ChatDurableObject", useSQLite: true } },
    durableObjectsPersist: persist,
    bindings: { PINET_CHAT_CREDENTIALS: JSON.stringify(credentials) },
  };
}

function createMiniflare(persist: string, credentials: object[] = defaultCredentials): Miniflare {
  return new Miniflare(miniflareOptions(persist, credentials));
}

describe("Chat Durable Object parity", () => {
  it("returns 409 and preserves both channels on a duplicate rename", async () => {
    const persist = mkdtempSync(join(tmpdir(), "chat-rename-"));
    directories.push(persist);
    const mf = createMiniflare(persist);
    const headers = { authorization: "Bearer agent-secret", "content-type": "application/json" };
    try {
      const ids: string[] = [];
      for (const name of ["first", "second"]) {
        const response = await mf.dispatchFetch("http://local/v1/channels", {
          method: "POST",
          headers,
          body: JSON.stringify({ name, topic: "original" }),
        });
        expect(response.status).toBe(201);
        ids.push(((await response.json()) as { data: { id: string } }).data.id);
      }
      const conflict = await mf.dispatchFetch(`http://local/v1/channels/${ids[1]}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ name: "first", topic: "changed" }),
      });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ error: { code: "conflict" } });
      for (const [index, name] of ["first", "second"].entries()) {
        const response = await mf.dispatchFetch(`http://local/v1/channels/${ids[index]}`, {
          headers,
        });
        expect(await response.json()).toMatchObject({ data: { name, topic: "original" } });
      }
      const unchangedName = await mf.dispatchFetch(`http://local/v1/channels/${ids[1]}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ name: "second", topic: "updated" }),
      });
      expect(unchangedName.status).toBe(200);
    } finally {
      await mf.dispose();
    }
  });
  it("authenticates and authorizes configured workspace claims before selecting a Durable Object", async () => {
    const selected: string[] = [];
    let forwarded: Request | undefined;
    const env = {
      PINET_CHAT_CREDENTIALS: JSON.stringify([
        {
          token: "workspace-secret",
          principal: { kind: "agent", id: "agent" },
          workspace: "authorized-team",
        },
      ]),
      CHAT: {
        idFromName(name: string) {
          selected.push(name);
          return { name };
        },
        get() {
          return {
            fetch(request: Request) {
              forwarded = request;
              return Promise.resolve(Response.json({ ok: true }));
            },
          };
        },
      },
    } as object as ChatWorkerEnv;

    const unauthorized = await chatWorker.fetch(
      new Request("https://chat.test/v1/channels", {
        headers: { authorization: "Bearer invalid", "x-pinet-workspace": "attacker" },
      }),
      env,
    );
    expect(unauthorized.status).toBe(401);
    expect(selected).toEqual([]);

    const authorized = await chatWorker.fetch(
      new Request("https://chat.test/v1/channels", {
        headers: {
          authorization: "Bearer workspace-secret",
          "x-pinet-workspace": "attacker",
          "x-pinet-internal-workspace": "attacker",
          "x-pinet-internal-credentials": "attacker-secret",
        },
      }),
      env,
    );
    expect(authorized.status).toBe(200);
    expect(selected).toEqual(["authorized-team"]);
    expect(forwarded?.headers.get("x-pinet-workspace")).toBeNull();
    expect(forwarded?.headers.get("x-pinet-internal-workspace")).toBe("authorized-team");
    expect(forwarded?.headers.get("x-pinet-internal-credentials")).toBe(env.PINET_CHAT_CREDENTIALS);
  });

  it("applies configured credential rotation to the same warm Durable Object instance", async () => {
    const durableObject = new ChatDurableObject({
      storage: {
        sql: {
          exec<T extends object>(): Iterable<T> {
            return [];
          },
        },
        transactionSync<T>(callback: () => T): T {
          return callback();
        },
      },
    });
    const request = (token: string, credentials: object[]) =>
      durableObject.fetch(
        new Request("http://internal/v1/channels", {
          headers: {
            authorization: `Bearer ${token}`,
            "x-pinet-internal-workspace": "team",
            "x-pinet-internal-credentials": JSON.stringify(credentials),
          },
        }),
      );
    const oldCredentials = [
      { token: "old-secret", principal: { kind: "agent", id: "agent" }, workspace: "team" },
    ];
    const newCredentials = [
      { token: "new-secret", principal: { kind: "agent", id: "agent" }, workspace: "team" },
    ];

    expect((await request("old-secret", oldCredentials)).status).toBe(200);
    expect((await request("old-secret", newCredentials)).status).toBe(401);
    expect((await request("new-secret", newCredentials)).status).toBe(200);
  });

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
    const claimed = responses.find((response) => response.status === 200)!;
    const launch = (await claimed.json()) as { launch: { token: string } };
    expect(
      (
        await mf.dispatchFetch("http://local/v1/channels", {
          headers: { authorization: `Bearer ${launch.launch.token}` },
        })
      ).status,
    ).toBe(200);
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
