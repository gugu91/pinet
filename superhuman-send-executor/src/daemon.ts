#!/usr/bin/env node
import { createServer } from "node:http";
import { chmodSync, readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Executor } from "./executor.js";
import { Journal } from "./journal.js";
import { JsonlAudit } from "./audit.js";
import { KeychainShmProvider } from "./keychain-provider.js";
import type { ExecuteRequest } from "./contracts.js";
const ROOT = "/var/db/pinet-superhuman-send-executor";
const SOCKET = "/var/run/pinet-superhuman-send-executor.sock";
const policy = JSON.parse(readFileSync(`${ROOT}/trust-policy.json`, "utf8")) as {
  issuerKeyId: string;
  issuerPublicKeyPem: string;
  expectedUserId: string;
  processInstanceId: string;
  brokerCoreVersion: string;
};
if (policy.brokerCoreVersion !== "0.2.4") throw new Error("broker_core_version_mismatch");
const executor = new Executor(
  new Journal(`${ROOT}/journal.sqlite`),
  new KeychainShmProvider(),
  policy,
  new JsonlAudit(`${ROOT}/audit.jsonl`),
);
try {
  unlinkSync(SOCKET);
} catch {
  /* absent */
}
const server = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.method === "GET" && req.url?.startsWith("/v1/status/")) {
    const status = executor.status(decodeURIComponent(req.url.slice(11)));
    res.statusCode = status ? 200 : 404;
    res.end(JSON.stringify(status ?? { error: "not_found" }));
    return;
  }
  if (req.method !== "POST" || req.url !== "/v1/execute") {
    res.statusCode = 404;
    res.end('{"error":"not_found"}');
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const value = Buffer.from(chunk);
    size += value.length;
    if (size > 256 * 1024) {
      res.statusCode = 413;
      res.end('{"error":"too_large"}');
      return;
    }
    chunks.push(value);
  }
  try {
    const status = await executor.execute(
      JSON.parse(Buffer.concat(chunks).toString("utf8")) as ExecuteRequest,
    );
    res.statusCode = 202;
    res.end(JSON.stringify(status));
  } catch (error) {
    res.statusCode = 400;
    res.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : "invalid_request",
        requestId: randomUUID(),
      }),
    );
  }
});
server.listen(SOCKET, () => chmodSync(SOCKET, 0o600));
