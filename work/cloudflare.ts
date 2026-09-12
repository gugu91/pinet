import type { Project, Task } from "./domain.js";
import { MemoryWorkStorage } from "./memory-storage.js";
import { createWorkApp, parseTokens } from "./server.js";
type SqlStorage = {
  exec<T extends object>(query: string, ...bindings: Array<string | number | null>): Iterable<T>;
};
type State = { storage: { sql: SqlStorage } };
type Stub = { fetch(request: Request): Promise<Response> };
type Namespace = { idFromName(name: string): object; get(id: object): Stub };
export type WorkWorkerEnv = { WORK: Namespace; PINET_WORK_TOKENS: string };
type StoredRow = { kind: string; id: string; value: string };
class DurableWorkStorage extends MemoryWorkStorage {
  private readonly sql: SqlStorage;
  constructor(state: State) {
    super();
    this.sql = state.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS pinet_work(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id))",
    );
    for (const row of this.sql.exec<StoredRow>("SELECT kind,id,value FROM pinet_work")) {
      if (row.kind === "project") this.projects.set(row.id, JSON.parse(row.value) as Project);
      else if (row.kind === "task") this.tasks.set(row.id, JSON.parse(row.value) as Task);
    }
  }
  private put(kind: string, id: string, value: object): void {
    this.sql.exec(
      "INSERT INTO pinet_work(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value",
      kind,
      id,
      JSON.stringify(value),
    );
  }
  override putProject(value: Project): Project {
    const result = super.putProject(value);
    this.put("project", result.id, result);
    return result;
  }
  override deleteProject(id: string): boolean {
    const result = super.deleteProject(id);
    if (result) {
      this.sql.exec("DELETE FROM pinet_work WHERE kind='project' AND id=?", id);
      this.sql.exec(
        "DELETE FROM pinet_work WHERE kind='task' AND json_extract(value,'$.projectId')=?",
        id,
      );
    }
    return result;
  }
  override putTask(value: Task): Task {
    const result = super.putTask(value);
    this.put("task", result.id, result);
    return result;
  }
  override deleteTask(id: string): boolean {
    const result = super.deleteTask(id);
    if (result) this.sql.exec("DELETE FROM pinet_work WHERE kind='task' AND id=?", id);
    return result;
  }
}
export class WorkDurableObject {
  private readonly storage: DurableWorkStorage;
  private tokens: string[] | undefined;
  constructor(state: State) {
    this.storage = new DurableWorkStorage(state);
  }
  fetch(request: Request): Promise<Response> {
    try {
      if (!this.tokens) {
        const encoded = request.headers.get("x-pinet-internal-tokens");
        if (!encoded) throw new Error("Tokens unavailable");
        this.tokens = parseTokens(encoded);
      }
      return Promise.resolve(
        createWorkApp({ storage: this.storage, tokens: this.tokens }).fetch(request),
      );
    } catch (error) {
      return Promise.resolve(
        Response.json(
          {
            error: {
              code: "misconfigured",
              message: error instanceof Error ? error.message : "Invalid tokens",
            },
          },
          { status: 500 },
        ),
      );
    }
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
