#!/usr/bin/env node
import * as path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { BrokerDB } from "./broker/schema.js";
import { HostRunner, type RuntimeKind } from "./host-runner.js";
import { writeJoinProfile, type JoinProfile } from "./join-profile.js";
import { assertPrivateTcpHost } from "./broker/private-network.js";

/** Local operator entrypoint. Never prints bearer material or implements remote execution. */
export async function runHostCli(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      db: { type: "string" },
      host: { type: "string" },
      worker: { type: "string" },
      out: { type: "string" },
      socket: { type: "string" },
      address: { type: "string" },
      port: { type: "string" },
      credential: { type: "string" },
      root: { type: "string" },
      capacity: { type: "string" },
      runtime: { type: "string" },
      cwd: { type: "string" },
      profile: { type: "string" },
      handle: { type: "string" },
      text: { type: "string" },
    },
  });
  if (values.help || positionals.length === 0) {
    console.log(
      "Usage: pinet-host issue|revoke|report|start|send|read|status|stop|attach [options] [-- command...]\nissue: --db DB --host HOST --worker WORKER --cwd REPO --out PROFILE (--socket PATH | --address PRIVATE_IP --port PORT)\nrevoke: --db DB (--credential ID | --host HOST)\nstart: --root DIR --runtime shell|tmux|rex --profile PROFILE --cwd REPO [--capacity N] -- COMMAND...\nreport: --root DIR --cwd REPO\nsend/read/status/stop/attach: --root DIR --handle FILE [--text TEXT]\nSee docs/worker-membership.md. Credentials are written only to owner-only profile files.",
    );
    return;
  }
  const [action, ...command] = positionals;
  const required = (name: keyof typeof values): string => {
    const value = values[name];
    if (typeof value !== "string" || !value) throw new Error(`Missing --${name}`);
    return value;
  };
  if (action === "issue" || action === "revoke") {
    const db = new BrokerDB(required("db"));
    db.initialize();
    try {
      if (action === "revoke") {
        if (values.host) db.membership.revokeHost(values.host);
        else db.membership.revoke(required("credential"));
        console.log(JSON.stringify({ status: "revoked" }));
      } else {
        const endpoint: JoinProfile["endpoint"] = values.socket
          ? { path: path.resolve(values.socket) }
          : { host: required("address"), port: Number(required("port")), privateNetwork: true };
        if ("host" in endpoint) {
          assertPrivateTcpHost(endpoint.host, true);
          if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535)
            throw new Error("Port must be between 1 and 65535");
        }
        const profile = {
          version: 1 as const,
          ...db.membership.issue(required("host"), required("worker")),
          endpoint,
          repos: [path.resolve(required("cwd"))],
          capabilities: ["pinet"],
        };
        writeJoinProfile(required("out"), profile);
        console.log(JSON.stringify({ status: "issued", credentialId: profile.credentialId }));
      }
    } finally {
      db.close();
    }
    return;
  }
  const runner = new HostRunner(required("root"), Number(values.capacity ?? "1")); // agent-default (not a user rule): one local worker.
  if (action === "report") {
    console.log(JSON.stringify(runner.report([path.resolve(required("cwd"))])));
    return;
  }
  if (action === "start") {
    const runtime = required("runtime");
    if (!["shell", "tmux", "rex"].includes(runtime))
      throw new Error("Supported runtimes: shell, tmux, rex. Herdr/SSH adapters are not verified.");
    const handle = await runner.start(runtime as RuntimeKind, {
      profilePath: required("profile"),
      cwd: path.resolve(required("cwd")),
      command,
    });
    console.log(
      JSON.stringify({
        handle: path.join(handle.directory, "handle.json"),
        runtime: handle.kind,
        id: handle.id,
      }),
    );
    return;
  }
  const handle = runner.load(required("handle"));
  switch (action) {
    case "send":
      runner.send(handle, required("text"));
      break;
    case "read":
      console.log(runner.read(handle));
      break;
    case "status":
      console.log(runner.status(handle));
      break;
    case "stop":
      runner.stop(handle);
      break;
    case "attach":
      console.log(JSON.stringify({ command: runner.attachCommand(handle) }));
      break;
    default:
      throw new Error(
        "Usage: pinet-host issue|revoke|report|start|send|read|status|stop|attach [options] [-- command...]",
      );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHostCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : "Pinet host command failed");
    process.exitCode = 1;
  });
}
