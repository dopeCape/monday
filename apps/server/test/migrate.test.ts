import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSchemaVersion,
  databaseSchemaVersion,
  defaultMigrationsFolder,
  loadMigrations,
  migrate,
  SchemaNewerThanBuildError,
} from "../src/db/migrate.ts";
import { type TestDatabase, testDatabase, testDatabaseAt } from "./harness.ts";

describe("migrations", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await testDatabase();
  }, 60_000);

  afterAll(async () => {
    await db.drop();
  });

  test("apply every checked-in migration and create every table", async () => {
    const tables = await db.handle.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public' order by 1
    `;
    expect(tables.map((t) => t.table_name)).toEqual([
      "account_credentials",
      "accounts",
      "activity",
      "attachments",
      "blob_chunks",
      "blobs",
      "briefs",
      "calendars",
      "changes",
      "devices",
      "drafts",
      "events",
      "examples",
      "external_credentials",
      "groups",
      "integration_secrets",
      "invites",
      "jobs",
      "labels",
      "mcp_catalog",
      "mcp_catalog_sync",
      "messages",
      "meter",
      "oauth_apps",
      "oauth_clients",
      "oauth_codes",
      "oauth_refresh_tokens",
      "pairing_codes",
      "people",
      "provider_keys",
      "routing_backlogs",
      "routing_decisions",
      "scheduled_sends",
      "servers",
      "session_events",
      "sessions",
      "settings",
      "signal_answers",
      "signal_backfills",
      "signal_defs",
      "signal_versions",
      "sync_messages",
      "sync_state",
      "tags",
      "thread_labels",
      "thread_routes",
      "thread_tags",
      "threads",
      "voice_profiles",
      "workflow_run_steps",
      "workflow_runs",
      "workflow_versions",
      "workflows",
      "workspace_keys",
      "workspaces",
    ]);
    expect(await databaseSchemaVersion(db.handle.sql)).toBe(buildSchemaVersion(loadMigrations()));
  });

  test("a second run applies nothing", async () => {
    const result = await migrate(db.handle.sql);
    expect(result.applied).toBe(0);
  });

  test("the Signal store takes over thread_judgments and section_judgments, then drops them", async () => {
    // A database migrated up to the migration before the Signal store, with answers in the old tables.
    const folder = await mkdtemp(join(tmpdir(), "monday-migrations-"));
    const source = defaultMigrationsFolder();
    const journal = JSON.parse(await readFile(join(source, "meta", "_journal.json"), "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    const cut = journal.entries.findIndex((e) => e.tag === "0024_signals");
    expect(cut).toBeGreaterThan(0);
    const before = journal.entries.slice(0, cut);
    await mkdir(join(folder, "meta"));
    await writeFile(
      join(folder, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: before }),
    );
    for (const e of before)
      await copyFile(join(source, `${e.tag}.sql`), join(folder, `${e.tag}.sql`));
    const old = await testDatabaseAt(folder);
    try {
      const sql = old.handle.sql;
      await sql`insert into accounts (id, provider, address, display_name, capabilities) values ('a1', 'jmap', 'sam@monday.test', 'Sam', '{}')`;
      await sql`insert into workspaces (id, account_id) values ('w1', 'a1')`;
      for (const id of ["t1", "t2"]) {
        await sql`insert into threads (id, workspace_id, provider_thread_id, subject_enc, subject_key, last_activity)
          values (${id}, 'w1', ${id}, '\\x00', '\\x00', now())`;
      }
      await sql`insert into thread_judgments (thread_id, workspace_id, needs_reply, waiting_on_others, newsletter, automated, brief_worth, urgency, chips, model, judged_at, message_count, latest_message_id)
        values ('t1', 'w1', 0.9, 0.2, 0.05, 0.1, 2.4, 1, '{"reply": 0.8, "review_link": 0.7, "snooze": 0.1}', 'jev-1.13.0', now(), 3, 'm3')`;
      await sql`insert into settings (scope, device_id, key, value) values ('global', null, 'actions.custom', ${JSON.stringify([{ id: "forward-accounts", label: "Forward", on: { judge: "An invoice" }, tool: "forward", args: {} }])}::jsonb)`;
      await sql`insert into section_judgments (workspace_id, thread_id, rule_id, statement, probability, model)
        values ('w1', 't1', 'reading', 'A long read', 0.83, 'jev-1.13.0'), ('w1', 't2', 'forward-accounts', 'An invoice', 0.91, 'jev-1.13.0')`;
      await migrate(sql);
      const rows = await sql<
        {
          thread_id: string;
          signal_id: string;
          version: number;
          noul: number | null;
          score: number | null;
          message_count: number;
          legacy_key: string | null;
        }[]
      >`select thread_id, signal_id, version, noul, score, message_count, legacy_key from signal_answers order by thread_id, signal_id`;
      const byId = (t: string, s: string) =>
        rows.find((r) => r.thread_id === t && r.signal_id === s);
      expect(byId("t1", "needs_reply")).toMatchObject({ version: 1, message_count: 3 });
      expect(byId("t1", "needs_reply")?.noul).toBeCloseTo(0.9);
      expect(byId("t1", "brief_worth")?.score).toBeCloseTo(2.4);
      expect(byId("t1", "urgency")?.score).toBeCloseTo(1);
      expect(byId("t1", "chip_reply")?.noul).toBeCloseTo(0.8);
      expect(byId("t1", "chip_review_link")).toBeUndefined();
      expect(byId("t1", "section:reading")).toMatchObject({
        version: 0,
        legacy_key: "A long read",
      });
      expect(byId("t2", "action:forward-accounts")).toMatchObject({
        version: 0,
        legacy_key: "An invoice",
      });
      expect(rows.filter((r) => r.thread_id === "t1")).toHaveLength(4 + 2 + 2 + 1);
      const left = await sql<{ n: number }[]>`
        select count(*)::int as n from information_schema.tables
        where table_schema = 'public' and table_name in ('thread_judgments', 'section_judgments')`;
      expect(left[0]?.n).toBe(0);
    } finally {
      await old.drop();
    }
  }, 60_000);

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
