#!/usr/bin/env node
import * as fs from "node:fs";
import { parseArgs } from "node:util";
import { BrokerClient, DEFAULT_SOCKET_PATH } from "./broker/client.js";
import { parseWorkerIdentity } from "./broker/worker-keys.js";
import { loadSettings, resolvePinetMeshAuth } from "./helpers.js";
import { writeJoinFile } from "./join-file.js";

const USAGE = `Usage:
  pinet-worker issue --host <id> --worker <id> --join-socket <path> --out <file>
  pinet-worker revoke --host <id> --worker <id>
  pinet-worker list
Options:
  --broker-socket <path>  Broker socket to manage (default: PINET_SOCKET_PATH or ~/.pi/pinet.sock)
  --join-socket <path>    Socket path the worker will connect to (differs when forwarded over SSH)`;

const {
  positionals: [action],
  values,
} = parseArgs({
  allowPositionals: true,
  options: {
    host: { type: "string" },
    worker: { type: "string" },
    "join-socket": { type: "string" },
    out: { type: "string" },
    "broker-socket": { type: "string" },
  },
});
const required = (name: "host" | "worker" | "join-socket" | "out"): string => {
  const value = values[name];
  if (!value) {
    console.error(`--${name} is required.\n\n${USAGE}`);
    process.exit(2);
  }
  return value;
};
if (action !== "issue" && action !== "revoke" && action !== "list") {
  console.error(USAGE);
  process.exit(2);
}

const meshAuth = resolvePinetMeshAuth(loadSettings());
const client = new BrokerClient({
  path: values["broker-socket"] ?? process.env.PINET_SOCKET_PATH ?? DEFAULT_SOCKET_PATH,
  ...(meshAuth.meshSecret ? { meshSecret: meshAuth.meshSecret } : {}),
  ...(meshAuth.meshSecretPath ? { meshSecretPath: meshAuth.meshSecretPath } : {}),
});
try {
  if (action === "list") {
    await client.connect();
    console.log(JSON.stringify(await client.listWorkerKeys(), null, 2));
  } else {
    const identity = parseWorkerIdentity(required("host"), required("worker"));
    if (action === "revoke") {
      await client.connect();
      console.log(JSON.stringify(await client.revokeWorkerKey(identity)));
    } else {
      const out = required("out");
      const socket = required("join-socket");
      // Check first: issuing rotates the key, so a failed save would cut off the old key for nothing.
      if (fs.existsSync(out)) throw new Error(`${out} already exists.`);
      await client.connect();
      const issued = await client.issueWorkerKey(identity);
      try {
        writeJoinFile(out, { socket, key: issued.key });
      } catch (error) {
        throw new Error(
          `Key issued but not saved (${error instanceof Error ? error.message : String(error)}). Run issue again to rotate to a new key.`,
        );
      }
      console.log(JSON.stringify({ stableId: issued.stableId, joinFile: out }));
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  client.disconnect();
}
