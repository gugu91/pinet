#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { createWorkApp, parseTokens } from "./server.js";
import { SqliteWorkStorage } from "./storage.js";
const encoded = process.env.PINET_WORK_TOKENS;
if (!encoded) throw new Error("PINET_WORK_TOKENS must be a JSON string array");
const storage = new SqliteWorkStorage(process.env.PINET_WORK_DB ?? "pinet-work.sqlite");
serve(
  {
    fetch: createWorkApp({ storage, tokens: parseTokens(encoded) }).fetch,
    hostname: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 8788),
  },
  (info) => console.log(`Pinet work listening on http://${info.address}:${info.port}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    storage.close();
    process.exit(0);
  });
