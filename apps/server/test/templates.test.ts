// Templates I (slice 36) through the routes and the module over Postgres,
// with the fake judge and the fake chat at the seams: rows sealed under the
// Workspace key (unreadable in psql, readable through the API), the Changes
// feed carrying headers only, built-ins edited by copy and restored, "Use in
// every account" across two Workspaces, Undo of a delete, Export and Import,
// and Placeholders filled by span selection: first_name by code, time and
// date from the judge's picks, `none` and a low pick left for the user with
// their candidates, the language model's fallback, and nobody to ask.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, Template, TemplateFillResult, TemplateInput } from "@monday/shared";
import { BUILTIN_TEMPLATES } from "@monday/shared";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys, type Keys } from "../src/crypto/keys.ts";
import { settings as settingsTable } from "../src/db/schema.ts";
import { createIntelligence, type Intelligence } from "../src/intelligence/index.ts";
import {
  createFakeChat,
  createFakeJudge,
  type FakeChat,
  type FakeJudge,
} from "../src/intelligence/runtime/fake/index.ts";
import { createJobs } from "../src/jobs/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const SIDECAR_TOKEN = "per-launch-token";
const me = "sam@monday.test";
const sofia = { name: "Sofia Lindqvist", email: "sofia@lindqvist.se" };
const sam = { name: "Sam Rivera", email: me };

const account = (id: string, address: string): Account => ({
  id,
  provider: "imap",
  address,
  displayName: "Sam",
  capabilities: {
    push: false,
    labels: false,
    snooze: false,
    mute: false,
    calendar: false,
    meetingLink: null,
  },
});

const invoiceReply: TemplateInput = {
  name: "Invoice received",
  fitsWhen: "Someone sent an invoice the owner will pay",
  kind: "reply",
  subject: null,
  body: "Hi {first_name},\n\nThanks for invoice {invoice_number}. I'll pay it by {due?}.",
  placeholders: [
    { name: "first_name", type: "first_name", optional: false, hint: "their first name" },
    {
      name: "invoice_number",
      type: "reference",
      optional: false,
      hint: "the invoice number the sender quotes",
    },
    { name: "due", type: "date", optional: true, hint: "when it is due" },
  ],
};

