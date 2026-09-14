export const migrationQueries = {
  createTable: `
    CREATE TABLE IF NOT EXISTS pinet_work_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `,
  listVersions: `
    SELECT version
    FROM pinet_work_migrations
    ORDER BY version
  `,
  record: `
    INSERT INTO pinet_work_migrations (version, applied_at)
    VALUES (?, ?)
  `,
} as const;

export const projectQueries = {
  put: `
    INSERT INTO pinet_projects (
      id,
      markdown,
      external_channel,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      markdown = excluded.markdown,
      external_channel = excluded.external_channel,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at
  `,
  get: `
    SELECT id, markdown, external_channel, created_at, updated_at
    FROM pinet_projects
    WHERE id = ?
  `,
  list: `
    SELECT id, markdown, external_channel, created_at, updated_at
    FROM pinet_projects
    ORDER BY created_at, id
    LIMIT ? OFFSET ?
  `,
  delete: `
    DELETE FROM pinet_projects
    WHERE id = ?
  `,
} as const;

export const taskQueries = {
  put: `
    INSERT INTO pinet_tasks (
      id,
      project_id,
      markdown,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      project_id = excluded.project_id,
      markdown = excluded.markdown,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at
  `,
  get: `
    SELECT id, project_id, markdown, created_at, updated_at
    FROM pinet_tasks
    WHERE id = ?
  `,
  list: `
    SELECT id, project_id, markdown, created_at, updated_at
    FROM pinet_tasks
    ORDER BY created_at, id
    LIMIT ? OFFSET ?
  `,
  listByProject: `
    SELECT id, project_id, markdown, created_at, updated_at
    FROM pinet_tasks
    WHERE project_id = ?
    ORDER BY created_at, id
    LIMIT ? OFFSET ?
  `,
  delete: `
    DELETE FROM pinet_tasks
    WHERE id = ?
  `,
} as const;

export const searchQuery = `
  SELECT
    'project' AS kind,
    id,
    markdown,
    external_channel,
    NULL AS project_id,
    created_at,
    updated_at
  FROM pinet_projects
  WHERE instr(lower(markdown), lower(?)) > 0

  UNION ALL

  SELECT
    'task' AS kind,
    id,
    markdown,
    NULL AS external_channel,
    project_id,
    created_at,
    updated_at
  FROM pinet_tasks
  WHERE instr(lower(markdown), lower(?)) > 0

  ORDER BY created_at, id
  LIMIT ? OFFSET ?
`;
