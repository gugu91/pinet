import { DatabaseSync } from "node:sqlite";
import type { Project, Task, WorkStorage } from "./domain.js";
import { migrations } from "./sql/migrations/index.js";
import { migrationQueries, projectQueries, searchQuery, taskQueries } from "./sql/queries.js";

export { MemoryWorkStorage } from "./memory-storage.js";

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

type SearchRow = ProjectRow & {
  kind: "project" | "task";
  project_id: string | null;
};

type MigrationRow = { version: number };

export class SqliteWorkStorage implements WorkStorage {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.applyMigrations();
  }

  private applyMigrations(): void {
    this.database.exec(migrationQueries.createTable);
    const applied = new Set(
      (this.database.prepare(migrationQueries.listVersions).all() as MigrationRow[]).map(
        ({ version }) => version,
      ),
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      this.database.exec(migration.sql);
      this.database.prepare(migrationQueries.record).run(migration.version, Date.now());
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
    this.database
      .prepare(projectQueries.put)
      .run(value.id, value.markdown, value.externalChannel, value.createdAt, value.updatedAt);
    return value;
  }

  getProject(id: string): Project | undefined {
    const row = this.database.prepare(projectQueries.get).get(id) as ProjectRow | undefined;
    return row && this.project(row);
  }

  listProjects(limit: number, offset: number): Project[] {
    const rows = this.database.prepare(projectQueries.list).all(limit, offset) as ProjectRow[];
    return rows.map((row) => this.project(row));
  }

  deleteProject(id: string): boolean {
    return this.database.prepare(projectQueries.delete).run(id).changes > 0;
  }

  putTask(value: Task): Task {
    try {
      this.database
        .prepare(taskQueries.put)
        .run(value.id, value.projectId, value.markdown, value.createdAt, value.updatedAt);
    } catch (error) {
      if (error instanceof Error && error.message.includes("FOREIGN KEY")) {
        throw new Error("project not found");
      }
      throw error;
    }
    return value;
  }

  getTask(id: string): Task | undefined {
    const row = this.database.prepare(taskQueries.get).get(id) as TaskRow | undefined;
    return row && this.task(row);
  }

  listTasks(projectId: string | undefined, limit: number, offset: number): Task[] {
    const rows = projectId
      ? (this.database
          .prepare(taskQueries.listByProject)
          .all(projectId, limit, offset) as TaskRow[])
      : (this.database.prepare(taskQueries.list).all(limit, offset) as TaskRow[]);
    return rows.map((row) => this.task(row));
  }

  deleteTask(id: string): boolean {
    return this.database.prepare(taskQueries.delete).run(id).changes > 0;
  }

  search(query: string, limit: number, offset: number): { projects: Project[]; tasks: Task[] } {
    const rows = this.database.prepare(searchQuery).all(query, query, limit, offset) as SearchRow[];
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

  close(): void {
    this.database.close();
  }
}
