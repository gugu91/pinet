#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { chatDaemonAddress } from "./daemon.js";
import { SqliteChatStorage } from "./sqlite-storage.js";
import { createChatApp, parseCredentials } from "./server.js";

const { hostname, port } = chatDaemonAddress();
const database = process.env.PINET_CHAT_DB ?? "pinet-chat.sqlite";
const encoded = process.env.PINET_CHAT_CREDENTIALS;
if (!encoded)
  throw new Error("PINET_CHAT_CREDENTIALS must be a JSON array of {token,principal:{kind,id}}");
const credentials = parseCredentials(encoded);
const storage = new SqliteChatStorage(database);
serve({ fetch: createChatApp({ storage, credentials }).fetch, hostname, port }, (info) =>
  console.log(`Pinet chat listening on http://${hostname}:${info.port}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    storage.close();
    process.exit(0);
  });
