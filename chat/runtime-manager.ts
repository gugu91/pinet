import { join } from "node:path";
import type { RuntimeAdapter, RuntimeHandle } from "./runtime.js";

type RuntimeRequest = {
  id: string;
  prompt: string;
  worktree: string | null;
  adapter: "process" | "tmux" | "herdr";
  status: string;
  channelId: string | null;
  handle: string | null;
  identity: string | null;
  agentLastSeen: number | null;
  startedAt: number | null;
};
type RuntimeEnvelope = { data: RuntimeRequest[] };
type ClaimEnvelope = {
  launch: { token: string; agentId: string };
};
export type RuntimeManagerOptions = {
  baseUrl: string;
  token: string;
  hostId: string;
  adapters: Record<RuntimeRequest["adapter"], RuntimeAdapter>;
  cwd?: string;
  sessionDir: string;
  staleTimeoutMs?: number;
  now?: () => number;
  fetch?: typeof fetch;
};

export class RuntimeManager {
  private readonly owned = new Map<string, RuntimeHandle>();
  private readonly transport: typeof fetch;
  constructor(private readonly options: RuntimeManagerOptions) {
    this.transport = options.fetch ?? fetch;
  }
  private async request(path: string, init?: RequestInit): Promise<Response> {
    return this.transport(new URL(path, this.options.baseUrl), {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
        ...init?.headers,
      },
    });
  }
  async poll(): Promise<void> {
    const response = await this.request("/v1/runtime/requests?status=pending");
    if (!response.ok) throw new Error(`runtime poll failed (${response.status})`);
    const envelope = (await response.json()) as RuntimeEnvelope;
    for (const request of envelope.data) await this.claimAndStart(request);
    const runningResponse = await this.request("/v1/runtime/requests?status=running");
    if (!runningResponse.ok) throw new Error(`runtime recovery failed (${runningResponse.status})`);
    const running = (await runningResponse.json()) as RuntimeEnvelope;
    const runningById = new Map(running.data.map((request) => [request.id, request]));
    for (const request of running.data) {
      if (!this.owned.has(request.id) && request.handle && request.identity) {
        const handle = {
          adapter: request.adapter,
          handle: request.handle,
          identity: request.identity,
        };
        if (await this.options.adapters[request.adapter].isAlive(handle))
          this.owned.set(request.id, handle);
      }
    }
    for (const [requestId, handle] of this.owned) {
      const alive = await this.options.adapters[handle.adapter].isAlive(handle);
      const request = runningById.get(requestId);
      const heartbeatAt = request?.agentLastSeen ?? request?.startedAt;
      const stale =
        heartbeatAt !== null &&
        heartbeatAt !== undefined &&
        (this.options.now ?? Date.now)() - heartbeatAt > (this.options.staleTimeoutMs ?? 30000);
      if (alive && stale) {
        if (await this.options.adapters[handle.adapter].stop(handle)) {
          await this.report(requestId, {
            status: "stopped",
            handle: handle.handle,
            identity: handle.identity,
          });
          this.owned.delete(requestId);
        }
      } else if (alive)
        await this.report(requestId, {
          status: "running",
          handle: handle.handle,
          identity: handle.identity,
        });
      else {
        await this.report(requestId, {
          status: "stopped",
          handle: handle.handle,
          identity: handle.identity,
        });
        this.owned.delete(requestId);
      }
    }
  }
  private async claimAndStart(request: RuntimeRequest): Promise<void> {
    const claim = await this.request(`/v1/runtime/requests/${request.id}/claim`, {
      method: "POST",
    });
    if (!claim.ok) return;
    const launch = (await claim.json()) as ClaimEnvelope;
    try {
      const sessionId = crypto.randomUUID();
      const sessionPath = join(this.options.sessionDir, `${sessionId}.jsonl`);
      const handle = await this.options.adapters[request.adapter].spawn({
        prompt: request.channelId
          ? `${request.prompt}\n\nPinet Chat channel: ${request.channelId}`
          : request.prompt,
        cwd: request.worktree ?? this.options.cwd ?? process.cwd(),
        sessionId,
        sessionPath,
        env: {
          PINET_CHAT_URL: this.options.baseUrl,
          PINET_CHAT_TOKEN: launch.launch.token,
          PINET_AGENT_ID: launch.launch.agentId,
          PINET_RUNTIME_REQUEST_ID: request.id,
          ...(request.channelId ? { PINET_CHAT_CHANNEL_ID: request.channelId } : {}),
        },
      });
      this.owned.set(request.id, handle);
      await this.report(request.id, {
        status: "running",
        sessionPath,
        cwd: request.worktree ?? this.options.cwd ?? process.cwd(),
        handle: handle.handle,
        identity: handle.identity,
        startedAt: (this.options.now ?? Date.now)(),
      });
    } catch {
      // A failed launch is deliberately not retried: process creation may have succeeded before reporting failed.
      await this.report(request.id, { status: "unknown" });
    }
  }
  private async report(
    id: string,
    value: {
      status: string;
      sessionId?: string;
      sessionPath?: string;
      cwd?: string;
      handle?: string;
      identity?: string;
      startedAt?: number;
    },
  ): Promise<void> {
    const response = await this.request(`/v1/runtime/requests/${id}/report`, {
      method: "POST",
      body: JSON.stringify(value),
    });
    if (!response.ok) throw new Error(`runtime report failed (${response.status})`);
  }
  async stopOwned(): Promise<void> {
    for (const [requestId, handle] of this.owned) {
      if (await this.options.adapters[handle.adapter].stop(handle)) {
        await this.report(requestId, {
          status: "stopped",
          handle: handle.handle,
          identity: handle.identity,
        });
        this.owned.delete(requestId);
      }
    }
  }
}
