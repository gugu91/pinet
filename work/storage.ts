import { DatabaseSync } from "node:sqlite";
import type { Project, Task } from "./domain.js";
import { MemoryWorkStorage } from "./memory-storage.js";
export { MemoryWorkStorage } from "./memory-storage.js";

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
