import type { Project, Task, WorkStorage } from "./domain.js";
import { createWorkApp, parseTokens } from "./server.js";
type SqlStorage = {
  exec<T extends object>(query: string, ...bindings: Array<string | number | null>): Iterable<T>;
};
type State = { storage: { sql: SqlStorage } };
type Stub = { fetch(request: Request): Promise<Response> };
type Namespace = { idFromName(name: string): object; get(id: object): Stub };
export type WorkWorkerEnv = { WORK: Namespace; PINET_WORK_TOKENS: string };
type ProjectRow = {
  id: string;
  markdown: string;
  external_channel: string | null;
  created_at: number;
  updated_at: number;
};
type TaskRow = {
  id: string;
  project_id: string;
  markdown: string;
  created_at: number;
  updated_at: number;
};
class DurableWorkStorage implements WorkStorage {
  private readonly sql: SqlStorage;
  constructor(state: State) {
    this.sql = state.storage.sql;
    this.sql.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS pinet_projects(id TEXT PRIMARY KEY,markdown TEXT NOT NULL,external_channel TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pinet_tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES pinet_projects(id) ON DELETE CASCADE,markdown TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS pinet_tasks_project_created ON pinet_tasks(project_id,created_at,id);
    `);
  }
  private project(row: ProjectRow): Project {
    return {
      id: row.id,
      markdown: row.markdown,
      externalChannel: row.external_channel,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  private task(row: TaskRow): Task {
    return {
      id: row.id,
      projectId: row.project_id,
      markdown: row.markdown,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  putProject(value: Project): Project {
    this.sql.exec(
      "INSERT INTO pinet_projects VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET markdown=excluded.markdown,external_channel=excluded.external_channel,created_at=excluded.created_at,updated_at=excluded.updated_at",
      value.id,
      value.markdown,
      value.externalChannel,
      value.createdAt,
      value.updatedAt,
    );
    return value;
  }
  getProject(id: string): Project | undefined {
    const row = [...this.sql.exec<ProjectRow>("SELECT * FROM pinet_projects WHERE id=?", id)][0];
    return row && this.project(row);
  }
  listProjects(limit: number, offset: number): Project[] {
    return [
      ...this.sql.exec<ProjectRow>(
        "SELECT * FROM pinet_projects ORDER BY created_at,id LIMIT ? OFFSET ?",
        limit,
        offset,
      ),
    ].map((row) => this.project(row));
  }
  deleteProject(id: string): boolean {
    if (!this.getProject(id)) return false;
    this.sql.exec("DELETE FROM pinet_projects WHERE id=?", id);
    return true;
  }
  putTask(value: Task): Task {
    if (!this.getProject(value.projectId)) throw new Error("project not found");
    this.sql.exec(
      "INSERT INTO pinet_tasks VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,markdown=excluded.markdown,created_at=excluded.created_at,updated_at=excluded.updated_at",
      value.id,
      value.projectId,
      value.markdown,
      value.createdAt,
      value.updatedAt,
    );
    return value;
  }
  getTask(id: string): Task | undefined {
    const row = [...this.sql.exec<TaskRow>("SELECT * FROM pinet_tasks WHERE id=?", id)][0];
    return row && this.task(row);
  }
  listTasks(projectId: string | undefined, limit: number, offset: number): Task[] {
    const rows = projectId
      ? this.sql.exec<TaskRow>(
          "SELECT * FROM pinet_tasks WHERE project_id=? ORDER BY created_at,id LIMIT ? OFFSET ?",
          projectId,
          limit,
          offset,
        )
      : this.sql.exec<TaskRow>(
          "SELECT * FROM pinet_tasks ORDER BY created_at,id LIMIT ? OFFSET ?",
          limit,
          offset,
        );
    return [...rows].map((row) => this.task(row));
  }
  deleteTask(id: string): boolean {
    if (!this.getTask(id)) return false;
    this.sql.exec("DELETE FROM pinet_tasks WHERE id=?", id);
    return true;
  }
  search(query: string, limit: number, offset: number): { projects: Project[]; tasks: Task[] } {
    type SearchRow = {
      kind: string;
      id: string;
      markdown: string;
      external_channel: string | null;
      project_id: string | null;
      created_at: number;
      updated_at: number;
    };
    const rows = this.sql.exec<SearchRow>(
      `
      SELECT 'project' AS kind,id,markdown,external_channel,NULL AS project_id,created_at,updated_at FROM pinet_projects WHERE instr(lower(markdown),lower(?))>0
      UNION ALL
      SELECT 'task' AS kind,id,markdown,NULL AS external_channel,project_id,created_at,updated_at FROM pinet_tasks WHERE instr(lower(markdown),lower(?))>0
      ORDER BY created_at,id LIMIT ? OFFSET ?
    `,
      query,
      query,
      limit,
      offset,
    );
    const projects: Project[] = [],
      tasks: Task[] = [];
    for (const row of rows) {
      if (row.kind === "project") projects.push(this.project(row));
      else tasks.push(this.task({ ...row, project_id: row.project_id! }));
    }
    return { projects, tasks };
  }
  close(): void {}
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
