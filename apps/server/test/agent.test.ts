// The Agent host over Postgres and the routes (slice 14, ADR 0002, ADR 0007):
// the done-when story through the Hosted runtime with the fake model
// scripted, the LangGraph checkpoint in Postgres (PostgresSaver under the
// `langgraph` schema), the Server ToolHost acting through the Mailstore so
// every archive lands in the Changes feed, the Activity log rows, and Undo
// restoring every Thread through the same intent path the Outbox uses.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { Account, ActivityRecord, AgentEvent, SessionSummary } from "@monday/shared";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys, type Keys } from "../src/crypto/keys.ts";
import { createIntelligence, type Intelligence } from "../src/intelligence/index.ts";
import { createFakeChat, createFakeConverse } from "../src/intelligence/runtime/fake/index.ts";
import type { AgentMessage } from "../src/intelligence/runtime/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const SIDECAR_TOKEN = "per-launch-token";
const NOW = new Date("2026-09-17T10:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const account: Account = {
  id: "acct-agent",
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

/** The ids the search tool answered with, read back from the transcript the model sees. */
const idsFromSearch = (messages: AgentMessage[]): string[] => {
  const tool = [...messages]
    .reverse()
    .find((m) => m.role === "tool" && m.name === "search_threads");
  if (tool?.role !== "tool") return [];
  const json = tool.content.slice(tool.content.indexOf("["));
  return (JSON.parse(json) as Array<{ id: string }>).map((t) => t.id);
};

/** Parses the SSE body of a turn into its events. */
function eventsOf(body: string): AgentEvent[] {
  return body
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data:")))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice("data:".length).trim()) as AgentEvent);
}

describe("the Agent host over Postgres", () => {
  let db: TestDatabase;
  let keys: Keys;
  let store: Mailstore;
  let intelligence: Intelligence;
  let checkpointer: PostgresSaver;
  let app: Hono<AppEnv>;
  let workspaceId = "";
  const oldIds: string[] = [];
  const freshIds: string[] = [];
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

  const listInbox = async (section: string) => {
    const page = await store.listThreads(workspaceId, { section, limit: 500 });
    return page.threads.map((t) => t.id).sort();
  };

  beforeAll(async () => {
    db = await testDatabase();
    keys = createKeys(db.handle.db);
    await keys.unlock(rootKey);
    store = createMailstore(db.handle.db, keys);
    checkpointer = PostgresSaver.fromConnString(db.url, { schema: "langgraph" });
    await checkpointer.setup();
    intelligence = createIntelligence({
      // These slices ran before the AI level existed; they assume the full level (slice 20).
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
    // The Hosted runtime on the Server runs on a shared key under the envelope (ADR 0007).
    expect(
      (await send("/keys/anthropic", { workspace: workspaceId, key: "sk-ant-shared" }, "PUT"))
        .status,
    ).toBe(200);
    for (let i = 1; i <= 12; i++) {
      oldIds.push(
        await store.upsertThread({
          workspaceId,
          providerThreadId: `nl-old-${i}`,
          subject: `Weekly digest ${i}`,
          participants: [{ name: "Digest", email: "digest@newsletter.test" }],
          lastActivity: daysAgo(7 + i),
          section: "newsletters",
        }),
      );
    }
    for (let i = 1; i <= 2; i++) {
      freshIds.push(
        await store.upsertThread({
          workspaceId,
          providerThreadId: `nl-new-${i}`,
          subject: `This week ${i}`,
          participants: [{ name: "Digest", email: "digest@newsletter.test" }],
          lastActivity: daysAgo(i),
          section: "newsletters",
        }),
      );
    }
    const aoife = await store.upsertThread({
      workspaceId,
      providerThreadId: "t-aoife",
      subject: "Take-home review",
      participants: [{ name: "Aoife", email: "aoife@example.test" }],
      lastActivity: daysAgo(1),
      section: "needs-reply",
      unread: true,
    });
    await store.upsertMessage({
      threadId: aoife,
      providerMessageId: "m-aoife-1",
      from: { name: "Aoife", email: "aoife@example.test" },
      to: [{ name: "Me", email: "me@example.test" }],
      cc: [],
      date: daysAgo(1),
      headers: { "message-id": "<m-aoife-1@example.test>" },
      bodyText: "Does Thursday 15:00 work for the call?",
      bodyHtml: null,
      snippet: "Does Thursday 15:00 work",
    });
  });

  afterAll(async () => {
    await checkpointer.end().catch(() => {});
    await db.drop();
  });

  test("the LangGraph checkpoint tables exist under the langgraph schema", async () => {
    const rows = await db.handle.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'langgraph' order by table_name
    `;
    expect(rows.map((r) => r.table_name)).toEqual([
      "checkpoint_blobs",
      "checkpoint_migrations",
      "checkpoint_writes",
      "checkpoints",
    ]);
  });

  test("archive every newsletter older than a week: previews above 10, applies, and Undo restores them, all through the Hosted runtime", async () => {
    converse.script(
      {
        text: "Let me find them.",
        toolCalls: [
          {
            id: "toolu_01",
            name: "search_threads",
            args: { section: "newsletters", older_than_days: 7 },
          },
        ],
      },
      (call) => ({
        toolCalls: [
          {
            id: "toolu_02",
            name: "archive_threads",
            args: { thread_ids: idsFromSearch(call.messages) },
          },
        ],
      }),
      "Archived 12 newsletters older than a week.",
    );

    // A Session on the Hosted runtime.
    const created = await send("/sessions", { workspace: workspaceId });
    expect(created.status).toBe(201);
    const session = (await created.json()) as SessionSummary;
    expect(session.runtime).toEqual({
      kind: "hosted",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    expect(session.workspaceId).toBe(workspaceId);

    // The turn streams over SSE and pauses at the preview: 12 is above the threshold of 10.
    const before = await store.latestSeq(workspaceId);
    const turn = await send(`/sessions/${session.id}/turns`, {
      text: "archive every newsletter older than a week",
      context: { pinned: ["appearance.mode"] },
    });
    expect(turn.status).toBe(200);
    expect(turn.headers.get("content-type")).toContain("text/event-stream");
    const events = eventsOf(await turn.text());
    expect(events[0]).toMatchObject({
      kind: "user",
      text: "archive every newsletter older than a week",
    });
    expect(events.some((e) => e.kind === "text" && e.text === "Let me find them.")).toBe(true);
    const waiting = events.find((e) => e.kind === "tool" && e.call.status === "waiting");
    if (waiting?.kind !== "tool") throw new Error("no waiting card");
    expect(waiting.call).toMatchObject({
      tool: "archive_threads",
      tier: "reversible",
      inputSummary: "12 threads",
    });
    expect(waiting.preview).toMatchObject({ kind: "threads", action: "Archive", count: 12 });
    const listed = (waiting.preview as { threads: Array<{ id: string; subject: string }> }).threads;
    expect(listed).toHaveLength(12);
    // The preview carries the real subjects, decrypted, not the index prefix.
    expect(listed.map((t) => t.subject).sort()[0]).toBe("Weekly digest 1");
    expect(events.at(-1)).toEqual({
      kind: "done",
      id: expect.any(String),
      waiting: waiting.call.id,
    });
    // Nothing moved yet.
    expect(await listInbox("newsletters")).toEqual([...oldIds, ...freshIds].sort());
    expect(await store.latestSeq(workspaceId)).toBe(before);

    // The paused turn survives in Postgres: the checkpoint holds the Session's transcript.
    const checkpoints = await db.handle.sql<{ n: number }[]>`
      select count(*)::int as n from langgraph.checkpoints where thread_id = ${session.id}
    `;
    expect(checkpoints[0]?.n ?? 0).toBeGreaterThan(0);

    // Approve from the card: the archives apply through the Mailstore, so the Changes feed carries them.
    const approval = await send(`/sessions/${session.id}/approvals/${waiting.call.id}`, {
      decision: "approved",
      context: { pinned: ["appearance.mode"] },
    });
    expect(approval.status).toBe(200);
    const more = eventsOf(await approval.text());
    const applied = [...more]
      .reverse()
      .find((e) => e.kind === "tool" && e.call.tool === "archive_threads");
    expect(applied && applied.kind === "tool" ? applied.call : null).toMatchObject({
      status: "done",
      approvedBy: "user",
      undoable: true,
      result: "Archive: 12 threads.",
    });
    expect(
      more.some(
        (e) => e.kind === "text" && e.text === "Archived 12 newsletters older than a week.",
      ),
    ).toBe(true);
    expect(more.at(-1)).toMatchObject({ kind: "done", waiting: null });
    expect(await listInbox("newsletters")).toEqual([...freshIds].sort());
    const changes = await store.listChanges(workspaceId, { since: before, limit: 100 });
    expect(changes.changes.filter((c) => c.kind === "thread" && c.payload.archived)).toHaveLength(
      12,
    );
    // Every model call was metered under the composer Task.
    const meter = await intelligence.meter.month(workspaceId, "2026-09");
    expect(meter.lines).toEqual([
      expect.objectContaining({ task: "composer", provider: "anthropic", calls: 3 }),
    ]);

    // The Activity log shows the call with tier, preview, decision and result.
    const log = (await (await request(`/activity?workspace=${workspaceId}`)).json()) as {
      activity: ActivityRecord[];
    };
    const archive = log.activity.find((r) => r.tool === "archive_threads");
    expect(archive).toMatchObject({
      tier: "reversible",
      status: "done",
      decision: "approved",
      approvedBy: "user",
      undoable: true,
      sessionId: session.id,
      callId: "toolu_02",
      actor: "agent",
    });
    expect(archive?.preview).toMatchObject({ kind: "threads", count: 12 });
    expect(log.activity.find((r) => r.tool === "search_threads")).toMatchObject({
      tier: "read-only",
      decision: "auto",
    });
    expect(archive && "undo" in archive).toBe(false);

    // Undo from the card restores every one of the twelve, as the user, through the intent path.
    const undone = await send(`/activity/${archive?.id}/undo`, { session: session.id });
    expect(undone.status).toBe(200);
    expect((await undone.json()) as ActivityRecord).toMatchObject({
      tool: "undo",
      status: "done",
      result: "Undone: 12 of 12 threads restored.",
    });
    expect(await listInbox("newsletters")).toEqual([...oldIds, ...freshIds].sort());
    const after = await store.listChanges(workspaceId, { since: changes.cursor, limit: 100 });
    expect(after.changes.filter((c) => c.kind === "thread" && !c.payload.archived)).toHaveLength(
      12,
    );
    const again = (await (await request(`/activity?workspace=${workspaceId}`)).json()) as {
      activity: ActivityRecord[];
    };
    expect(again.activity.find((r) => r.id === archive?.id)).toMatchObject({
      undoable: false,
      undoneAt: NOW.toISOString(),
    });

    // The transcript replays with each card in its final state; the Session leads the history list.
    const loaded = (await (await request(`/sessions/${session.id}`)).json()) as {
      session: SessionSummary;
      events: AgentEvent[];
    };
    expect(loaded.session.title).toBe("archive every newsletter older than a week");
    // The user's turn carries when it was stored, for the composer's timestamp.
    expect(loaded.events.find((e) => e.kind === "user")).toMatchObject({
      at: expect.any(String),
    });
    const cards = loaded.events.filter((e) => e.kind === "tool");
    expect(cards.map((e) => (e.kind === "tool" ? [e.call.tool, e.call.status] : null))).toEqual([
      ["search_threads", "done"],
      ["archive_threads", "done"],
      ["undo", "done"],
    ]);
    const sessions = (await (await request(`/sessions?workspace=${workspaceId}`)).json()) as {
      sessions: SessionSummary[];
    };
    expect(sessions.sessions[0]?.id).toBe(session.id);
  });

  test("a send asks even for one message, and a declined approval sends nothing", async () => {
    const aoife = (await store.listThreads(workspaceId, { section: "needs-reply", limit: 10 }))
      .threads[0];
    if (!aoife) throw new Error("fixture thread missing");
    converse.script(
      {
        toolCalls: [
          {
            id: "toolu_10",
            name: "draft_message",
            args: { kind: "reply", thread_id: aoife.id, body: "Thursday works." },
          },
        ],
      },
      (call) => {
        const tool = [...call.messages].reverse().find((m) => m.role === "tool");
        const draftId = /Draft (\S+) saved/.exec(tool?.role === "tool" ? tool.content : "")?.[1];
        return { toolCalls: [{ id: "toolu_11", name: "send_draft", args: { draft_id: draftId } }] };
      },
      "Not sent; the draft is still there.",
    );
    const session = (await (
      await send("/sessions", { workspace: workspaceId })
    ).json()) as SessionSummary;
    const turn = eventsOf(
      await (
        await send(`/sessions/${session.id}/turns`, {
          text: "reply to aoife saying thursday works and send it",
        })
      ).text(),
    );
    const waiting = turn.find((e) => e.kind === "tool" && e.call.status === "waiting");
    if (waiting?.kind !== "tool") throw new Error("send did not ask");
    expect(waiting.call).toMatchObject({ tool: "send_draft", tier: "always-ask" });
    expect(waiting.preview).toMatchObject({
      kind: "send",
      to: [{ name: "Aoife", email: "aoife@example.test" }],
      subject: "Re: Take-home review",
      text: "Thursday works.",
    });
    const declined = eventsOf(
      await (
        await send(`/sessions/${session.id}/approvals/${waiting.call.id}`, { decision: "declined" })
      ).text(),
    );
    const card = [...declined]
      .reverse()
      .find((e) => e.kind === "tool" && e.call.tool === "send_draft");
    expect(card && card.kind === "tool" ? card.call : null).toMatchObject({
      status: "done",
      approvedBy: null,
      undoable: false,
    });
    expect(await intelligence.agent.listActivity(workspaceId)).toContainEqual(
      expect.objectContaining({ tool: "send_draft", decision: "declined" }),
    );
    const drafts = await store.listThreads(workspaceId, { limit: 1 });
    expect(drafts.threads.length).toBeGreaterThan(0);
    const sends = await db.handle.sql<
      { n: number }[]
    >`select count(*)::int as n from scheduled_sends`;
    expect(sends[0]?.n).toBe(0);
  });

  test("a settings change to a pinned key is refused with the reason; an unpinned one applies and undoes", async () => {
    converse.script(
      {
        toolCalls: [
          {
            id: "toolu_20",
            name: "change_setting",
            args: { key: "appearance.mode", value: "dark" },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "toolu_21",
            name: "change_setting",
            args: { key: "appearance.palette", value: "gruvbox" },
          },
        ],
      },
      "Mode is pinned in monday.toml; I switched the palette to gruvbox.",
    );
    const session = (await (
      await send("/sessions", { workspace: workspaceId })
    ).json()) as SessionSummary;
    const turn = eventsOf(
      await (
        await send(`/sessions/${session.id}/turns`, {
          text: "dark mode and gruvbox",
          context: { pinned: ["appearance.mode"] },
        })
      ).text(),
    );
    const cards = turn.filter((e) => e.kind === "tool");
    const mode = [...cards]
      .reverse()
      .find((e) => e.kind === "tool" && e.call.inputSummary.startsWith("appearance.mode"));
    expect(mode && mode.kind === "tool" ? mode.call : null).toMatchObject({
      status: "failed",
      result: expect.stringContaining("appearance.mode is set in monday.toml"),
    });
    const palette = [...cards]
      .reverse()
      .find((e) => e.kind === "tool" && e.call.inputSummary.startsWith("appearance.palette"));
    expect(palette && palette.kind === "tool" ? palette.call : null).toMatchObject({
      status: "done",
      undoable: true,
    });
    const stored = (await (await request("/settings")).json()) as {
      global: Record<string, unknown>;
    };
    expect(stored.global["appearance.palette"]).toBe("gruvbox");
    expect(stored.global["appearance.mode"]).toBeUndefined();
    await send(`/activity/${palette && palette.kind === "tool" ? palette.call.id : ""}/undo`, {});
    const reverted = (await (await request("/settings")).json()) as {
      global: Record<string, unknown>;
    };
    expect(reverted.global["appearance.palette"]).toBe("graphite");
  });

  test("the MCP listing and the guard rails on the routes", async () => {
    const tools = (await (await request(`/agent/tools?workspace=${workspaceId}`)).json()) as {
      tools: Array<{ name: string; _meta: { tier: string } }>;
    };
    expect(tools.tools.map((t) => t.name)).toContain("send_draft");
    expect(tools.tools.find((t) => t.name === "send_draft")?._meta.tier).toBe("leaves_mailbox");
    expect((await send("/sessions/nope/turns", { text: "hi" })).status).toBe(404);
    expect((await send("/sessions", {})).status).toBe(400);
    expect((await request("/sessions")).status).toBe(400);
    expect((await send("/activity/nope/undo", {})).status).toBe(404);
  });
});
