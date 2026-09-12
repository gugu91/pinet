import { DatabaseSync } from "node:sqlite";
import type { Project, Task, WorkStorage } from "./domain.js";
export { MemoryWorkStorage } from "./memory-storage.js";

export class SqliteWorkStorage implements WorkStorage {
  private readonly database: DatabaseSync;
  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS pinet_projects(id TEXT PRIMARY KEY,markdown TEXT NOT NULL,external_channel TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pinet_tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES pinet_projects(id) ON DELETE CASCADE,markdown TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS pinet_tasks_project_created ON pinet_tasks(project_id,created_at,id);
    `);
  }
  private project(row: object | undefined): Project | undefined {
    if (!row) return undefined;
    const value = row as {
      id: string;
      markdown: string;
      external_channel: string | null;
      created_at: number;
      updated_at: number;
    };
    return {
      id: value.id,
      markdown: value.markdown,
      externalChannel: value.external_channel,
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    };
  }
  private task(row: object | undefined): Task | undefined {
    if (!row) return undefined;
    const value = row as {
      id: string;
      project_id: string;
      markdown: string;
      created_at: number;
      updated_at: number;
    };
    return {
      id: value.id,
      projectId: value.project_id,
      markdown: value.markdown,
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    };
  }
  putProject(value: Project): Project {
    this.database
      .prepare(
        "INSERT INTO pinet_projects VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET markdown=excluded.markdown,external_channel=excluded.external_channel,created_at=excluded.created_at,updated_at=excluded.updated_at",
      )
      .run(value.id, value.markdown, value.externalChannel, value.createdAt, value.updatedAt);
    return value;
  }
  getProject(id: string): Project | undefined {
    return this.project(this.database.prepare("SELECT * FROM pinet_projects WHERE id=?").get(id));
  }
  listProjects(limit: number, offset: number): Project[] {
    return (
      this.database
        .prepare("SELECT * FROM pinet_projects ORDER BY created_at,id LIMIT ? OFFSET ?")
        .all(limit, offset) as object[]
    ).map((row) => this.project(row)!);
  }
  deleteProject(id: string): boolean {
    return this.database.prepare("DELETE FROM pinet_projects WHERE id=?").run(id).changes > 0;
  }
  putTask(value: Task): Task {
    try {
      this.database
        .prepare(
          "INSERT INTO pinet_tasks VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,markdown=excluded.markdown,created_at=excluded.created_at,updated_at=excluded.updated_at",
        )
        .run(value.id, value.projectId, value.markdown, value.createdAt, value.updatedAt);
    } catch (error) {
      if (error instanceof Error && error.message.includes("FOREIGN KEY"))
        throw new Error("project not found");
      throw error;
    }
    return value;
  }
  getTask(id: string): Task | undefined {
    return this.task(this.database.prepare("SELECT * FROM pinet_tasks WHERE id=?").get(id));
  }
  listTasks(projectId: string | undefined, limit: number, offset: number): Task[] {
    const rows = projectId
      ? this.database
          .prepare(
            "SELECT * FROM pinet_tasks WHERE project_id=? ORDER BY created_at,id LIMIT ? OFFSET ?",
          )
          .all(projectId, limit, offset)
      : this.database
          .prepare("SELECT * FROM pinet_tasks ORDER BY created_at,id LIMIT ? OFFSET ?")
          .all(limit, offset);
    return (rows as object[]).map((row) => this.task(row)!);
  }
  deleteTask(id: string): boolean {
    return this.database.prepare("DELETE FROM pinet_tasks WHERE id=?").run(id).changes > 0;
  }
  search(query: string, limit: number, offset: number): { projects: Project[]; tasks: Task[] } {
    const rows = this.database
      .prepare(
        `
      SELECT 'project' AS kind,id,markdown,external_channel,NULL AS project_id,created_at,updated_at FROM pinet_projects WHERE instr(lower(markdown),lower(?))>0
      UNION ALL
      SELECT 'task' AS kind,id,markdown,NULL AS external_channel,project_id,created_at,updated_at FROM pinet_tasks WHERE instr(lower(markdown),lower(?))>0
      ORDER BY created_at,id LIMIT ? OFFSET ?
    `,
      )
      .all(query, query, limit, offset) as Array<Record<string, string | number | null>>;
    const projects: Project[] = [];
    const tasks: Task[] = [];
    for (const row of rows) {
      if (row.kind === "project") projects.push(this.project(row)!);
      else tasks.push(this.task(row)!);
    }
    return { projects, tasks };
  }
  close(): void {
    this.database.close();
  }
}
