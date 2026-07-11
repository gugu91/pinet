import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BrokerDB } from "./schema.js";
import { BrokerSocketServer } from "./socket-server.js";
import { BrokerClient } from "./client.js";
import {
  HibernationOrchestrator,
  type HibernationCheckpointOutcome,
  type HibernationProcessController,
  type HibernationTmuxController,
  type RuntimeLaunchContext,
} from "@pinet/broker-core";
import type { AgentRuntimeSpecInput } from "./types.js";

/**
 * Isolated end-to-end hibernation vertical slice.
 *
 * Real SQLite (BrokerDB) + real BrokerSocketServer over loopback TCP + real
 * BrokerClient. Only the process and tmux adapters are faked. The fake tmux
 * adapter cold-launches a *real* replacement BrokerClient that re-registers
 * through the real socket server presenting the broker-issued wake fence, so
 * the accepted-generation enforcement, ordered inbox drain, and lifecycle
 * transitions are all exercised over the wire. No live broker/mesh is touched.
 */

const STABLE_ID = "host:session:e2eabcdef012";
const AGENT_NAME = "Sleepy Worker";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pinet-hib-e2e-"));
}

const AGENT_METADATA = {
  brokerManaged: true,
  brokerManagedBy: "broker-1",
  hibernateSafe: true,
  cwd: "/repo/wt",
  repoRoot: "/repo",
  worktreePath: "/repo/wt",
  tmuxSession: "worker-e2e",
};

function runtimeSpec(agentId: string): AgentRuntimeSpecInput {
  return {
    agentId,
    stableId: STABLE_ID,
    brokerOwnerId: "broker-1",
    cwd: "/repo/wt",
    repoRoot: "/repo",
    worktreePath: "/repo/wt",
    tmuxSocket: "/private/tmp/tmux-501/default",
    tmuxSession: "worker-e2e",
    tmuxTarget: "worker-e2e:0.0",
    executable: "/usr/local/bin/pi",
    argv: ["pi", "--model", "openai-codex/gpt-5.6-sol"],
    envAllowlist: ["HOME", "PI_MESH_SOCKET"],
    sessionResumeRef: "session:e2eabcdef012",
    configFingerprint: "cfg-e2e",
    expectedHost: "host-1",
    expectedUser: "tm",
    launchSource: "pinet-spawn",
  };
}

/** Fake runtime process: checkpoint handshake + graceful teardown of the live client. */
class E2eProcess implements HibernationProcessController {
  checkpoint: HibernationCheckpointOutcome = {
    hibernateSafe: true,
    reason: null,
    sessionResumeRef: "session:e2eabcdef012",
    pendingInboxCount: 0,
    rssBytes: 111_000_000,
  };
  constructor(private readonly getLiveClient: () => BrokerClient | null) {}
  async requestCheckpoint(): Promise<HibernationCheckpointOutcome> {
    return this.checkpoint;
  }
  async stopRuntime(): Promise<{ stopped: boolean; rssBytes: number | null }> {
    // Simulate the Pi runtime exiting: drop its broker connection.
    this.getLiveClient()?.disconnect();
    await new Promise((r) => setTimeout(r, 20));
    return { stopped: true, rssBytes: 0 };
  }
  async isRuntimeAlive(): Promise<boolean> {
    return false;
  }
}

/** Fake tmux adapter: cold-launches a real replacement client presenting the wake fence. */
class E2eTmux implements HibernationTmuxController {
  attachable = true;
  launched: BrokerClient[] = [];
  /** Override to corrupt the presented fence for negative tests. */
  mutateFence:
    | ((ctx: RuntimeLaunchContext) => {
        wakeLeaseId: string;
        fenceToken: number;
        runtimeGeneration: number;
      })
    | null = null;

  constructor(private readonly connect: () => Promise<BrokerClient>) {}

  async isSessionAttachable(): Promise<boolean> {
    return this.attachable;
  }
  async respawnRuntime(ctx: RuntimeLaunchContext): Promise<{ launched: boolean }> {
    const client = await this.connect();
    this.launched.push(client);
    const fence = this.mutateFence?.(ctx) ?? {
      wakeLeaseId: ctx.wakeLeaseId,
      fenceToken: ctx.fenceToken,
      runtimeGeneration: ctx.reservedGeneration,
    };
    try {
      await client.register(AGENT_NAME, "🦉", { ...AGENT_METADATA }, ctx.stableId, fence);
      return { launched: true };
    } catch {
      // Rejected wake fence: registration threw. The runtime failed to revive.
      return { launched: false };
    }
  }
}

interface Ctx {
  dir: string;
  db: BrokerDB;
  server: BrokerSocketServer;
  connect: () => Promise<BrokerClient>;
  clients: BrokerClient[];
}

