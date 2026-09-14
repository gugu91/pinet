// Frozen pre-migration schema fixture. Intentionally does not import current SQL.
export class WorkDurableObject {
  constructor(state) {
    this.sql = state.storage.sql;
    this.sql.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS pinet_projects(id TEXT PRIMARY KEY,markdown TEXT NOT NULL,external_channel TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pinet_tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES pinet_projects(id) ON DELETE CASCADE,markdown TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS pinet_tasks_project_created ON pinet_tasks(project_id,created_at,id);
    `);
  }

  fetch() {
    this.sql.exec(
      "INSERT INTO pinet_projects VALUES (?, ?, ?, ?, ?)",
      "legacy-project",
      "legacy project",
      "channel",
      1,
      2,
    );
    this.sql.exec(
      "INSERT INTO pinet_tasks VALUES (?, ?, ?, ?, ?)",
      "legacy-task",
      "legacy-project",
      "legacy task",
      3,
      4,
    );
    return Response.json({ seeded: true });
  }
}

export default {
  fetch(request, env) {
    return env.WORK.get(env.WORK.idFromName("default")).fetch(request);
  },
};
