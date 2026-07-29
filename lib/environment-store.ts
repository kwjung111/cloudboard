import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { EnvironmentInput } from "./cloudboard";

interface EnvironmentRow {
  id: string;
  name: string;
  group_name: string;
  regions_json: string;
  credential_ref: string;
}

const environmentIdPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const credentialRefPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const regionPattern = /^[a-z0-9-]{3,32}$/;

type DatabaseInstance = InstanceType<typeof Database>;

const globalDatabase = globalThis as typeof globalThis & {
  cloudboardDatabase?: DatabaseInstance;
};

export class InvalidEnvironmentError extends Error {}
export class EnvironmentAlreadyExistsError extends Error {}
export class EnvironmentNotFoundError extends Error {}

function text(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidEnvironmentError(`${field} 항목을 입력해 주세요.`);
  }
  return value.trim().slice(0, maxLength);
}

function parseRegions(value: unknown): string[] {
  const rawRegions = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const regions = [
    ...new Set(
      rawRegions
        .filter((region): region is string => typeof region === "string")
        .map((region) => region.trim().toLowerCase())
        .filter((region) => regionPattern.test(region)),
    ),
  ].slice(0, 10);

  if (regions.length === 0) {
    throw new InvalidEnvironmentError(
      "AWS 리전을 하나 이상 입력해 주세요.",
    );
  }
  return regions;
}

export function parseEnvironmentInput(value: unknown): EnvironmentInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidEnvironmentError("환경 설정 형식이 올바르지 않습니다.");
  }

  const input = value as Record<string, unknown>;
  const id = text(input.id, "환경 ID", 63).toLowerCase();
  if (!environmentIdPattern.test(id)) {
    throw new InvalidEnvironmentError(
      "환경 ID는 영문 소문자 또는 숫자로 시작하고, 하이픈만 사용할 수 있습니다.",
    );
  }

  const credentialRef =
    typeof input.credentialRef === "string" && input.credentialRef.trim()
      ? input.credentialRef.trim().toLowerCase()
      : id.replaceAll("-", "_");
  if (!credentialRefPattern.test(credentialRef)) {
    throw new InvalidEnvironmentError(
      "Secret 참조는 영문 소문자, 숫자, 하이픈, 밑줄만 사용할 수 있습니다.",
    );
  }

  return {
    id,
    name: text(input.name, "표시 이름", 80),
    group: text(input.group, "그룹", 40),
    regions: parseRegions(input.regions),
    credentialRef,
  };
}

function databasePath() {
  const configuredPath = process.env.CLOUDBOARD_DATABASE_PATH?.trim();
  return configuredPath
    ? resolve(/* turbopackIgnore: true */ configuredPath)
    : resolve(process.cwd(), "data", "cloudboard.db");
}