async function setup(): Promise<Ctx> {
  const dir = tmpDir();
  const db = new BrokerDB(path.join(dir, "broker.db"));
  db.initialize();
  db.setAllowedUsers(null);
  const server = new BrokerSocketServer(db, { type: "tcp", host: "127.0.0.1", port: 0 });
  await server.start();
  const info = server.getConnectInfo();
  if (info.type !== "tcp") throw new Error("expected tcp");
  const clients: BrokerClient[] = [];
  const connect = async (): Promise<BrokerClient> => {
    const client = new BrokerClient({ host: info.host, port: info.port });
    await client.connect();
    clients.push(client);
    return client;
  };
  return { dir, db, server, connect, clients };
}

let ctx: Ctx;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  for (const c of ctx.clients) {
    try {
      c.disconnect();
    } catch {
      /* ignore */
    }
  }
  await ctx.server.stop();
  ctx.db.close();
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

function orchestratorFor(
  proc: HibernationProcessController,
  tmux: HibernationTmuxController,
): HibernationOrchestrator {
  return new HibernationOrchestrator({
    db: ctx.db,
    process: proc,
    tmux,
    brokerInstanceId: "broker-1",
    config: { registrationTimeoutMs: 2000, handshakeTimeoutMs: 2000, maxWakeAttempts: 2 },
  });
}

/** Register the original worker over the wire and mark it broker-managed + hibernatable. */
async function registerOriginal(): Promise<BrokerClient> {
  const client = await ctx.connect();
  const reg = await client.register(AGENT_NAME, "🦉", { ...AGENT_METADATA }, STABLE_ID);
  ctx.db.setAgentHibernatePolicy(reg.agentId, "manual");
  ctx.db.upsertAgentRuntimeSpec(runtimeSpec(reg.agentId));
  return client;
}

