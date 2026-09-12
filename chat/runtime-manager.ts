import type { RuntimeAdapter, RuntimeHandle } from "./runtime.js";

type RuntimeRequest = {
  id: string;
  prompt: string;
  worktree: string | null;
  adapter: "process" | "tmux" | "herdr";
  status: string;
};
type RuntimeEnvelope = { data: RuntimeRequest[] };
export type RuntimeManagerOptions = {
  baseUrl: string;
  token: string;
  hostId: string;
  adapters: Record<RuntimeRequest["adapter"], RuntimeAdapter>;
  cwd?: string;
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
    for (const [requestId, handle] of this.owned) {
      const alive = await this.options.adapters[handle.adapter].isAlive(handle);
      if (alive)
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
    try {
      const sessionId = crypto.randomUUID();
      const handle = await this.options.adapters[request.adapter].spawn({
        prompt: request.prompt,
        cwd: request.worktree ?? this.options.cwd ?? process.cwd(),
        sessionId,
      });
      this.owned.set(request.id, handle);
      await this.report(request.id, {
        status: "running",
        sessionId,
        cwd: request.worktree ?? this.options.cwd ?? process.cwd(),
        handle: handle.handle,
        identity: handle.identity,
        startedAt: Date.now(),
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
      if (await this.options.adapters[handle.adapter].stop(handle))
        await this.report(requestId, {
          status: "stopped",
          handle: handle.handle,
          identity: handle.identity,
        });
    }
    this.owned.clear();
  }
}
