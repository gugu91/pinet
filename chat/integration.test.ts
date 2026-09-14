import { serve } from "@hono/node-server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ChatClient } from "./client.js";
import { createChatApp } from "./server.js";
import { SqliteChatStorage } from "./sqlite-storage.js";
const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((run) => run()),
);

it("runs the built-style HTTP client/server contract against temporary SQLite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pinet-chat-integration-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const storage = new SqliteChatStorage(join(directory, "chat.sqlite"));
  cleanup.push(() => storage.close());
  const app = createChatApp({
    storage,
    credentials: [{ token: "secret", principal: { kind: "agent", id: "agent" } }],
  });
  const server = serve({ fetch: app.fetch, port: 0 });
  cleanup.push(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  const client = new ChatClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: "secret",
    agentId: "agent",
  });
  const created = (await client.call("POST", "/v1/channels", { name: "integration" })) as {
    data: { id: string };
  };
  const listed = (await client.call("GET", "/v1/channels")) as { data: Array<{ id: string }> };
  expect(listed.data).toEqual([expect.objectContaining({ id: created.data.id })]);
});
