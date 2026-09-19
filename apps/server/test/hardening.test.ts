// The hardening follow-ups on the record (migration 0014): Session
// transcripts and LangGraph checkpoints sealed under the envelope with the
// old rows still readable, the Voice profile sealed, the Workflow
// integration secrets as sealed rows with the Setting reduced to which ones
// are set up, and the indexes the hot request paths need.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { Account, AgentEvent, SessionSummary } from "@monday/shared";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys, type Keys } from "../src/crypto/keys.ts";
import { sessionEvents, sessions, voiceProfiles } from "../src/db/schema.ts";
import { createDrafts } from "../src/drafts/index.ts";
import {
  createSealedCheckpointer,
  decodeSealed,
  encodeSealed,
  graphThreadWorkspaces,
  SEALED_TYPE_PREFIX,
  type SealedPostgresSaver,
} from "../src/intelligence/agent/checkpointer.ts";
import { createServerToolHost } from "../src/intelligence/agent/host.ts";
import { createSessionStore } from "../src/intelligence/agent/sessions.ts";
import { createIntelligence, type Intelligence } from "../src/intelligence/index.ts";
import { createFakeChat, createFakeConverse } from "../src/intelligence/runtime/fake/index.ts";
import {
  createMailstore,
  type Mailstore,
  NotFoundError,
  rewrappedColumns,
} from "../src/mailstore/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const SIDECAR_TOKEN = "per-launch-token";
const NOW = new Date("2026-09-20T10:00:00Z");

