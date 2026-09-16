// Applies the SQL migrations drizzle-kit generated under drizzle/. Runs only
// from the server at startup. Uses drizzle's own bookkeeping table
// (drizzle.__drizzle_migrations: hash, created_at) so drizzle-kit tooling keeps
// working, and adds the check ADR 0006 asks for: a database whose schema is
// newer than this build refuses to start rather than run old code on new tables.

import { fileURLToPath } from "node:url";
import { type MigrationMeta, readMigrationFiles } from "drizzle-orm/migrator";
import type { Sql } from "postgres";

const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";
/** Arbitrary constant so concurrent servers serialize their startup migration. */
const MIGRATION_LOCK = 7_243_001;

export class SchemaNewerThanBuildError extends Error {
  constructor(
    readonly databaseVersion: number,
    readonly buildVersion: number,
  ) {
    super(
      `database schema version ${databaseVersion} is newer than this build (${buildVersion}); upgrade the server`,
    );
    this.name = "SchemaNewerThanBuildError";
  }
}

export interface MigrateOptions {
  /** Folder holding meta/_journal.json and the SQL files. Defaults to apps/server/drizzle. */
  migrationsFolder?: string;
}

export interface MigrateResult {
  applied: number;
  /** The folder timestamp of the newest migration this build knows. */
  version: number;
}

export function defaultMigrationsFolder(): string {
  return fileURLToPath(new URL("../../drizzle", import.meta.url));
}

export function loadMigrations(options: MigrateOptions = {}): MigrationMeta[] {
  return readMigrationFiles({
    migrationsFolder: options.migrationsFolder ?? defaultMigrationsFolder(),
  });
}

/** The schema version is the folder timestamp of the newest applied migration; 0 when none. */
export async function databaseSchemaVersion(sql: Sql): Promise<number> {
  const rows = await sql<{ created_at: string | number | null }[]>`
    select max(created_at) as created_at
    from ${sql(MIGRATIONS_SCHEMA)}.${sql(MIGRATIONS_TABLE)}
  `.catch(() => [] as { created_at: string | number | null }[]);
  const value = rows[0]?.created_at;
  return value == null ? 0 : Number(value);
}

export function buildSchemaVersion(migrations: MigrationMeta[]): number {
  return migrations.reduce((max, m) => Math.max(max, m.folderMillis), 0);
}

export async function migrate(sql: Sql, options: MigrateOptions = {}): Promise<MigrateResult> {
  const migrations = loadMigrations(options);
  const buildVersion = buildSchemaVersion(migrations);

  await sql`create schema if not exists ${sql(MIGRATIONS_SCHEMA)}`;
  await sql`
    create table if not exists ${sql(MIGRATIONS_SCHEMA)}.${sql(MIGRATIONS_TABLE)} (
      id serial primary key,
      hash text not null,
      created_at bigint
    )
  `;

  let applied = 0;
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK})`;
    const rows = await tx<{ created_at: string | number | null }[]>`
      select max(created_at) as created_at
      from ${tx(MIGRATIONS_SCHEMA)}.${tx(MIGRATIONS_TABLE)}
    `;
    const raw = rows[0]?.created_at;
    const databaseVersion = raw == null ? 0 : Number(raw);
    if (databaseVersion > buildVersion) {
      throw new SchemaNewerThanBuildError(databaseVersion, buildVersion);
    }
    for (const migration of migrations) {
      if (migration.folderMillis <= databaseVersion) continue;
      for (const statement of migration.sql) {
        await tx.unsafe(statement);
      }
      await tx`
        insert into ${tx(MIGRATIONS_SCHEMA)}.${tx(MIGRATIONS_TABLE)} (hash, created_at)
        values (${migration.hash}, ${migration.folderMillis})
      `;
      applied += 1;
    }
  });

  return { applied, version: buildVersion };
}
