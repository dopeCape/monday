// The upgrade module (ADR 0008) through its interface: the table plan follows
// foreign keys, a copy moves every row and every sequence into a fresh
// target and refuses a target that already holds Accounts, the attach store
// records the Cloud database for the next launch, and the routes map the
// typed errors. The dump path is exercised with a fake pg_dump.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account } from "@monday/shared";
import { createAuth } from "../src/auth/index.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { createDb } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import { createDrafts } from "../src/drafts/index.ts";
import { createMailstore } from "../src/mailstore/index.ts";
import { upgradeRoutes } from "../src/routes/upgrade.ts";
import { type AttachStore, createUpgrade, tablePlan, type Upgrade } from "../src/upgrade/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const account: Account = {
  id: "acct-up",
  provider: "imap",
  address: "me@example.test",
  displayName: "Me",
  capabilities: {
    push: false,
    labels: false,
    snooze: false,
    mute: false,
    calendar: false,
    meetingLink: null,
  },
};

function memoryAttach(): AttachStore & { value: string | null } {
  const store = {
    value: null as string | null,
    read: async () => store.value,
    write: async (url: string) => {
      store.value = url;
    },
    clear: async () => {
      store.value = null;
    },
  };
  return store;
}

describe("upgrade", () => {
  let source: TestDatabase;
  let target: TestDatabase;
  let upgrade: Upgrade;
  let attach: ReturnType<typeof memoryAttach>;
  const dumped: string[] = [];

  beforeAll(async () => {
    source = await testDatabase();
    target = await testDatabase();
    const keys = createKeys(source.handle.db);
    await keys.unlock(randomKey());
    const mailstore = createMailstore(source.handle.db, keys);
    const ws = await mailstore.createWorkspace(account);
    const drafts = createDrafts({ db: source.handle.db, mailstore });
    await drafts.save({
      id: "draft-up",
      workspaceId: ws.id,
      content: {
        threadId: null,
        kind: "new",
        inReplyToMessageId: null,
        to: [{ name: "A", email: "a@example.test" }],
        cc: [],
        bcc: [],
        subject: "Moving house",
        bodyText: "hi",
        bodyHtml: "<p>hi</p>",
        attachments: [],
      },
    });
    await createAuth({ db: source.handle.db, setupCode: "424242" }).pairSetup("424242", "Laptop");
    await source.handle
      .sql`insert into settings (scope, device_id, key, value) values ('global', null, 'send.delay_seconds', '5')`;
    await source.handle
      .sql`insert into servers (id, mode, last_seen) values ('sidecar-x', 'sidecar', now())`;

    attach = memoryAttach();
    upgrade = createUpgrade({
      mode: "sidecar",
      sourceUrl: source.url,
      connect: (url) => createDb(url, { max: 2 }),
      migrate: (sql) => migrate(sql),
      dump: async (_url, path) => {
        dumped.push(path);
        return 1234;
      },
      exportPath: () => "/tmp/monday-test/export.dump",
      attach,
    });
  }, 60_000);

  afterAll(async () => {
    await source.drop();
    await target.drop();
  });

  test("the table plan lists parents before children and skips process state", async () => {
    const plan = await tablePlan(source.handle.sql);
    const names = plan.map((t) => t.name);
    expect(names).not.toContain("servers");
    expect(names).not.toContain("pairing_codes");
    expect(names.indexOf("accounts")).toBeLessThan(names.indexOf("workspaces"));
    expect(names.indexOf("workspaces")).toBeLessThan(names.indexOf("drafts"));
    expect(names.indexOf("workspaces")).toBeLessThan(names.indexOf("changes"));
    const changes = plan.find((t) => t.name === "changes");
    expect(changes?.serials).toEqual(["seq"]);
    // Generated columns are left to the target to compute.
    const threads = plan.find((t) => t.name === "threads");
    expect(threads?.columns).not.toContain("headers_search");
  });

  test("a copy moves every row into the target and advances its sequences", async () => {
    const result = await upgrade.copyDatabase(target.url);
    const rows = Object.fromEntries(result.tables.map((t) => [t.name, t.rows]));
    expect(rows.accounts).toBe(1);
    expect(rows.workspaces).toBe(1);
    expect(rows.workspace_keys).toBe(1);
    expect(rows.drafts).toBe(1);
    expect(rows.devices).toBe(1);
    expect(rows.settings).toBe(1);
    expect(rows.changes).toBeGreaterThanOrEqual(1);

    const [draft] = await target.handle.sql`select id, workspace_id from drafts`;
    expect(draft?.id).toBe("draft-up");
    const [server] = await target.handle.sql`select count(*)::int as n from servers`;
    expect(server?.n).toBe(0);

    // The changes sequence continues after the copied rows.
    const [max] = await target.handle.sql`select max(seq)::int as n from changes`;
    const [next] = await target.handle.sql`select nextval('changes_seq_seq')::int as n`;
    expect(next?.n).toBe((max?.n ?? 0) + 1);

    // The paired Device's token hash moved with it, so it keeps working on the Cloud.
    const [device] = await target.handle.sql`select name from devices`;
    expect(device?.name).toBe("Laptop");
  }, 60_000);

  test("a second copy refuses a target that holds accounts unless told to replace", async () => {
    await expect(upgrade.copyDatabase(target.url)).rejects.toMatchObject({
      code: "target_not_empty",
    });
    const again = await upgrade.copyDatabase(target.url, { replace: true });
    expect(again.tables.find((t) => t.name === "accounts")?.rows).toBe(1);
  }, 60_000);

  test("attach checks the target carries the schema and records it for the next launch", async () => {
    await expect(upgrade.attach("not a url")).rejects.toMatchObject({ code: "invalid_url" });
    await expect(
      upgrade.attach("postgres://nobody:nothing@127.0.0.1:1/none"),
    ).rejects.toMatchObject({ code: "target_unreachable" });

    const attached = await upgrade.attach(target.url);
    expect(attached.restartRequired).toBe(true);
    expect(attach.value).toBe(target.url);
    const status = await upgrade.status();
    expect(status.attachedHost).toBe("127.0.0.1");
    expect(status.restartRequired).toBe(true);
    expect(status.canExport).toBe(true);

    const detached = await upgrade.detach();
    expect(detached.restartRequired).toBe(false);
    expect(attach.value).toBeNull();
  });

  test("export runs the dump into the export path", async () => {
    const result = await upgrade.exportDatabase();
    expect(result).toMatchObject({ path: "/tmp/monday-test/export.dump", bytes: 1234 });
    expect(dumped).toEqual(["/tmp/monday-test/export.dump"]);
    expect((await upgrade.status()).lastExport).toEqual(result);
  });

  test("the routes carry the typed errors", async () => {
    const auth = createAuth({ db: source.handle.db, sidecarToken: "tok" });
    const { createApp } = await import("../src/app.ts");
    const app = createApp({
      db: source.handle.db,
      auth,
      mode: "sidecar",
      remoteAddress: () => "127.0.0.1",
      mounts: [upgradeRoutes(upgrade)],
    });
    const headers = { authorization: "Bearer tok", "content-type": "application/json" };
    expect((await app.request("/upgrade")).status).toBe(401);
    const status = await app.request("/upgrade", { headers });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ mode: "sidecar", canExport: true });

    const bad = await app.request("/upgrade/copy", {
      method: "POST",
      headers,
      body: JSON.stringify({ databaseUrl: "mysql://x" }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_url" });

    const full = await app.request("/upgrade/copy", {
      method: "POST",
      headers,
      body: JSON.stringify({ databaseUrl: target.url }),
    });
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ error: "target_not_empty" });

    const noBinary = createUpgrade({
      mode: "sidecar",
      sourceUrl: source.url,
      connect: (url) => createDb(url, { max: 2 }),
      migrate: (sql) => migrate(sql),
      exportPath: () => "/tmp/x",
      attach: memoryAttach(),
    });
    const noExport = await createApp({
      db: source.handle.db,
      auth,
      mode: "sidecar",
      remoteAddress: () => "127.0.0.1",
      mounts: [upgradeRoutes(noBinary)],
    }).request("/upgrade/export", { method: "POST", headers });
    expect(noExport.status).toBe(501);
    expect(await noExport.json()).toMatchObject({ error: "export_unavailable" });
  }, 60_000);
});