const account: Account = {
  id: "acct-hardening",
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

function eventsOf(body: string): AgentEvent[] {
  return body
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data:")))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice("data:".length).trim()) as AgentEvent);
}

describe("transcripts and checkpoints under the envelope", () => {
  let db: TestDatabase;
  let keys: Keys;
  let store: Mailstore;
  let intelligence: Intelligence;
  let checkpointer: SealedPostgresSaver;
  let app: Hono<AppEnv>;
  let workspaceId = "";
  const converse = createFakeConverse();
  const rootKey = randomKey();

  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SIDECAR_TOKEN}`,
        ...(init.headers ?? {}),
      },
    });
  const send = (path: string, body: unknown, method = "POST") =>
    request(path, { method, body: JSON.stringify(body) });

  beforeAll(async () => {
    db = await testDatabase();
    keys = createKeys(db.handle.db);
    await keys.unlock(rootKey);
    store = createMailstore(db.handle.db, keys);
    checkpointer = await createSealedCheckpointer(db.url, {
      content: store,
      workspaceOf: graphThreadWorkspaces(db.handle.db),
    });
    intelligence = createIntelligence({
      level: async () => "automate",
      db: db.handle.db,
      mailstore: store,
      chat: createFakeChat("").chat,
      converse: converse.converse,
      checkpointer,
      now: () => NOW,
    });
    const auth = createAuth({ db: db.handle.db, sidecarToken: SIDECAR_TOKEN });
    app = createApp({
      db: db.handle.db,
      auth,
      mode: "sidecar",
      keys,
      mailstore: store,
      intelligence,
      remoteAddress: () => "127.0.0.1",
    });
    workspaceId = (await store.createWorkspace(account)).id;
    await send("/keys/anthropic", { workspace: workspaceId, key: "sk-ant-shared" }, "PUT");
    for (let i = 1; i <= 3; i++) {
      await store.upsertThread({
        workspaceId,
        providerThreadId: `nl-${i}`,
        subject: `Weekly digest ${i}`,
        participants: [{ name: "Digest", email: "digest@newsletter.test" }],
        lastActivity: new Date(NOW.getTime() - i * 86_400_000).toISOString(),
        section: "newsletters",
      });
    }
  }, 60_000);

  afterAll(async () => {
    await checkpointer.end().catch(() => {});
    await db.drop();
  });

  test("the sealed blob wire format round-trips", () => {
    const key = new Uint8Array([1, 2, 3]);
    const envelope = new Uint8Array([9, 8, 7, 6]);
    const decoded = decodeSealed(encodeSealed(key, envelope));
    expect([...decoded.key]).toEqual([1, 2, 3]);
    expect([...decoded.envelope]).toEqual([9, 8, 7, 6]);
    expect(() => decodeSealed(new Uint8Array([0, 9, 1]))).toThrow(RangeError);
  });

  test("a turn's transcript and checkpoint rows hold no plaintext; the paused turn resumes through the sealed checkpointer", async () => {
    const secret = "archive the newsletters, the ones about the zebra budget";
    converse.script(
      {
        text: "Looking.",
        toolCalls: [
          { id: "t1", name: "search_threads", args: { section: "newsletters", limit: 10 } },
        ],
      },
      (call) => {
        const tool = [...call.messages].reverse().find((m) => m.role === "tool");
        const json = tool?.role === "tool" ? tool.content.slice(tool.content.indexOf("[")) : "[]";
        const ids = (JSON.parse(json) as Array<{ id: string }>).map((t) => t.id);
        return { toolCalls: [{ id: "t2", name: "trash_threads", args: { thread_ids: ids } }] };
      },
      "Done: the zebra budget newsletters are in the trash.",
    );
    const created = await send("/sessions", { workspace: workspaceId });
    const session = (await created.json()) as SessionSummary;
    const turn = await send(`/sessions/${session.id}/turns`, { text: secret });
    expect(turn.status).toBe(200);
    const events = eventsOf(await turn.text());
    const waiting = events.find((e) => e.kind === "tool" && e.call.status === "waiting");
    if (waiting?.kind !== "tool") throw new Error("no waiting card");

    // session_events: every row sealed, the plaintext column empty.
    const rows = await db.handle.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, session.id));
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) {
      expect(row.event).toBeNull();
      expect(row.eventEnc).not.toBeNull();
      expect(row.eventKey).not.toBeNull();
      expect(new TextDecoder().decode(row.eventEnc ?? new Uint8Array())).not.toContain("zebra");
    }
    // Read back through the store, the transcript is whole.
    const history = await request(`/sessions/${session.id}`);
    const body = (await history.json()) as { events: AgentEvent[] };
    expect(body.events[0]).toMatchObject({ kind: "user", text: secret });

    // langgraph.checkpoint_blobs and checkpoint_writes: sealed types, no plaintext.
    const blobs = await db.handle.sql<{ type: string; blob: Uint8Array | null }[]>`
      select type, blob from langgraph.checkpoint_blobs where thread_id = ${session.id}
    `;
    expect(blobs.length).toBeGreaterThan(0);
    for (const b of blobs) {
      if (b.type === "empty") continue;
      expect(b.type.startsWith(SEALED_TYPE_PREFIX)).toBe(true);
      expect(new TextDecoder().decode(b.blob ?? new Uint8Array())).not.toContain("zebra");
    }
    const writes = await db.handle.sql<{ type: string; blob: Uint8Array }[]>`
      select type, blob from langgraph.checkpoint_writes where thread_id = ${session.id}
    `;
    for (const w of writes) {
      expect(w.type.startsWith(SEALED_TYPE_PREFIX)).toBe(true);
      expect(new TextDecoder().decode(w.blob)).not.toContain("zebra");
    }
    // The whole langgraph schema, dumped as text, never mentions the user's words.
    const dump = await db.handle.sql<{ t: string }[]>`
      select encode(blob, 'escape') as t from langgraph.checkpoint_blobs
      union all select encode(blob, 'escape') from langgraph.checkpoint_writes
      union all select checkpoint::text from langgraph.checkpoints
      union all select metadata::text from langgraph.checkpoints
    `;
    expect(dump.some((r) => r.t?.includes("zebra"))).toBe(false);

    // Resume: the checkpoint is opened, the tool applies, the model finishes.
    const resumed = await send(`/sessions/${session.id}/approvals/${waiting.call.id}`, {
      decision: "approved",
    });
    expect(resumed.status).toBe(200);
    const after = eventsOf(await resumed.text());
    expect(after.some((e) => e.kind === "text" && e.text.includes("zebra budget"))).toBe(true);
    expect(after.at(-1)).toMatchObject({ kind: "done", waiting: null });
    const trashed = await store.listThreads(workspaceId, { limit: 10, section: "newsletters" });
    expect(trashed.threads).toHaveLength(0);
  });

  test("a legacy transcript row reads as it is, and sealLegacy moves it under the envelope", async () => {
    const sessionStore = createSessionStore(db.handle.db, { content: store, now: () => NOW });
    const session = await sessionStore.create(workspaceId, {
      kind: "hosted",
      provider: "anthropic",
      model: "m",
    });
    const legacy: AgentEvent = { kind: "user", id: "u-legacy", text: "an old plaintext turn" };
    await db.handle.db
      .insert(sessionEvents)
      .values({ sessionId: session.id, event: legacy, at: NOW });
    await sessionStore.append(session.id, { kind: "text", id: "a-new", text: "sealed answer" });
    expect(await sessionStore.events(session.id)).toEqual([
      legacy,
      { kind: "text", id: "a-new", text: "sealed answer" },
    ]);
    expect(await sessionStore.sealLegacy()).toBe(1);
    expect(await sessionStore.sealLegacy()).toBe(0);
    const rows = await db.handle.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, session.id));
    expect(rows.every((r) => r.event === null && r.eventEnc !== null)).toBe(true);
    expect(await sessionStore.events(session.id)).toEqual([
      legacy,
      { kind: "text", id: "a-new", text: "sealed answer" },
    ]);
    // A locked Server cannot read a transcript: 423 from the route.
    keys.lock();
    const locked = await request(`/sessions/${session.id}`);
    expect(locked.status).toBe(423);
    await keys.unlock(rootKey);
  });

  test("a checkpoint written in the clear before the upgrade still reads through the sealed saver", async () => {
    const plain = PostgresSaver.fromConnString(db.url, { schema: "langgraph" });
    const [row] = await db.handle.db
      .insert(sessions)
      .values({
        id: "legacy-thread",
        workspaceId,
        runtime: { kind: "hosted", provider: "anthropic", model: "m" },
        startedAt: NOW,
        lastActivity: NOW,
      })
      .returning();
    expect(row).toBeDefined();
    const config = { configurable: { thread_id: "legacy-thread", checkpoint_ns: "" } };
    const checkpoint = {
      v: 4,
      id: "1ef4f797-8335-6428-8001-8a1503f9b875",
      ts: NOW.toISOString(),
      channel_values: { messages: [{ role: "user", content: "before the upgrade" }] },
      channel_versions: { messages: 1 },
      versions_seen: {},
    };
    await plain.put(
      config,
      checkpoint,
      { source: "input", step: -1, parents: {} },
      { messages: 1 },
    );
    await plain.end();
    const tuple = await checkpointer.getTuple(config);
    expect(tuple?.checkpoint.channel_values).toEqual({
      messages: [{ role: "user", content: "before the upgrade" }],
    });
    const types = await db.handle.sql<{ type: string }[]>`
      select type from langgraph.checkpoint_blobs where thread_id = 'legacy-thread'
    `;
    expect(types.map((t) => t.type)).toEqual(["json"]);
  });

  test("the Voice profile is sealed: excerpts never sit in a plaintext column, and a legacy row moves under the envelope", async () => {
    const put = await send(
      "/voice",
      {
        workspace: workspaceId,
        description: "Short and warm.",
        excerpts: ["Thanks for the quick turnaround on the okapi invoice"],
        enabled: true,
      },
      "PUT",
    );
    expect(put.status).toBe(200);
    const [row] = await db.handle.db
      .select()
      .from(voiceProfiles)
      .where(eq(voiceProfiles.workspaceId, workspaceId));
    expect(row?.description).toBe("");
    expect(row?.excerpts).toEqual([]);
    expect(row?.profileEnc).not.toBeNull();
    const dumped = await db.handle.sql<{ t: string }[]>`
      select voice_profiles::text as t from voice_profiles where workspace_id = ${workspaceId}
    `;
    expect(dumped[0]?.t).not.toContain("okapi");
    const read = (await (await request(`/voice?workspace=${workspaceId}`)).json()) as {
      description: string;
      excerpts: string[];
      enabled: boolean;
    };
    expect(read).toMatchObject({
      description: "Short and warm.",
      excerpts: ["Thanks for the quick turnaround on the okapi invoice"],
      enabled: true,
    });
    // A patch keeps the sealed text it does not touch.
    await send("/voice", { workspace: workspaceId, enabled: false }, "PUT");
    const after = (await (await request(`/voice?workspace=${workspaceId}`)).json()) as {
      excerpts: string[];
      enabled: boolean;
    };
    expect(after.enabled).toBe(false);
    expect(after.excerpts).toEqual(["Thanks for the quick turnaround on the okapi invoice"]);

    // A row from before the upgrade: plaintext columns, no envelope.
    const other = (await store.createWorkspace({ ...account, id: "acct-legacy-voice" })).id;
    await db.handle.db.insert(voiceProfiles).values({
      workspaceId: other,
      description: "Old and plain",
      excerpts: ["written before 0014"],
      enabled: true,
    });
    const legacy = (await (await request(`/voice?workspace=${other}`)).json()) as {
      description: string;
    };
    expect(legacy.description).toBe("Old and plain");
    const swept = await intelligence.sealLegacy();
    expect(swept.voices).toBe(1);
    const [sealed] = await db.handle.db
      .select()
      .from(voiceProfiles)
      .where(eq(voiceProfiles.workspaceId, other));
    expect(sealed?.description).toBe("");
    expect(sealed?.profileEnc).not.toBeNull();
    expect(
      ((await (await request(`/voice?workspace=${other}`)).json()) as { excerpts: string[] })
        .excerpts,
    ).toEqual(["written before 0014"]);
    expect((await intelligence.sealLegacy()).voices).toBe(0);
    // Locked: the profile is content.
    keys.lock();
    expect((await request(`/voice?workspace=${other}`)).status).toBe(423);
    await keys.unlock(rootKey);
  });

  test("integration secrets are sealed rows; the Setting holds only which ones exist; a legacy Setting is adopted", async () => {
    // Nothing yet: every integration reports unconfigured.
    const empty = (await (await request("/integrations")).json()) as {
      integrations: Array<{ integration: string; configured: boolean }>;
    };
    expect(empty.integrations.map((i) => i.integration)).toEqual([
      "slack",
      "notion",
      "drive",
      "discord",
      "webhook",
    ]);
    expect(empty.integrations.every((i) => !i.configured)).toBe(true);

    const put = await send(
      "/integrations/slack",
      { workspace: workspaceId, token: "xoxb-giraffe-secret" },
      "PUT",
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ integration: "slack", configured: true });
    expect(
      (await send("/integrations/nope", { workspace: workspaceId, token: "x" }, "PUT")).status,
    ).toBe(400);
    expect((await send("/integrations/notion", { workspace: workspaceId }, "PUT")).status).toBe(
      400,
    );
    // The token is nowhere in the settings table; the Setting says slack is set up.
    const settingRows = await db.handle.sql<{ key: string; value: unknown }[]>`
      select key, value from settings where key = 'workflows.integrations'
    `;
    expect(settingRows[0]?.value).toEqual({ slack: true });
    const settingsText = await db.handle.sql<
      { t: string }[]
    >`select settings::text as t from settings`;
    expect(settingsText.some((r) => r.t.includes("giraffe"))).toBe(false);
    const secretRows = await db.handle.sql<{ t: string }[]>`
      select integration_secrets::text as t from integration_secrets
    `;
    expect(secretRows).toHaveLength(1);
    expect(secretRows[0]?.t).not.toContain("giraffe");
    // The Workflow steps read it in the clear through the store.
    expect(await intelligence.integrationSecrets.load("slack")).toEqual({
      token: "xoxb-giraffe-secret",
    });
    expect(await intelligence.integrationSecrets.list()).toEqual(["slack"]);
    const listed = (await (await request("/integrations")).json()) as {
      integrations: Array<{ integration: string; configured: boolean }>;
    };
    expect(listed.integrations.find((i) => i.integration === "slack")?.configured).toBe(true);

    // A locked Server still lists, and refuses to seal or open.
    keys.lock();
    expect((await request("/integrations")).status).toBe(200);
    expect(
      (
        await send(
          "/integrations/discord",
          { workspace: workspaceId, webhookUrl: "https://d.test/h" },
          "PUT",
        )
      ).status,
    ).toBe(423);
    await expect(intelligence.integrationSecrets.load("slack")).rejects.toThrow("locked");
    await keys.unlock(rootKey);

    // Clearing drops the row and the flag.
    expect((await request("/integrations/slack", { method: "DELETE" })).status).toBe(204);
    expect(await intelligence.integrationSecrets.list()).toEqual([]);
    const cleared = await db.handle.sql<{ value: unknown }[]>`
      select value from settings where key = 'workflows.integrations'
    `;
    expect(cleared[0]?.value).toEqual({});

    // A Setting written before 0014 held the secrets themselves: the sweep moves them.
    await db.handle.sql`
      update settings set value = ${JSON.stringify({
        slack: { webhookUrl: "https://hooks.slack.test/T/B/zebra" },
        discord: { webhookUrl: "https://discord.test/api/webhooks/1/hippo" },
        notion: { token: "" },
      })}::jsonb where key = 'workflows.integrations'
    `;
    const swept = await intelligence.sealLegacy();
    expect(swept.integrations).toBe(2);
    expect(await intelligence.integrationSecrets.list()).toEqual(["slack", "discord"]);
    expect(await intelligence.integrationSecrets.load("discord")).toEqual({
      webhookUrl: "https://discord.test/api/webhooks/1/hippo",
    });
    const adopted = await db.handle.sql<{ value: unknown }[]>`
      select value from settings where key = 'workflows.integrations'
    `;
    expect(adopted[0]?.value).toEqual({ slack: true, discord: true });
    const noSecrets = await db.handle.sql<
      { t: string }[]
    >`select settings::text as t from settings`;
    expect(noSecrets.some((r) => r.t.includes("zebra") || r.t.includes("hippo"))).toBe(false);
    expect((await intelligence.sealLegacy()).integrations).toBe(0);
  });

  test("the Workspace of a graph thread resolves for Sessions, epochs and agentic Steps", async () => {
    const resolve = graphThreadWorkspaces(db.handle.db);
    expect(await resolve("legacy-thread")).toBe(workspaceId);
    expect(await resolve("legacy-thread#2")).toBe(workspaceId);
    expect(await resolve("nope")).toBeNull();
    expect(await resolve("run:nope:0")).toBeNull();
    await db.handle
      .sql`insert into workflows (id, workspace_id, name) values ('wf-1', ${workspaceId}, 'x')`;
    await db.handle
      .sql`insert into workflow_versions (workflow_id, version, document) values ('wf-1', 1, '{}'::jsonb)`;
    await db.handle.sql`insert into workflow_runs (id, workflow_id, workspace_id, version, trigger)
        values ('run-1', 'wf-1', ${workspaceId}, 1, '{"kind":"manual"}'::jsonb)`;
    expect(await resolve("run:run-1:3")).toBe(workspaceId);
  });

  test("the Agent's host lists Groups by name and filters Threads in the query", async () => {
    const parent = await intelligence.routing.createGroup(workspaceId, {
      name: "Hiring",
      sentence: "candidates and interviews",
    });
    const child = await intelligence.routing.createGroup(workspaceId, {
      name: "Candidates",
      sentence: "applications",
      parentId: parent.id,
    });
    const host = createServerToolHost({
      db: db.handle.db,
      mailstore: store,
      drafts: createDrafts({ db: db.handle.db, mailstore: store }),
      workspaceId,
    });
    expect(await host.listGroups()).toEqual([
      { id: parent.id, name: "Hiring" },
      { id: child.id, name: "Hiring / Candidates" },
    ]);
    const old = new Date(NOW.getTime() - 30 * 86_400_000).toISOString();
    for (let i = 1; i <= 3; i++) {
      await store.upsertThread({
        workspaceId,
        providerThreadId: `filter-${i}`,
        subject: `Filter ${i}`,
        participants: [{ name: "F", email: "f@example.test" }],
        lastActivity: i === 1 ? old : NOW.toISOString(),
        unread: i !== 3,
        section: "fyi",
      });
    }
    const unread = await host.listThreads({ limit: 10, section: "fyi", unread: true });
    expect(unread.map((t) => t.subject).sort()).toEqual(["Filter 1", "Filter 2"]);
    const read = await host.listThreads({ limit: 10, section: "fyi", unread: false });
    expect(read.map((t) => t.subject)).toEqual(["Filter 3"]);
    const older = await host.listThreads({
      limit: 10,
      section: "fyi",
      olderThan: new Date(NOW.getTime() - 86_400_000).toISOString(),
    });
    expect(older.map((t) => t.subject)).toEqual(["Filter 1"]);
    // The Mailstore answers the same filters directly, so the host never pages the whole list.
    const page = await store.listThreads(workspaceId, {
      limit: 10,
      section: "fyi",
      unread: true,
      before: new Date(NOW.getTime() - 86_400_000).toISOString(),
    });
    expect(page.threads.map((t) => t.subject)).toEqual(["filter 1"]);
    await intelligence.routing.deleteGroup(parent.id);
  });

  test("the Agent's host never reads or writes across Workspaces, whatever id it is handed", async () => {
    const otherWorkspace = (await store.createWorkspace({ ...account, id: "acct-other-ws" })).id;
    const foreign = await store.upsertThread({
      workspaceId: otherWorkspace,
      providerThreadId: "foreign-1",
      subject: "Not yours",
      participants: [{ name: "Elsewhere", email: "else@example.test" }],
      lastActivity: NOW.toISOString(),
      unread: true,
    });
    const foreignMessage = await store.upsertMessage({
      threadId: foreign,
      providerMessageId: "foreign-m1",
      from: { name: "Elsewhere", email: "else@example.test" },
      to: [],
      cc: [],
      date: NOW.toISOString(),
      headers: {},
      bodyText: "secret elsewhere",
      bodyHtml: null,
      snippet: "secret",
    });
    const foreignAttachment = await store.putAttachment(foreignMessage, {
      name: "a.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("attached elsewhere"),
    });
    const foreignDrafts = createDrafts({ db: db.handle.db, mailstore: store });
    const foreignDraft = await foreignDrafts.save({
      id: "foreign-draft",
      workspaceId: otherWorkspace,
      content: {
        threadId: null,
        kind: "new",
        inReplyToMessageId: null,
        to: [{ name: "X", email: "x@example.test" }],
        cc: [],
        bcc: [],
        subject: "Foreign draft",
        bodyText: "foreign",
        bodyHtml: "<p>foreign</p>",
        attachments: [],
      },
    });
    expect(foreignDraft.applied).toBe(true);
    const host = createServerToolHost({
      db: db.handle.db,
      mailstore: store,
      drafts: foreignDrafts,
      workspaceId,
    });
    expect(await host.readThread(foreign)).toBeNull();
    expect(await host.threadsById([foreign])).toEqual([]);
    expect(await host.readAttachment?.(foreignAttachment)).toBeNull();
    expect(await host.readDraft("foreign-draft")).toBeNull();
    await expect(host.scheduleSend("foreign-draft")).rejects.toBeInstanceOf(NotFoundError);
    expect(await host.applyIntents([{ kind: "archive", threadId: foreign }])).toEqual({
      applied: 0,
    });
    expect((await store.findThread(otherWorkspace, "foreign-1"))?.archived).toBe(false);
    await host.deleteDraft("foreign-draft");
    expect((await foreignDrafts.get("foreign-draft")).status).toBe("open");
    // The other Workspace's own host sees all of it.
    const theirs = createServerToolHost({
      db: db.handle.db,
      mailstore: store,
      drafts: foreignDrafts,
      workspaceId: otherWorkspace,
    });
    expect((await theirs.readThread(foreign))?.messages[0]?.text).toBe("secret elsewhere");
    expect((await theirs.readAttachment?.(foreignAttachment))?.name).toBe("a.txt");
    expect(await theirs.applyIntents([{ kind: "archive", threadId: foreign }])).toEqual({
      applied: 1,
    });
  });

  test("typed failures answer as 4xx, not 500", async () => {
    // A cursor the Mailstore cannot read is the client's mistake.
    const bad = await request(`/threads?workspace=${workspaceId}&cursor=not-a-cursor`);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_request", detail: "bad cursor" });
    // Content for a Workspace this database has no key for.
    const missing = await send(
      "/integrations/notion",
      { workspace: "no-such-workspace", token: "x" },
      "PUT",
    );
    expect(missing.status).toBe(404);
  });

  test("the hot request paths have the indexes they need (explain)", async () => {
    // With sequential scans discouraged, the planner picks the index when one fits; a
    // missing index shows up as a scan of the table.
    const plan = async (query: string): Promise<string> => {
      const rows = await db.handle.sql.begin(async (tx) => {
        await tx`set local enable_seqscan = off`;
        return tx.unsafe(`explain (format text) ${query}`);
      });
      return (rows as unknown as Array<{ "QUERY PLAN": string }>)
        .map((r) => r["QUERY PLAN"])
        .join("\n");
    };
    const w = workspaceId.replaceAll("'", "''");
    const cases: Array<[string, string]> = [
      // GET /messages/bodies: a Workspace's Messages by date, newest first.
      [
        `select id from messages where workspace_id = '${w}' and date >= now() - interval '2 years' order by date desc, id desc limit 200`,
        "messages_workspace_date_idx",
      ],
      // GET /threads?group=: a Sub-group's Threads.
      [
        `select id from threads where workspace_id = '${w}' and subgroup_id = 'g' and deleted = false`,
        "threads_subgroup_idx",
      ],
      // The snooze sweep at boot.
      [
        `select id from threads where workspace_id = '${w}' and snoozed_until is not null`,
        "threads_snoozed_idx",
      ],
      // GET /workflows/runs: a Workspace's Runs, newest first.
      [
        `select id from workflow_runs where workspace_id = '${w}' order by started_at desc limit 100`,
        "workflow_runs_workspace_started_idx",
      ],
      // GET /changes: the feed from a cursor.
      [
        `select seq from changes where workspace_id = '${w}' and seq > 10 order by seq limit 500`,
        "changes_workspace_seq_idx",
      ],
      // GET /activity: a Workspace's log, newest first.
      [
        `select id from activity where workspace_id = '${w}' order by at desc limit 100`,
        "activity_workspace_at_idx",
      ],
      // The Jobs claim.
      [
        `select id from jobs where status = 'queued' and run_at <= now() order by run_at limit 1`,
        "jobs_claim_idx",
      ],
      // The calendar window.
      [
        `select id from events where workspace_id = '${w}' and start < now() and "end" > now() - interval '1 day'`,
        "events_window_idx",
      ],
    ];
    const defined = await db.handle.sql<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes where schemaname = 'public'
    `;
    const columnsOf = (name: string) =>
      /\((.*)\)/.exec(defined.find((i) => i.indexname === name)?.indexdef ?? "")?.[1] ?? "";
    const expectedColumns: Record<string, string> = {
      messages_workspace_date_idx: "workspace_id, date, id",
      threads_subgroup_idx: "workspace_id, subgroup_id",
      threads_snoozed_idx: "workspace_id, snoozed_until",
      workflow_runs_workspace_started_idx: "workspace_id, started_at",
      changes_workspace_seq_idx: "workspace_id, seq",
      activity_workspace_at_idx: "workspace_id, at",
      jobs_claim_idx: "status, run_at",
      events_window_idx: 'workspace_id, start, "end"',
    };
    for (const [query, index] of cases) {
      // The index exists with the columns the query filters and orders by...
      expect(columnsOf(index), index).toBe(expectedColumns[index] ?? "");
      // ...and the planner reaches the rows through an index, never a scan of the table.
      const text = await plan(query);
      expect(text, `${query}\n${text}`).toMatch(/Index (Only )?Scan/);
      expect(text, `${query}\n${text}`).not.toContain("Seq Scan");
    }
  });

  test("rotating the Workspace key re-wraps every envelope in the schema, checkpoints and transcripts included", async () => {
    // Everything sealed so far: threads, a transcript, checkpoint blobs, the
    // Voice profile, integration secrets, the shared provider key; plus a Draft.
    const draftId = crypto.randomUUID();
    const saved = await send(
      `/drafts/${draftId}`,
      {
        workspace: workspaceId,
        content: {
          threadId: null,
          kind: "new",
          inReplyToMessageId: null,
          to: [{ name: "Sam", email: "sam@example.test" }],
          cc: [],
          bcc: [],
          subject: "Rotation",
          bodyText: "still readable after the rotation",
          bodyHtml: "<p>still readable after the rotation</p>",
          attachments: [],
        },
      },
      "PUT",
    );
    expect(saved.status).toBe(200);
    await send("/integrations/notion", { workspace: workspaceId, token: "ntn-rotate" }, "PUT");

    // The list the rotation walks is exactly the schema's wrapped-key columns.
    const columns = await db.handle.sql<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and data_type = 'bytea'
        and (column_name like '%\_key' or column_name = 'key')
        and not (table_name = 'workspace_keys')
      order by 1, 2
    `;
    const expected = columns.map((c) => `${c.table_name}.${c.column_name}`);
    const walked = rewrappedColumns().filter((c) => !c.startsWith("langgraph."));
    expect([...walked].sort()).toEqual([...expected].sort());

    const [before] = await db.handle.sql<{ blob: Uint8Array }[]>`
      select blob from langgraph.checkpoint_blobs where type like 'monday-sealed+%' limit 1
    `;
    const result = await store.rotateWorkspaceKey(workspaceId);
    expect(result.version).toBe(2);
    expect(result.rewrapped).toBeGreaterThan(10);
    const [after] = await db.handle.sql<{ blob: Uint8Array }[]>`
      select blob from langgraph.checkpoint_blobs where type like 'monday-sealed+%' limit 1
    `;
    expect(Buffer.from(after?.blob ?? []).equals(Buffer.from(before?.blob ?? []))).toBe(false);

    // Everything still opens under the new key.
    const draft = (await (await request(`/drafts/${draftId}`)).json()) as { bodyText: string };
    expect(draft.bodyText).toBe("still readable after the rotation");
    expect(await intelligence.integrationSecrets.load("notion")).toEqual({ token: "ntn-rotate" });
    expect(await intelligence.keys.load("anthropic")).toBe("sk-ant-shared");
    const voice = (await (await request(`/voice?workspace=${workspaceId}`)).json()) as {
      description: string;
    };
    expect(voice.description).toBe("Short and warm.");
    const sessionsList = (await (await request(`/sessions?workspace=${workspaceId}`)).json()) as {
      sessions: SessionSummary[];
    };
    const first = sessionsList.sessions.find((s) => s.title.includes("zebra"));
    expect(first).toBeDefined();
    const history = (await (await request(`/sessions/${first?.id}`)).json()) as {
      events: AgentEvent[];
    };
    expect(history.events[0]?.kind).toBe("user");
    const tuple = await checkpointer.getTuple({
      configurable: { thread_id: first?.id ?? "", checkpoint_ns: "" },
    });
    expect(tuple?.checkpoint.channel_values.messages).toBeDefined();
    // A second rotation walks the same rows again.
    expect((await store.rotateWorkspaceKey(workspaceId)).rewrapped).toBe(result.rewrapped);
  });
});
