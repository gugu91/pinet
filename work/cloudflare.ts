import type { Project, Task, WorkStorage } from "./domain.js";
import { createWorkApp, hasValidBearerToken, parseTokens } from "./server.js";
import { migrations } from "./sql/migrations/index.js";
import { migrationQueries, projectQueries, searchQuery, taskQueries } from "./sql/queries.js";

type SqlStorage = {
  exec<T extends object>(query: string, ...bindings: Array<string | number | null>): Iterable<T>;
};

type State = { storage: { sql: SqlStorage } };
type Stub = { fetch(request: Request): Promise<Response> };
type Namespace = { idFromName(name: string): object; get(id: object): Stub };

export type WorkWorkerEnv = {
  WORK: Namespace;
  PINET_WORK_TOKENS: string;
  PINET_WORKSPACE?: string;
};

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

type SearchRow = {
  kind: "project" | "task";
  id: string;
  markdown: string;
  external_channel: string | null;
  project_id: string | null;
  created_at: number;
  updated_at: number;
};

type MigrationRow = { version: number };

class DurableWorkStorage implements WorkStorage {
  private readonly sql: SqlStorage;

  constructor(state: State) {
    this.sql = state.storage.sql;
    this.sql.exec("PRAGMA foreign_keys = ON");
    this.applyMigrations();
  }

  private applyMigrations(): void {
    this.sql.exec(migrationQueries.createTable);
    const applied = new Set(
      [...this.sql.exec<MigrationRow>(migrationQueries.listVersions)].map(({ version }) => version),
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      this.sql.exec(migration.sql);
      this.sql.exec(migrationQueries.record, migration.version, Date.now());
    }
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
      projectQueries.put,
      value.id,
      value.markdown,
      value.externalChannel,
      value.createdAt,
      value.updatedAt,
    );
    return value;
  }

  getProject(id: string): Project | undefined {
    const row = [...this.sql.exec<ProjectRow>(projectQueries.get, id)][0];
    return row && this.project(row);
  }

  listProjects(limit: number, offset: number): Project[] {
    return [...this.sql.exec<ProjectRow>(projectQueries.list, limit, offset)].map((row) =>
      this.project(row),
    );
  }

  deleteProject(id: string): boolean {
    if (!this.getProject(id)) return false;
    this.sql.exec(projectQueries.delete, id);
    return true;
  }

  putTask(value: Task): Task {
    this.sql.exec(
      taskQueries.put,
      value.id,
      value.projectId,
      value.markdown,
      value.createdAt,
      value.updatedAt,
    );
    return value;
  }

  getTask(id: string): Task | undefined {
    const row = [...this.sql.exec<TaskRow>(taskQueries.get, id)][0];
    return row && this.task(row);
  }

  listTasks(projectId: string | undefined, limit: number, offset: number): Task[] {
    const rows = projectId
      ? this.sql.exec<TaskRow>(taskQueries.listByProject, projectId, limit, offset)
      : this.sql.exec<TaskRow>(taskQueries.list, limit, offset);
    return [...rows].map((row) => this.task(row));
  }

  deleteTask(id: string): boolean {
    if (!this.getTask(id)) return false;
    this.sql.exec(taskQueries.delete, id);
    return true;
  }

  search(query: string, limit: number, offset: number): { projects: Project[]; tasks: Task[] } {
    const rows = this.sql.exec<SearchRow>(searchQuery, query, query, limit, offset);
    const projects: Project[] = [];
    const tasks: Task[] = [];

    for (const row of rows) {
      if (row.kind === "project") {
        projects.push(this.project(row));
      } else {
        tasks.push(this.task({ ...row, project_id: row.project_id! }));
      }
    }
    return { projects, tasks };
  }

  close(): void {}
}

export class WorkDurableObject {
  private readonly app;

  constructor(state: State) {
    this.app = createWorkApp({
      storage: new DurableWorkStorage(state),
      trustAuthenticatedProxy: true,
    });
  }

  fetch(request: Request): Promise<Response> {
    return Promise.resolve(this.app.fetch(request));
  }
}

export default {
  fetch(request: Request, env: WorkWorkerEnv): Promise<Response> {
    let tokens: string[];
    try {
      tokens = parseTokens(env.PINET_WORK_TOKENS);
    } catch {
      return Promise.resolve(
        Response.json(
          { error: { code: "misconfigured", message: "Work authentication is unavailable" } },
          { status: 500 },
        ),
      );
    }

    if (
      new URL(request.url).pathname.startsWith("/v1/") &&
      !hasValidBearerToken(request.headers.get("authorization"), tokens)
    ) {
      return Promise.resolve(
        Response.json(
          { error: { code: "unauthorized", message: "Valid Bearer credential required" } },
          { status: 401 },
        ),
      );
    }

    // One deployment is one collaborative workspace. Callers cannot select a
    // Durable Object namespace; operators may set a stable server-side name.
    const workspace = env.PINET_WORKSPACE?.trim() || "default";
    const forwarded = new Request(request);
    forwarded.headers.delete("authorization");
    forwarded.headers.delete("x-pinet-workspace");
    return env.WORK.get(env.WORK.idFromName(workspace)).fetch(forwarded);
  },
};