function migrate(database: DatabaseInstance) {
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS app_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS environments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        group_name TEXT NOT NULL,
        regions_json TEXT NOT NULL,
        credential_ref TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      INSERT OR IGNORE INTO schema_migrations (version) VALUES (1);

      CREATE TABLE IF NOT EXISTS cost_anomaly_reports (
        environment_id TEXT NOT NULL,
        basis_date TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        report_json TEXT NOT NULL,
        PRIMARY KEY (environment_id, basis_date),
        FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_cost_anomaly_reports_latest
        ON cost_anomaly_reports (environment_id, basis_date DESC);

      INSERT OR IGNORE INTO schema_migrations (version) VALUES (2);

      CREATE TABLE IF NOT EXISTS ai_audit_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        environment_id TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT NOT NULL,
        report_json TEXT NOT NULL,
        FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_ai_audit_reports_latest
        ON ai_audit_reports (environment_id, generated_at DESC);

      INSERT OR IGNORE INTO schema_migrations (version) VALUES (3);
    `);
  })();
}

function bootstrapInputs(): EnvironmentInput[] {
  const bootstrapFile =
    process.env.CLOUDBOARD_ENVIRONMENTS_BOOTSTRAP_FILE?.trim();
  if (!bootstrapFile || !existsSync(bootstrapFile)) {
    return [];
  }

  const parsed = JSON.parse(
    readFileSync(/* turbopackIgnore: true */ bootstrapFile, "utf8"),
  ) as unknown;
  const values =
    Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" &&
          parsed !== null &&
          Array.isArray((parsed as { environments?: unknown }).environments)
        ? (parsed as { environments: unknown[] }).environments
        : [];
  return values.map(parseEnvironmentInput);
}

function bootstrap(database: DatabaseInstance) {
  const completed = database
    .prepare("SELECT value FROM app_metadata WHERE key = ?")
    .get("environment_bootstrap_complete") as { value: string } | undefined;
  if (completed) {
    return;
  }

  const insert = database.prepare(`
    INSERT OR IGNORE INTO environments
      (id, name, group_name, regions_json, credential_ref)
    VALUES
      (@id, @name, @groupName, @regionsJson, @credentialRef)
  `);
  const complete = database.prepare(`
    INSERT INTO app_metadata (key, value)
    VALUES ('environment_bootstrap_complete', 'true')
  `);

  database.transaction(() => {
    for (const environment of bootstrapInputs()) {
      insert.run({
        id: environment.id,
        name: environment.name,
        groupName: environment.group,
        regionsJson: JSON.stringify(environment.regions),
        credentialRef: environment.credentialRef,
      });
    }
    complete.run();
  })();
}

export function getCloudboardDatabase(): DatabaseInstance {
  if (globalDatabase.cloudboardDatabase) {
    return globalDatabase.cloudboardDatabase;
  }

  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  migrate(database);
  bootstrap(database);
  globalDatabase.cloudboardDatabase = database;
  return database;
}

function mapRow(row: EnvironmentRow): EnvironmentInput {
  return {
    id: row.id,
    name: row.name,
    group: row.group_name,
    regions: JSON.parse(row.regions_json) as string[],
    credentialRef: row.credential_ref,
  };
}

export function listEnvironments(): EnvironmentInput[] {
  const rows = getCloudboardDatabase()
    .prepare(`
      SELECT id, name, group_name, regions_json, credential_ref
      FROM environments
      ORDER BY group_name COLLATE NOCASE, name COLLATE NOCASE, id
    `)
    .all() as EnvironmentRow[];
  return rows.map(mapRow);
}

export function findEnvironment(id: string): EnvironmentInput | null {
  const row = getCloudboardDatabase()
    .prepare(`
      SELECT id, name, group_name, regions_json, credential_ref
      FROM environments
      WHERE id = ?
    `)
    .get(id) as EnvironmentRow | undefined;
  return row ? mapRow(row) : null;
}

export function createEnvironment(value: unknown): EnvironmentInput {
  const environment = parseEnvironmentInput(value);
  try {
    getCloudboardDatabase()
      .prepare(`
        INSERT INTO environments
          (id, name, group_name, regions_json, credential_ref)
        VALUES
          (@id, @name, @groupName, @regionsJson, @credentialRef)
      `)
      .run({
        id: environment.id,
        name: environment.name,
        groupName: environment.group,
        regionsJson: JSON.stringify(environment.regions),
        credentialRef: environment.credentialRef,
      });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("UNIQUE constraint failed")
    ) {
      throw new EnvironmentAlreadyExistsError(
        "이미 등록된 환경 ID입니다.",
      );
    }
    throw error;
  }
  return environment;
}

export function deleteEnvironment(id: string) {
  if (!environmentIdPattern.test(id)) {
    throw new InvalidEnvironmentError("환경 ID 형식이 올바르지 않습니다.");
  }

  const result = getCloudboardDatabase()
    .prepare("DELETE FROM environments WHERE id = ?")
    .run(id);
  if (result.changes === 0) {
    throw new EnvironmentNotFoundError("등록되지 않은 환경입니다.");
  }
}

export function closeEnvironmentStore() {
  globalDatabase.cloudboardDatabase?.close();
  delete globalDatabase.cloudboardDatabase;
}
