import type { Project, Task } from "./domain.js";
import { createWorkApp } from "./server.js";
import { MemoryWorkStorage } from "./storage.js";
type DurableStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: string): Promise<void>;
};
type State = {
  storage: DurableStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  waitUntil(promise: Promise<void>): void;
};
type Stub = { fetch(request: Request): Promise<Response> };
type Namespace = { idFromName(name: string): object; get(id: object): Stub };
export type WorkWorkerEnv = { WORK: Namespace; PINET_WORK_TOKENS: string };
type Snapshot = { projects: Project[]; tasks: Task[] };
class DurableWorkStorage extends MemoryWorkStorage {
  constructor(private state: State) {
    super();
  }
  async load() {
    const encoded = await this.state.storage.get<string>("snapshot");
    if (!encoded) return;
    const value = JSON.parse(encoded) as Snapshot;
    for (const row of value.projects) this.projects.set(row.id, row);
    for (const row of value.tasks) this.tasks.set(row.id, row);
  }
  private save() {
    this.state.waitUntil(
      this.state.storage.put(
        "snapshot",
        JSON.stringify({ projects: [...this.projects.values()], tasks: [...this.tasks.values()] }),
      ),
    );
  }
  override putProject(value: Project) {
    const result = super.putProject(value);
    this.save();
    return result;
  }
  override deleteProject(id: string) {
    const result = super.deleteProject(id);
    if (result) this.save();
    return result;
  }
  override putTask(value: Task) {
    const result = super.putTask(value);
    this.save();
    return result;
  }
  override deleteTask(id: string) {
    const result = super.deleteTask(id);
    if (result) this.save();
    return result;
  }
}
export class WorkDurableObject {
  private storage: DurableWorkStorage;
  private tokens: string[] = [];
  constructor(state: State) {
    this.storage = new DurableWorkStorage(state);
    void state.blockConcurrencyWhile(() => this.storage.load());
  }
  fetch(request: Request) {
    if (this.tokens.length === 0) {
      const encoded = request.headers.get("x-pinet-internal-tokens");
      if (!encoded)
        return Promise.resolve(
          Response.json(
            { error: { code: "misconfigured", message: "Tokens unavailable" } },
            { status: 500 },
          ),
        );
      this.tokens = JSON.parse(encoded) as string[];
    }
    return createWorkApp({ storage: this.storage, tokens: this.tokens }).fetch(request);
  }
}
export default {
  fetch(request: Request, env: WorkWorkerEnv) {
    const workspace = request.headers.get("x-pinet-workspace") ?? "default";
    const forwarded = new Request(request);
    forwarded.headers.set("x-pinet-internal-tokens", env.PINET_WORK_TOKENS);
    return env.WORK.get(env.WORK.idFromName(workspace)).fetch(forwarded);
  },
};