describe("Templates I (slice 36)", () => {
  let db: TestDatabase;
  let keys: Keys;
  const rootKey = randomKey();
  let store: Mailstore;
  let intelligence: Intelligence;
  let app: Hono<AppEnv>;
  let judge: FakeJudge;
  let chat: FakeChat;
  let sharedKeys: Record<string, string> = { typesafe: "ts-key" };
  let workspaceId: string;
  let otherWorkspaceId: string;
  let podcastThread: string;
  let invoiceThread: string;

  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${SIDECAR_TOKEN}` },
    });
  const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await res).json() as T;

  const setSetting = async (key: string, value: unknown) => {
    await db.handle.db
      .insert(settingsTable)
      .values({ scope: "global", deviceId: null, key, value })
      .onConflictDoUpdate({
        target: [settingsTable.scope, settingsTable.deviceId, settingsTable.key],
        set: { value },
      });
  };

  beforeAll(async () => {
    db = await testDatabase();
    keys = createKeys(db.handle.db);
    await keys.unlock(rootKey);
    store = createMailstore(db.handle.db, keys);
    judge = createFakeJudge();
    chat = createFakeChat("");
    intelligence = createIntelligence({
      level: async () => "automate",
      db: db.handle.db,
      mailstore: store,
      chat: chat.chat,
      judge: judge.judge,
      keys: async (provider) => sharedKeys[provider] ?? null,
    });
    app = createApp({
      db: db.handle.db,
      auth: createAuth({ db: db.handle.db, sidecarToken: SIDECAR_TOKEN }),
      mode: "sidecar",
      keys,
      mailstore: store,
      jobs: createJobs(db.handle.db),
      intelligence,
      remoteAddress: () => "127.0.0.1",
    });
    workspaceId = (await store.createWorkspace(account("acct-work", me))).id;
    otherWorkspaceId = (await store.createWorkspace(account("acct-home", "sam@home.test"))).id;

    podcastThread = await store.upsertThread({
      workspaceId,
      providerThreadId: "thr-podcast",
      subject: "Podcast recording slot",
      participants: [sofia, sam],
      lastActivity: "2026-09-15T09:30:00.000Z",
    });
    await store.upsertMessage({
      threadId: podcastThread,
      providerMessageId: "msg-podcast-1",
      from: sofia,
      to: [sam],
      cc: [],
      date: "2026-09-15T09:30:00.000Z",
      headers: {},
      bodyText:
        "Hi Sam,\n\nWe are recording a series on people rebuilding old software categories. Would Thursday 2 October at 15:00 work for 45 minutes? If not, 3 October at 10am is free too.\n\nSofia",
      bodyHtml: null,
      snippet: "We are recording a series",
    });

    invoiceThread = await store.upsertThread({
      workspaceId,
      providerThreadId: "thr-invoice",
      subject: "Invoice for September",
      participants: [sofia, sam],
      lastActivity: "2026-09-16T09:30:00.000Z",
    });
    await store.upsertMessage({
      threadId: invoiceThread,
      providerMessageId: "msg-invoice-1",
      from: sofia,
      to: [sam],
      cc: [],
      date: "2026-09-16T09:30:00.000Z",
      headers: {},
      bodyText:
        "Hi Sam, attached is INV-2291 for September. It replaces INV-2290, which had the wrong rate.",
      bodyHtml: null,
      snippet: "attached is INV-2291",
    });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  test("a Template is sealed at rest, readable through the API, never a Setting", async () => {
    const res = await request("/templates", {
      method: "POST",
      body: JSON.stringify({ workspace: workspaceId, template: invoiceReply }),
    });
    expect(res.status).toBe(201);
    const { templates } = await json<{ templates: Template[] }>(res);
    expect(templates).toHaveLength(1);
    const saved = templates[0] as Template;
    expect(saved).toMatchObject({
      workspaceId,
      shareGroupId: null,
      builtIn: null,
      createdBy: "user",
      name: "Invoice received",
    });

    // psql sees ciphertext only: neither the name nor the body is in the row.
    const raw = await db.handle.sql<{ content_enc: Uint8Array }[]>`
      select content_enc from templates where id = ${saved.id}`;
    const bytes = Buffer.from(raw[0]?.content_enc ?? new Uint8Array()).toString("latin1");
    expect(bytes.includes("Invoice received")).toBe(false);
    expect(bytes.includes("first_name")).toBe(false);
    const columns = await db.handle.sql<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_name = 'templates'`;
    expect(columns.map((c) => c.column_name)).not.toContain("body");
    expect(columns.map((c) => c.column_name)).not.toContain("name");

    const listed = await json<{ templates: Template[] }>(
      request(`/templates?workspace=${workspaceId}`),
    );
    expect(listed.templates.map((t) => t.name)).toEqual(["Invoice received"]);
    expect((await json<Template>(request(`/templates/${saved.id}`))).body).toBe(invoiceReply.body);
    const settingRows = await db.handle.sql`select key from settings where key like 'templates%'`;
    expect(settingRows).toHaveLength(0);

    // The feed carries headers only; the Device asks the route for the content.
    const feed = await store.listChanges(workspaceId, { since: 0, limit: 1000 });
    const change = feed.changes.find((c) => c.kind === "template");
    expect(change?.payload).toEqual({
      id: saved.id,
      kind: "reply",
      builtIn: null,
      shareGroupId: null,
      createdBy: "user",
      updatedAt: saved.updatedAt,
      deleted: false,
    });
    expect(JSON.stringify(change)).not.toContain("Invoice received");

    // Locked, the content is refused like any other.
    keys.lock();
    expect((await request(`/templates?workspace=${workspaceId}`)).status).toBe(423);
    await keys.unlock(rootKey);
  });

  test("rotating the Workspace key re-wraps a Template, which still reads", async () => {
    const [made] = await intelligence.templates.store.create(workspaceId, {
      ...invoiceReply,
      name: "Survives rotation",
    });
    const before = await db.handle.sql<{ content_key: Uint8Array }[]>`
      select content_key from templates where id = ${made?.id ?? ""}`;
    await store.rotateWorkspaceKey(workspaceId);
    const after = await db.handle.sql<{ content_key: Uint8Array }[]>`
      select content_key from templates where id = ${made?.id ?? ""}`;
    expect(
      Buffer.from(after[0]?.content_key ?? []).equals(Buffer.from(before[0]?.content_key ?? [])),
    ).toBe(false);
    expect((await intelligence.templates.store.get(made?.id ?? ""))?.name).toBe(
      "Survives rotation",
    );
    await intelligence.templates.store.remove(made?.id ?? "");
  });

  test("a Template that breaks the Placeholder rules does not save", async () => {
    const res = await request("/templates", {
      method: "POST",
      body: JSON.stringify({
        workspace: workspaceId,
        template: { ...invoiceReply, body: "Hi {first_name}, {mystery}." },
      }),
    });
    expect(res.status).toBe(422);
    expect((await json<{ errors: string[] }>(res)).errors).toEqual([
      "{mystery} is used but not declared.",
      "{invoice_number} is declared but never used.",
      "{due} is declared but never used.",
    ]);
  });

  test("editing a built-in saves a copy that replaces it; Restore the original deletes the copy", async () => {
    const original = BUILTIN_TEMPLATES.find((t) => t.id === "t_decline") as Template;
    expect((await request("/templates/t_decline")).status).toBe(200);
    const res = await request("/templates/t_decline", {
      method: "PUT",
      body: JSON.stringify({
        workspace: workspaceId,
        template: { ...original, name: "Decline, kindly" },
      }),
    });
    const { templates } = await json<{ templates: Template[] }>(res);
    expect(templates[0]).toMatchObject({ builtIn: "t_decline", name: "Decline, kindly" });
    const library = await intelligence.templates.store.library(workspaceId);
    expect(library.some((t) => t.id === "t_decline")).toBe(false);
    expect(library.find((t) => t.builtIn === "t_decline")?.name).toBe("Decline, kindly");
    // A second edit changes the same copy.
    const again = await json<{ templates: Template[] }>(
      request("/templates/t_decline", {
        method: "PUT",
        body: JSON.stringify({ workspace: workspaceId, template: { ...original, name: "No" } }),
      }),
    );
    expect(again.templates[0]?.id).toBe(templates[0]?.id);
    // Restore the original.
    await request(`/templates/${templates[0]?.id}`, { method: "DELETE" });
    const after = await intelligence.templates.store.library(workspaceId);
    expect(after.find((t) => t.id === "t_decline")?.name).toBe("Decline politely");
    // A built-in itself cannot be deleted, and hiding one is the Setting.
    expect((await request("/templates/t_decline", { method: "DELETE" })).status).toBe(409);
    await setSetting("templates.builtin.hidden", ["t_thank_you"]);
    expect(
      (await intelligence.templates.store.library(workspaceId)).some((t) => t.id === "t_thank_you"),
    ).toBe(false);
    await setSetting("templates.builtin.hidden", []);
  });

  test("Use in every account saves one sealed copy per Workspace; Change it everywhere and Only here", async () => {
    const res = await request("/templates", {
      method: "POST",
      body: JSON.stringify({
        workspace: workspaceId,
        scope: "everywhere",
        template: { ...invoiceReply, name: "Shared thanks" },
      }),
    });
    const { templates } = await json<{ templates: Template[] }>(res);
    expect(templates.map((t) => t.workspaceId)).toEqual([workspaceId, otherWorkspaceId]);
    const group = templates[0]?.shareGroupId;
    expect(group).toBeTruthy();
    expect(templates[1]?.shareGroupId).toBe(group as string);
    const keysUsed = await db.handle.sql<{ content_key: Uint8Array }[]>`
      select content_key from templates where share_group_id = ${group as string}`;
    expect(
      Buffer.from(keysUsed[0]?.content_key ?? []).equals(
        Buffer.from(keysUsed[1]?.content_key ?? []),
      ),
    ).toBe(false);
    const home = await json<{ templates: Template[] }>(
      request(`/templates?workspace=${otherWorkspaceId}`),
    );
    expect(home.templates.map((t) => t.name)).toEqual(["Shared thanks"]);

    // Change it everywhere: both copies.
    await request(`/templates/${templates[0]?.id}`, {
      method: "PUT",
      body: JSON.stringify({
        workspace: workspaceId,
        everywhere: true,
        template: { ...invoiceReply, name: "Shared thanks, v2" },
      }),
    });
    expect((await intelligence.templates.store.get(templates[1]?.id ?? ""))?.name).toBe(
      "Shared thanks, v2",
    );
    // Only here: this copy changes and leaves the group; the other keeps its words.
    const only = await json<{ templates: Template[] }>(
      request(`/templates/${templates[1]?.id}`, {
        method: "PUT",
        body: JSON.stringify({
          workspace: otherWorkspaceId,
          template: { ...invoiceReply, name: "Home thanks" },
        }),
      }),
    );
    expect(only.templates[0]).toMatchObject({ name: "Home thanks", shareGroupId: null });
    expect((await intelligence.templates.store.get(templates[0]?.id ?? ""))?.name).toBe(
      "Shared thanks, v2",
    );
  });

  test("a delete is undone by restoring the same rows", async () => {
    const [made] = await intelligence.templates.store.create(workspaceId, {
      ...invoiceReply,
      name: "Short lived",
    });
    const removed = await json<{ removed: Template[] }>(
      request(`/templates/${made?.id}`, { method: "DELETE" }),
    );
    expect(removed.removed.map((t) => t.name)).toEqual(["Short lived"]);
    expect((await request(`/templates/${made?.id}`)).status).toBe(404);
    const back = await json<{ templates: Template[] }>(
      request("/templates/restore", { method: "POST", body: JSON.stringify({ ids: [made?.id] }) }),
    );
    expect(back.templates[0]?.name).toBe("Short lived");
    const feed = await store.listChanges(workspaceId, { since: 0, limit: 1000 });
    const rows = feed.changes.filter((c) => c.entityId === made?.id);
    expect(rows.map((c) => (c.payload as { deleted: boolean }).deleted)).toEqual([
      false,
      true,
      false,
    ]);
  });

  test("Export writes Markdown files that Import reads back", async () => {
    const { files } = await json<{ files: Array<{ name: string; content: string }> }>(
      request(`/templates/export?workspace=${workspaceId}`),
    );
    expect(files.map((f) => f.name)).toContain("invoice-received.md");
    const res = await json<{ created: Template[]; errors: unknown[] }>(
      request("/templates/import", {
        method: "POST",
        body: JSON.stringify({
          workspace: otherWorkspaceId,
          files: [
            ...files.filter((f) => f.name === "invoice-received.md"),
            { name: "broken.md", content: "nothing" },
          ],
        }),
      }),
    );
    expect(res.created.map((t) => t.name)).toEqual(["Invoice received"]);
    expect(res.created[0]?.workspaceId).toBe(otherWorkspaceId);
    expect(res.errors).toEqual([
      { file: "broken.md", message: "the file has no front matter between --- lines" },
    ]);
  });

  const fill = (templateId: string, body: Record<string, unknown>) =>
    json<TemplateFillResult>(
      request(`/templates/${templateId}/fill`, {
        method: "POST",
        body: JSON.stringify({ workspace: workspaceId, ...body }),
      }),
    );

  test("Confirm the time on the podcast Thread: first_name by code, time and date from the judge's picks", async () => {
    judge.answer("fill_time", "15:00");
    judge.answer("fill_date", "Thursday 2 October");
    const before = judge.calls.length;
    const result = await fill("t_confirm_time", { threadId: podcastThread });
    expect(result.judge).toBe("typesafe");
    const byName = Object.fromEntries(result.fills.map((f) => [f.name, f]));
    expect(byName.first_name).toMatchObject({
      value: "Sofia",
      by: "code",
      span: "Sofia Lindqvist",
    });
    expect(byName.time).toMatchObject({ value: "15:00", by: "judge", span: "15:00" });
    expect(byName.date).toMatchObject({
      value: "2 October",
      by: "judge",
      span: "Thursday 2 October",
    });
    // One request, one Choice per Placeholder that needed one; first_name asked nothing.
    expect(judge.calls.length).toBe(before + 1);
    expect(judge.calls.at(-1)?.questions).toEqual(["fill_time", "fill_date"]);
    const state = judge.calls.at(-1)?.state as {
      subject: string;
      messages: Array<{ text: string }>;
    };
    expect(state.subject).toBe("Podcast recording slot");
    expect(state.messages[0]?.text).toContain("Thursday 2 October at 15:00");
  });

  test("the judge answering none leaves the Placeholder unfilled with its candidates; nothing is invented", async () => {
    judge.answer("fill_invoice_number", "none");
    const result = await fill(
      (await intelligence.templates.store.list(workspaceId)).find(
        (t) => t.name === "Invoice received",
      )?.id ?? "",
      { threadId: invoiceThread },
    );
    const f = result.fills.find((x) => x.name === "invoice_number");
    expect(f?.value).toBeNull();
    expect(f?.by).toBeNull();
    expect(f?.candidates.map((c) => c.span)).toEqual(["INV-2291", "INV-2290"]);
    // The optional date has no candidate in the Thread: no question was spent on it.
    expect(judge.calls.at(-1)?.questions).toEqual(["fill_invoice_number"]);
    expect(result.fills.find((x) => x.name === "due")).toMatchObject({
      value: null,
      candidates: [],
    });
  });

  test("a pick below templates.fill.confidence stays for the user, likeliest candidate first", async () => {
    judge.answer("fill_invoice_number", {
      type: "choice",
      choice: "INV-2290",
      probabilities: { "INV-2291": 0.35, "INV-2290": 0.6, none: 0.05 },
      confidence: 0.4,
    });
    const id =
      (await intelligence.templates.store.list(workspaceId)).find(
        (t) => t.name === "Invoice received",
      )?.id ?? "";
    const low = await fill(id, { threadId: invoiceThread });
    const f = low.fills.find((x) => x.name === "invoice_number");
    expect(f?.value).toBeNull();
    expect(f?.candidates.map((c) => c.span)).toEqual(["INV-2290", "INV-2291"]);
    judge.answer("fill_invoice_number", "INV-2291");
    const sure = await fill(id, { threadId: invoiceThread });
    expect(sure.fills.find((x) => x.name === "invoice_number")?.value).toBe("INV-2291");
  });

  test("two people with the same first name: first_name asks the Choice", async () => {
    const thread = await store.upsertThread({
      workspaceId,
      providerThreadId: "thr-two-sofias",
      subject: "Two Sofias",
      participants: [sofia, sam],
      lastActivity: "2026-09-17T09:30:00.000Z",
    });
    await store.upsertMessage({
      threadId: thread,
      providerMessageId: "msg-two",
      from: sofia,
      to: [sam],
      cc: [{ name: "Sofia Berg", email: "sofia@berg.test" }],
      date: "2026-09-17T09:30:00.000Z",
      headers: {},
      bodyText: "Could we talk on Friday?",
      bodyHtml: null,
      snippet: "Could we talk",
    });
    judge.answer("fill_first_name", "Sofia Berg");
    const result = await fill("t_follow_up", { threadId: thread });
    expect(judge.calls.at(-1)?.questions).toContain("fill_first_name");
    expect(result.fills.find((f) => f.name === "first_name")).toMatchObject({
      value: "Sofia",
      span: "Sofia Berg",
      by: "judge",
    });
  });

  test("without TypeSafe the language model answers the same questions; with neither, nothing fills", async () => {
    sharedKeys = { anthropic: "sk-test" };
    chat.answer(
      JSON.stringify({
        fill_time: { choice: "10am", confidence: 0.9 },
        fill_date: { choice: "3 October", confidence: 0.9 },
      }),
    );
    const byLlm = await fill("t_confirm_time", { threadId: podcastThread });
    expect(byLlm.judge).toBe("llm");
    expect(byLlm.fills.find((f) => f.name === "time")?.value).toBe("10:00");
    expect(byLlm.fills.find((f) => f.name === "date")?.value).toBe("3 October");
    expect(chat.calls.at(-1)?.prompt).toContain("fill_time");

    sharedKeys = {};
    const none = await fill("t_confirm_time", { threadId: podcastThread });
    expect(none.judge).toBe("none");
    expect(none.fills.find((f) => f.name === "time")).toMatchObject({ value: null });
    expect(none.fills.find((f) => f.name === "time")?.candidates.length).toBe(2);
    // first_name needs no judge at all.
    expect(none.fills.find((f) => f.name === "first_name")?.value).toBe("Sofia");
    sharedKeys = { typesafe: "ts-key" };
  });

  test("a new Message fills only the To field's name", async () => {
    const result = await fill("t_schedule_call", { threadId: null, to: [sofia] });
    expect(result.fills.find((f) => f.name === "first_name")?.value).toBe("Sofia");
    expect(result.fills.find((f) => f.name === "topic")?.value).toBeNull();
    const two = await fill("t_schedule_call", {
      threadId: null,
      to: [sofia, { name: "Ravi", email: "r@x.test" }],
    });
    expect(two.fills.find((f) => f.name === "first_name")?.value).toBeNull();
  });
});
