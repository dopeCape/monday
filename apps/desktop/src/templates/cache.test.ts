// The Templates' Cache mirror over the fake Server: a `template` feed row
// lands as stale headers, the sync reads GET /templates and writes the rows
// whole, a newer row marks it stale again and is read again, and a Template
// the Server no longer lists is marked deleted.

import { describe, expect, test } from "bun:test";
import type { Template, TemplateChange } from "@monday/shared";
import { findBuiltinTemplate } from "@monday/shared";
import { bunDriver } from "../store/bun-driver.ts";
import { createFakeStore } from "../store/fake.ts";
import { createTemplateSync, OWN_TEMPLATES_SQL, rowToTemplate } from "./cache.ts";

const tick = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms));

const base = findBuiltinTemplate("t_thanks_received") as Template;
const tpl = (id: string, name: string, updatedAt: string): Template => ({
  ...base,
  id,
  name,
  workspaceId: "ws",
  builtIn: null,
  updatedAt,
});
const header = (t: Template, deleted = false): TemplateChange => ({
  id: t.id,
  kind: t.kind,
  builtIn: t.builtIn,
  shareGroupId: t.shareGroupId,
  createdBy: t.createdBy,
  updatedAt: t.updatedAt,
  deleted,
});

describe("Templates in the Cache", () => {
  test("feed headers mark content stale; the sync fills it; removals are followed", async () => {
    const { store, server } = await createFakeStore({
      driver: bunDriver(),
      seed: null,
      backoff: { minMs: 5, maxMs: 20 },
    });
    let serverList: Template[] = [tpl("tpl-1", "Got it", "2026-09-20T10:00:00.000Z")];
    let reads = 0;
    const sync = createTemplateSync(store, async () => {
      reads++;
      return serverList;
    });

    server.record({
      kind: "template",
      entityId: "tpl-1",
      payload: header(serverList[0] as Template),
    });
    await store.sync();
    await tick(30);
    expect(reads).toBe(1);
    const own = (await store.query(OWN_TEMPLATES_SQL)).map((r) => rowToTemplate(r, "ws"));
    expect(own.map((t) => [t.id, t.name, t.body])).toEqual([["tpl-1", "Got it", base.body]]);
    expect(own[0]?.placeholders).toEqual(base.placeholders);

    // A newer version: stale again, read again.
    serverList = [tpl("tpl-1", "Got it, thanks", "2026-09-21T10:00:00.000Z")];
    server.record({
      kind: "template",
      entityId: "tpl-1",
      payload: header(serverList[0] as Template),
    });
    await store.sync();
    await tick(30);
    expect(reads).toBe(2);
    expect((await store.query(OWN_TEMPLATES_SQL)).map((r) => r.name)).toEqual(["Got it, thanks"]);

    // Deleted on the Server: the header says so and the list no longer has it.
    serverList = [];
    server.record({
      kind: "template",
      entityId: "tpl-1",
      payload: header(tpl("tpl-1", "", "2026-09-22T10:00:00.000Z"), true),
    });
    await store.sync();
    await tick(30);
    expect(await store.query(OWN_TEMPLATES_SQL)).toEqual([]);
    sync.stop();
  });

  test("a failed read waits for the next change", async () => {
    const { store, server } = await createFakeStore({
      driver: bunDriver(),
      seed: null,
      backoff: { minMs: 5, maxMs: 20 },
    });
    let fail = true;
    const sync = createTemplateSync(store, async () => {
      if (fail) throw new Error("locked");
      return [tpl("tpl-2", "Later", "2026-09-20T10:00:00.000Z")];
    });
    expect(await sync.refresh()).toBe(false);
    fail = false;
    server.record({
      kind: "template",
      entityId: "tpl-2",
      payload: header(tpl("tpl-2", "Later", "2026-09-20T10:00:00.000Z")),
    });
    await store.sync();
    await tick(30);
    expect((await store.query(OWN_TEMPLATES_SQL)).map((r) => r.id)).toEqual(["tpl-2"]);
    sync.stop();
  });
});
