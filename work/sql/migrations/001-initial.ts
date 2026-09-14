export const initialMigration = `
  CREATE TABLE IF NOT EXISTS pinet_projects (
    id TEXT PRIMARY KEY,
    markdown TEXT NOT NULL,
    external_channel TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pinet_tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES pinet_projects(id) ON DELETE CASCADE,
    markdown TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS pinet_tasks_project_created
    ON pinet_tasks(project_id, created_at, id);
`;
