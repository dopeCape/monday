import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildSchemaVersion,
  databaseSchemaVersion,
  loadMigrations,
  migrate,
  SchemaNewerThanBuildError,
} from "../src/db/migrate.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

describe("migrations", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await testDatabase();
  }, 60_000);

  afterAll(async () => {
    await db.drop();
  });

  test("apply every checked-in migration and create the core tables", async () => {
    const tables = await db.handle.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public' order by 1
    `;
    expect(tables.map((t) => t.table_name)).toEqual([
      "devices",
      "jobs",
      "pairing_codes",
      "servers",
      "settings",
    ]);
    expect(await databaseSchemaVersion(db.handle.sql)).toBe(buildSchemaVersion(loadMigrations()));
  });

  test("a second run applies nothing", async () => {
    const result = await migrate(db.handle.sql);
    expect(result.applied).toBe(0);
  });

  test("refuse to start when the database schema is newer than this build", async () => {
    const build = buildSchemaVersion(loadMigrations());
    const newer = build + 1;
    await db.handle.sql`
      insert into drizzle.__drizzle_migrations (hash, created_at) values ('from-the-future', ${newer})
    `;
    let error: unknown;
    try {
      await migrate(db.handle.sql);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SchemaNewerThanBuildError);
    expect((error as SchemaNewerThanBuildError).databaseVersion).toBe(newer);
    expect((error as SchemaNewerThanBuildError).buildVersion).toBe(build);
    await db.handle.sql`delete from drizzle.__drizzle_migrations where hash = 'from-the-future'`;
  });
});
