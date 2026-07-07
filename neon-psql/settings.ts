import * as fs from "node:fs";
import * as os from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const SETTINGS_KEY = "neon-psql";
const DEFAULT_LOG_RELATIVE_PATH = join(".pi", "neon-psql-tunnel.log");

const DEFAULT_SOURCE_ENV = {
  host: "DB_HOST",
  port: "DB_PORT",
  user: "DB_USER",
  password: "DB_PASSWORD",
  database: "DB_NAME",
} as const;

const DEFAULT_INJECT_ENV: Record<string, string> = {
  NEON_TUNNEL_DATABASE_URL: "postgres_url",
  NEON_TUNNEL_SQLALCHEMY_URL: "sqlalchemy_url",
  NEON_TUNNEL_SQLALCHEMY_ASYNC_URL: "sqlalchemy_async_url",
  NEON_TUNNEL_ASYNCPG_DSN: "asyncpg_dsn",
  TEST_DB_URL: "sqlalchemy_url",
  DB_URL: "sqlalchemy_url",
  DATABASE_URL: "postgres_url",
  DB_HOST: "tunnel_host",
  DB_PORT: "tunnel_port",
  DB_USER: "source_user",
  DB_PASSWORD: "source_password",
  DB_NAME: "source_database",
  DB_HOST_POOLED: "",
  DB_READ_HOST: "",
  PGHOST: "tunnel_host",
  PGPORT: "tunnel_port",
  PGUSER: "source_user",
  PGPASSWORD: "source_password",
  PGDATABASE: "source_database",
  PGOPTIONS: "pgoptions",
  PGSSLMODE: "sslmode",
  NEON_ENDPOINT: "endpoint",
  NEON_TUNNEL_HOST: "tunnel_host",
  NEON_TUNNEL_PORT: "tunnel_port",
  NEON_TUNNEL_SSL_MODE: "sslmode",
  NEON_TUNNEL_ACTIVE: "1",
};

export interface SourceEnvConfig {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

export interface FileConfig {
  enabled?: boolean;
  injectIntoBash?: boolean;
  injectPythonShim?: boolean;
  logPath?: string;
  psqlBin?: string;
  sourceEnv?: Partial<SourceEnvConfig>;
  injectEnv?: Record<string, string>;
}

export interface ResolvedConfig {
  path: string;
  injectIntoBash: boolean;
  injectPythonShim: boolean;
  logPath: string;
  psqlBin?: string;
  sourceEnv: SourceEnvConfig;
  injectEnv: Record<string, string>;
}

interface RawConfigSource {
  raw: FileConfig;
  pathLabel: string;
}

export interface LoadConfigOptions {
  cwd?: string;
  agentDir?: string;
  extensionDir?: string;
  env?: NodeJS.ProcessEnv;
}

type ConfigJsonPrimitive = string | number | boolean | null;
type ConfigJsonValue = ConfigJsonPrimitive | ConfigJsonObject | ConfigJsonValue[];
type ConfigJsonObject = { [key: string]: ConfigJsonValue };

function readJsonFile(filePath: string): ConfigJsonValue | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as ConfigJsonValue;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[neon-psql] Failed to parse config ${filePath}: ${message}`);
    return null;
  }
}

function readConfigFile(filePath: string): RawConfigSource | null {
  if (!fs.existsSync(filePath)) return null;
  const parsed = readJsonFile(filePath);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return {
    raw: parsed as FileConfig,
    pathLabel: filePath,
  };
}

function readSettingsConfig(settingsPath: string): RawConfigSource | null {
  if (!fs.existsSync(settingsPath)) return null;
  const parsed = readJsonFile(settingsPath);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const raw = parsed[SETTINGS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  return {
    raw: raw as FileConfig,
    pathLabel: `${settingsPath}#${SETTINGS_KEY}`,
  };
}

function resolveLogPath(cwd: string, logPath?: string): string {
  if (!logPath) return resolve(cwd, DEFAULT_LOG_RELATIVE_PATH);
  if (isAbsolute(logPath)) return logPath;
  return resolve(cwd, logPath);
}

function normalizeConfig(cwd: string, source: RawConfigSource): ResolvedConfig | null {
  const raw = source.raw;
  if (raw.enabled === false) return null;

  return {
    path: source.pathLabel,
    injectIntoBash: raw.injectIntoBash ?? true,
    injectPythonShim: raw.injectPythonShim ?? true,
    logPath: resolveLogPath(cwd, raw.logPath),
    psqlBin: raw.psqlBin?.trim() || undefined,
    sourceEnv: {
      host: raw.sourceEnv?.host ?? DEFAULT_SOURCE_ENV.host,
      port: raw.sourceEnv?.port ?? DEFAULT_SOURCE_ENV.port,
      user: raw.sourceEnv?.user ?? DEFAULT_SOURCE_ENV.user,
      password: raw.sourceEnv?.password ?? DEFAULT_SOURCE_ENV.password,
      database: raw.sourceEnv?.database ?? DEFAULT_SOURCE_ENV.database,
    },
    injectEnv: {
      ...DEFAULT_INJECT_ENV,
      ...(raw.injectEnv ?? {}),
    },
  };
}

function findConfigSource(options: Required<LoadConfigOptions>): RawConfigSource | null {
  const explicitPath = options.env.PI_NEON_PSQL_CONFIG;
  if (explicitPath) {
    const explicit = readConfigFile(explicitPath);
    if (explicit) return explicit;
  }

  const projectSettings = readSettingsConfig(join(options.cwd, ".pi", "settings.json"));
  if (projectSettings) return projectSettings;

  const globalSettings = readSettingsConfig(join(options.agentDir, "settings.json"));
  if (globalSettings) return globalSettings;

  const projectConfig = readConfigFile(join(options.cwd, ".pi", "neon-psql.json"));
  if (projectConfig) return projectConfig;

  const localExtensionConfig = readConfigFile(join(options.extensionDir, "config.json"));
  if (localExtensionConfig) return localExtensionConfig;

  const globalExtensionConfig = readConfigFile(
    join(options.agentDir, "extensions", "neon-psql", "config.json"),
  );
  if (globalExtensionConfig) return globalExtensionConfig;

  return null;
}

export function loadConfig(options: LoadConfigOptions = {}): ResolvedConfig | null {
  const resolvedOptions: Required<LoadConfigOptions> = {
    cwd: options.cwd ?? process.cwd(),
    agentDir: options.agentDir ?? join(os.homedir(), ".pi", "agent"),
    extensionDir: options.extensionDir ?? process.cwd(),
    env: options.env ?? process.env,
  };

  const source = findConfigSource(resolvedOptions);
  if (!source) return null;

  return normalizeConfig(resolvedOptions.cwd, source);
}
