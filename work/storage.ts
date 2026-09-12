import { DatabaseSync } from "node:sqlite";
import type { Project, Task, WorkStorage } from "./domain.js";
export class MemoryWorkStorage implements WorkStorage {
  protected projects = new Map<string, Project>();
  protected tasks = new Map<string, Task>();
  putProject(value: Project): Project {
    this.projects.set(value.id, value);
    return value;
  }
  getProject(id: string): Project | undefined {
    return this.projects.get(id);
  }
  listProjects(limit: number, offset: number): Project[] {
    return [...this.projects.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(offset, offset + limit);
  }
  deleteProject(id: string): boolean {
    const deleted = this.projects.delete(id);
    if (deleted)
      for (const [taskId, task] of this.tasks) if (task.projectId === id) this.tasks.delete(taskId);
    return deleted;
  }
  putTask(value: Task): Task {
    if (!this.projects.has(value.projectId)) throw new Error("project not found");
    this.tasks.set(value.id, value);
    return value;
  }
  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }
  listTasks(projectId: string | undefined, limit: number, offset: number): Task[] {
    return [...this.tasks.values()]
      .filter((row) => !projectId || row.projectId === projectId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(offset, offset + limit);
  }
  deleteTask(id: string): boolean {
    return this.tasks.delete(id);
  }
  search(query: string, limit: number, offset: number) {
    const needle = query.toLowerCase();
    return {
      projects: [...this.projects.values()]
        .filter((row) => row.markdown.toLowerCase().includes(needle))
        .slice(offset, offset + limit),
      tasks: [...this.tasks.values()]
        .filter((row) => row.markdown.toLowerCase().includes(needle))
        .slice(offset, offset + limit),
    };
  }
  close(): void {}
}
type Snapshot = { projects: Project[]; tasks: Task[] };
export class SqliteWorkStorage extends MemoryWorkStorage {
  private database: DatabaseSync;
  constructor(path: string) {
    super();
    this.database = new DatabaseSync(path);
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS pinet_work_state(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)",
    );
    const row = this.database.prepare("SELECT value FROM pinet_work_state WHERE id=1").get() as
      | { value: string }
      | undefined;
    if (row) {
      const value = JSON.parse(row.value) as Snapshot;
      for (const item of value.projects) this.projects.set(item.id, item);
      for (const item of value.tasks) this.tasks.set(item.id, item);
    }
  }
  private save() {
    this.database
      .prepare(
        "INSERT INTO pinet_work_state(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(
        JSON.stringify({ projects: [...this.projects.values()], tasks: [...this.tasks.values()] }),
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
  override close() {
    this.database.close();
  }
}
