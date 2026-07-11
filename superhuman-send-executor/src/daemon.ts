#!/usr/bin/env node
import { createServer } from "node:http";
import { chmodSync, chownSync, readFileSync, unlinkSync } from "node:fs";
import { Executor } from "./executor.js";
import { Journal } from "./journal.js";
import { JsonlAudit } from "./audit.js";
import { KeychainShmProvider } from "./keychain-provider.js";
import { parseExecuteRequest, parseJson, parseTrustPolicy } from "./parse.js";
const ROOT = "/var/db/pinet-superhuman-send-executor";
const SOCKET = "/var/run/pinet-superhuman-send-executor.sock";
const policy = parseTrustPolicy(parseJson(readFileSync(`${ROOT}/trust-policy.json`, "utf8")));
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
  // Socket is absent on first start.
}
const server = createServer((req, res) => {
  void (async () => {
    res.setHeader("content-type", "application/json");
    try {
      if (req.method === "GET" && req.url?.startsWith("/v1/status/")) {
        const receiptId = decodeURIComponent(req.url.slice(11));
        if (!/^[A-Za-z0-9._:@-]{1,128}$/.test(receiptId)) throw new Error("invalid_receipt_id");
        const status = executor.status(receiptId);
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
      const status = await executor.execute(
        parseExecuteRequest(parseJson(Buffer.concat(chunks).toString("utf8"))),
      );
      res.statusCode = 202;
      res.end(JSON.stringify(status));
    } catch {
      if (!res.headersSent) res.statusCode = 400;
      if (!res.writableEnded) res.end('{"error":"invalid_request"}');
    }
  })();
});
server.headersTimeout = 5_000;
server.requestTimeout = 10_000;
server.keepAliveTimeout = 2_000;
server.maxRequestsPerSocket = 8;
server.listen(SOCKET, () => {
  chownSync(SOCKET, 0, policy.callerGid);
  chmodSync(SOCKET, 0o660);
});