describe("hibernation E2E — real socket server + SQLite, fake process/tmux", () => {
  it("legacy (non-wake) registration is unaffected by the fence", async () => {
    const client = await ctx.connect();
    const reg = await client.register("Plain Worker", "🤖", undefined, "host:session:plainplain01");
    expect(reg.agentId).toBeTruthy();
    // A second reconnect-style register with no fence still succeeds.
    const again = await client.register(
      "Plain Worker",
      "🤖",
      undefined,
      "host:session:plainplain01",
    );
    expect(again.agentId).toBe(reg.agentId);
  });

  it("cold hibernate → wake with fenced re-registration and ordered exactly-once delivery", async () => {
    const original = await registerOriginal();
    const agentId = ctx.db.getAgentByStableId(STABLE_ID)!.id;

    const proc = new E2eProcess(() => original);
    const tmux = new E2eTmux(() => ctx.connect());
    const orch = orchestratorFor(proc, tmux);

    // prepare → hibernate over the real DB; original client connection is dropped.
    expect(orch.prepareHibernation(agentId).ready).toBe(true);
    const hib = await orch.hibernate(agentId);
    expect(hib.ok).toBe(true);
    expect(ctx.db.getAgentById(agentId)?.lifecycleState).toBe("hibernated");

    // Two targeted messages arrive while hibernated → durable inbox rows.
    ctx.db.queueMessage(agentId, {
      threadId: "a2a:e2e",
      source: "a2a",
      userId: "peer",
      channel: "a2a:e2e",
      text: "first",
      timestamp: "1700000000.000001",
      metadata: {},
    });
    ctx.db.queueMessage(agentId, {
      threadId: "a2a:e2e",
      source: "a2a",
      userId: "peer",
      channel: "a2a:e2e",
      text: "second",
      timestamp: "1700000000.000002",
      metadata: {},
    });

    // Cold wake: fake tmux launches a real replacement client that re-registers
    // through the real socket server presenting the wake fence.
    const woke = await orch.wake(agentId, { trigger: "direct_a2a" });
    expect(woke.ok).toBe(true);
    expect(woke.state).toBe("live");
    expect(woke.runtimeGeneration).toBe(1);
    expect(ctx.db.getAgentById(agentId)?.runtimeGeneration).toBe(1);

    // The woken client drains its durable inbox in order, exactly once.
    const woken = tmux.launched.at(-1)!;
    const inbox = await woken.pollInbox();
    expect(inbox.map((m) => m.message.body)).toEqual(["first", "second"]);
    await woken.ackMessages(inbox.map((m) => m.inboxId));
    expect(await woken.pollInbox()).toHaveLength(0);
  });

  it("aborts hibernation to active when work arrives at the checkpoint boundary (never exits)", async () => {
    const original = await registerOriginal();
    const agentId = ctx.db.getAgentByStableId(STABLE_ID)!.id;
    const proc = new E2eProcess(() => original);
    const tmux = new E2eTmux(() => ctx.connect());
    const orch = orchestratorFor(proc, tmux);

    expect(orch.prepareHibernation(agentId).ready).toBe(true);
    // Work lands after prepare but before/at the checkpoint boundary.
    ctx.db.queueMessage(agentId, {
      threadId: "a2a:e2e",
      source: "a2a",
      userId: "peer",
      channel: "a2a:e2e",
      text: "urgent",
      timestamp: "1700000000.000003",
      metadata: {},
    });

    const hib = await orch.hibernate(agentId);
    expect(hib.ok).toBe(false);
    expect(hib.reason).toBe("work_arrived_during_checkpoint");
    expect(ctx.db.getAgentById(agentId)?.lifecycleState).toBe("active");
    // The runtime never exited: the original connection still drains the message.
    const inbox = await original.pollInbox();
    expect(inbox.map((m) => m.message.body)).toContain("urgent");
    expect(tmux.launched).toHaveLength(0);
  });

  it("rejects registration into a hibernated identity with no wake fence (fail closed)", async () => {
    const original = await registerOriginal();
    const agentId = ctx.db.getAgentByStableId(STABLE_ID)!.id;
    const orch = orchestratorFor(new E2eProcess(() => original), new E2eTmux(() => ctx.connect()));
    orch.prepareHibernation(agentId);
    await orch.hibernate(agentId);
    expect(ctx.db.getAgentById(agentId)?.lifecycleState).toBe("hibernated");

    // A stray runtime tries to claim the hibernated identity with no fence.
    const stray = await ctx.connect();
    await expect(
      stray.register(AGENT_NAME, "🦉", { ...AGENT_METADATA }, STABLE_ID),
    ).rejects.toThrow(/wake lease|fence|generation/i);
    // Row stays hibernated; generation not advanced.
    expect(ctx.db.getAgentById(agentId)?.lifecycleState).toBe("hibernated");
    expect(ctx.db.getAgentById(agentId)?.runtimeGeneration).toBe(0);
  });

  it("rejects a stale-fence wake and quarantines to reap-candidate", async () => {
    const original = await registerOriginal();
    const agentId = ctx.db.getAgentByStableId(STABLE_ID)!.id;
    const tmux = new E2eTmux(() => ctx.connect());
    tmux.mutateFence = (c) => ({
      wakeLeaseId: c.wakeLeaseId,
      fenceToken: c.fenceToken + 999, // stale fence
      runtimeGeneration: c.reservedGeneration,
    });
    const orch = orchestratorFor(new E2eProcess(() => original), tmux);
    orch.prepareHibernation(agentId);
    await orch.hibernate(agentId);

    const woke = await orch.wake(agentId, { trigger: "manual" });
    expect(woke.ok).toBe(false);
    expect(woke.state).toBe("reap-candidate");
    expect(ctx.db.getAgentById(agentId)?.runtimeGeneration).toBe(0);
  });

  it("survives a broker restart while hibernated and wakes afterwards", async () => {
    const original = await registerOriginal();
    const agentId = ctx.db.getAgentByStableId(STABLE_ID)!.id;
    const orch = orchestratorFor(new E2eProcess(() => original), new E2eTmux(() => ctx.connect()));
    orch.prepareHibernation(agentId);
    await orch.hibernate(agentId);

    // Message queued before the restart must survive and deliver post-wake.
    ctx.db.queueMessage(agentId, {
      threadId: "a2a:e2e",
      source: "a2a",
      userId: "peer",
      channel: "a2a:e2e",
      text: "pre-restart",
      timestamp: "1700000000.000004",
      metadata: {},
    });

    // Restart the broker: stop server, reopen DB + server on a new port.
    await ctx.server.stop();
    ctx.db.close();
    ctx.db = new BrokerDB(path.join(ctx.dir, "broker.db"));
    ctx.db.initialize();
    ctx.db.setAllowedUsers(null);
    ctx.server = new BrokerSocketServer(ctx.db, { type: "tcp", host: "127.0.0.1", port: 0 });
    await ctx.server.start();
    const info = ctx.server.getConnectInfo();
    if (info.type !== "tcp") throw new Error("expected tcp");
    const port = info.port;
    ctx.connect = async () => {
      const client = new BrokerClient({ host: info.host, port });
      await client.connect();
      ctx.clients.push(client);
      return client;
    };

    // State survived the restart.
    expect(ctx.db.getAgentById(agentId)?.lifecycleState).toBe("hibernated");
    expect(ctx.db.getAgentRuntimeSpec(agentId)?.repoRoot).toBe("/repo");

    // Wake against the restarted broker.
    const tmux2 = new E2eTmux(() => ctx.connect());
    const orch2 = orchestratorFor(new E2eProcess(() => null), tmux2);
    const woke = await orch2.wake(agentId, { trigger: "slack_thread" });
    expect(woke.ok).toBe(true);
    expect(ctx.db.getAgentById(agentId)?.lifecycleState).toBe("live");

    const woken = tmux2.launched.at(-1)!;
    const inbox = await woken.pollInbox();
    expect(inbox.map((m) => m.message.body)).toEqual(["pre-restart"]);
  });
});
