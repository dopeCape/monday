/// <reference types="bun-types" />
// Slice 26's "done when", end to end through the interfaces: "put newsletters
// in a folder called Reading and give invoice threads a forward-to-accounting
// button" runs on the Agent host with the fake converse scripted to call
// create_section (placement nav) and create_action (tool forward_thread on
// the Finance Group) from one turn. Both cards apply as reversible actions,
// the Settings they wrote reach the client, the nav model lists Reading with
// a count, the stream keeps the newsletter out of the other Sections, the
// reader for an invoice Thread shows "Forward to accounting" which asks
// before it forwards (a card with the recipients, no send), and Undo of
// each card removes what it made.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type {
  Account,
  AgentEvent,
  CustomActionSetting,
  SectionRuleSetting,
  SessionSummary,
  Thread,
} from "@monday/shared";
import { customActionsFor, defaultSettings } from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createApp } from "../../../../server/src/app.ts";
import { createAuth } from "../../../../server/src/auth/index.ts";
import { randomKey } from "../../../../server/src/crypto/aead.ts";
import { createKeys, type Keys } from "../../../../server/src/crypto/keys.ts";
import { scheduledSends } from "../../../../server/src/db/schema.ts";
import {
  createIntelligence,
  type Intelligence,
} from "../../../../server/src/intelligence/index.ts";
import {
  createFakeChat,
  createFakeConverse,
  createFakeJudge,
  fakeKeys,
} from "../../../../server/src/intelligence/runtime/fake/index.ts";
import { createJobs, type Jobs } from "../../../../server/src/jobs/index.ts";
import { createMailstore, type Mailstore } from "../../../../server/src/mailstore/index.ts";
import { createCredentialStore } from "../../../../server/src/providers/credentials.ts";
import {
  createFakeProvider,
  type FakeProvider,
  fakeCredentials,
  generateFixture,
} from "../../../../server/src/providers/fake/index.ts";
import { createProviderRegistry } from "../../../../server/src/providers/index.ts";
import {
  createSyncEngine,
  defaultSyncSettings,
  type SyncEngine,
} from "../../../../server/src/providers/sync.ts";
import { readGlobalSettings } from "../../../../server/src/settings/read.ts";
import { type TestDatabase, testDatabase } from "../../../../server/test/harness.ts";
import { ApiError, type MessageHeaderResponse } from "../../platform/api.ts";
import { navModel } from "../../shell/nav.ts";
import { bunDriver } from "../../store/bun-driver.ts";
import { createStore, type Store } from "../../store/store.ts";
import type { ContentTransport, StoreTransport } from "../../store/transport.ts";
import { customActionTier, renderActionArgs } from "./custom-actions.ts";
import { Reader } from "./Reader.tsx";
import { createStoreInbox, type StoreInbox } from "./store-inbox.ts";

const TOKEN = "per-launch-token";
const fixture = generateFixture();
const NOW = new Date(fixture.recordedAt);
const owner = fixture.owner;

const account: Account = {
  id: "acct-organize",
  provider: "imap",
  address: fixture.address,
  displayName: owner.name,
  capabilities: {
    push: false,
    labels: false,
    snooze: false,
    mute: false,
    calendar: false,
    meetingLink: null,
  },
};

const SENTENCE =
  "put newsletters in a folder called Reading and give invoice threads a forward-to-accounting button";

/** The Store's and the reader's transports over the Server's fetch handler, as the app wires them. */
function transports(app: ReturnType<typeof createApp>): {
  transport: StoreTransport;
  content: ContentTransport;
} {
  const request = async (path: string, init: RequestInit = {}) => {
    const res = await app.request(path, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    });
    if (!res.ok) throw new ApiError(res.status, await res.text());
    return res;
  };
  const get = async <T,>(path: string) => (await (await request(path)).json()) as T;
  const unused = () => Promise.reject(new Error("not used by this test"));
  return {
    transport: {
      changes: (ws, since, limit) =>
        get(
          `/changes?${new URLSearchParams({ workspace: ws, since: String(since), limit: String(limit) })}`,
        ),
      intent: unused,
      draftIntent: unused,
      inviteIntent: unused,
      brief: async () => null,
      connect: () => ({ close() {} }),
    },
    content: {
      messages: async (threadId) =>
        (await get<{ messages: MessageHeaderResponse[] }>(`/threads/${threadId}/messages`))
          .messages,
      body: (messageId) => get(`/messages/${messageId}/body`),
      draft: unused,
      attachment: unused,
      uploadBlob: unused,
      requestBrief: unused,
      sectionJudgments: async (ws, threads) =>
        (
          await (
            await request("/sections/judgments", {
              method: "POST",
              body: JSON.stringify({ workspace: ws, threads }),
            })
          ).json()
        ).judgments,
    },
  };
}

describe("organizing mail by talking, end to end", () => {
  let db: TestDatabase;
  let keys: Keys;
  let mailstore: Mailstore;
  let fake: FakeProvider;
  let engine: SyncEngine;
  let jobs: Jobs;
  let intelligence: Intelligence;
  let app: ReturnType<typeof createApp>;
  let store: Store;
  let inbox: StoreInbox;
  let session: SessionSummary;
  let workspaceId = "";
  let financeId = "";
  let invoiceId = "";
  let newsletterId = "";
  const clock = NOW;
  const converse = createFakeConverse();
  const chat = createFakeChat('{"scores": {}}');
  const judge = createFakeJudge();
  let createRoot: Awaited<ReturnType<typeof dom>>["createRoot"];
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    });
  const send = (path: string, body: unknown, method = "POST") =>
    request(path, { method, body: JSON.stringify(body) });
  /** One user turn on the Agent host, as POST /sessions/:id/turns runs it (the SSE wrapper needs a real stream, which happy-dom's globals lack). */
  const turn = async (text: string): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    await intelligence.agent.turn(session.id, text, {}, (e) => events.push(e));
    return events;
  };
  const cards = (events: AgentEvent[], tool: string) =>
    events.filter((e) => e.kind === "tool" && e.call.tool === tool);
  const settingsNow = () =>
    readGlobalSettings(db.handle.db, ["sections.rules", "sections.order", "actions.custom"]);
  const syncAll = async () => {
    for (let i = 0; i < 50; i++) {
      const report = await engine.syncAccount(account.id);
      if (!report.more) return;
    }
    throw new Error("sync did not finish");
  };
  /** The nav as the App builds it, from the Store's rows and the Settings the Server holds. */
  const nav = async () => {
    const s = await settingsNow();
    return navModel({
      address: fixture.address,
      status: "online",
      threads: inbox.threads(),
      groups: inbox.groups(),
      sections: s["sections.rules"],
      sectionOrder: s["sections.order"],
      strings: defaultSettings(),
    });
  };
  /** Re-sections the Store's rows under the Settings the Server holds now. */
  const resection = async () => {
    const s = await settingsNow();
    current.rules = s["sections.rules"];
    current.order = s["sections.order"];
    current.actions = s["actions.custom"];
    inbox.resection();
    // The judged pass, if any, lands on the next tick.
    await new Promise<void>((r) => setTimeout(r, 30));
  };
  const current: {
    rules: readonly SectionRuleSetting[];
    order: readonly string[];
    actions: readonly CustomActionSetting[];
  } = { rules: [], order: [], actions: [] };

  beforeAll(async () => {
    ({ createRoot } = await dom());
    db = await testDatabase();
    keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    mailstore = createMailstore(db.handle.db, keys);
    const credentials = createCredentialStore(db.handle.db, mailstore);
    fake = createFakeProvider(fixture, { threads: true });
    workspaceId = (await mailstore.createWorkspace(account)).id;
    await credentials.store(workspaceId, account.id, fakeCredentials());
    jobs = createJobs(db.handle.db, { now: () => clock });
    engine = createSyncEngine({
      db: db.handle.db,
      mailstore,
      providers: createProviderRegistry({ overrides: { imap: fake } }),
      credentials,
      settings: async () => ({ ...defaultSyncSettings(), bodyWindowDays: 365 }),
      now: () => clock,
    });
    intelligence = createIntelligence({
      level: async () => "automate",
      db: db.handle.db,
      mailstore,
      chat: chat.chat,
      converse: converse.converse,
      judge: judge.judge,
      keys: fakeKeys({ anthropic: "sk-ant-fake", typesafe: "ts-fake" }),
      now: () => clock,
    });
    intelligence.registerSteps(jobs);
    app = createApp({
      db: db.handle.db,
      auth: createAuth({ db: db.handle.db, sidecarToken: TOKEN }),
      mode: "sidecar",
      keys,
      mailstore,
      jobs,
      sync: engine,
      intelligence,
      remoteAddress: () => "127.0.0.1",
    });

    const hourAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
    const base = {
      mailbox: "inbox" as const,
      to: [owner],
      cc: [],
      inReplyTo: null,
      references: [],
      seen: false,
      flagged: false,
      answered: false,
      html: null,
      attachments: [],
    };
    fake.deliver({
      ...base,
      threadKey: "organize-invoice",
      from: { name: "Hetzner", email: "billing@hetzner.test" },
      subject: "Invoice 2026-09 for project monday-sync",
      date: hourAgo(2),
      messageId: "invoice-1@organize.test",
      headers: {},
      text: "Your invoice for September is attached. Amount due: 48.00 EUR by 2026-09-30.",
    });
    fake.deliver({
      ...base,
      threadKey: "organize-news",
      from: { name: "Bytes", email: "digest@bytes.test" },
      subject: "Bytes #312: the state of sync engines",
      date: hourAgo(1),
      messageId: "news-1@organize.test",
      headers: {
        "list-id": "<digest.bytes.test>",
        "list-unsubscribe": "<https://bytes.test/unsubscribe>",
        precedence: "bulk",
      },
      text: "Three articles on sync engines this week.",
    });
    await syncAll();
    invoiceId = (await mailstore.findThread(workspaceId, "organize-invoice"))?.id ?? "";
    newsletterId = (await mailstore.findThread(workspaceId, "organize-news"))?.id ?? "";
    expect(invoiceId).not.toBe("");
    expect(newsletterId).not.toBe("");

    // A Finance Group the user already has, with the invoice Thread in it.
    const finance = await intelligence.routing.createGroup(workspaceId, {
      name: "Finance",
      sentence: "Invoices, receipts and payment notices.",
      predicate: { domains: ["hetzner.test"] },
    });
    financeId = finance.id;
    await mailstore.applyIntent({
      kind: "move",
      threadId: invoiceId,
      group: financeId,
      subgroup: null,
      actor: "user",
      at: clock.toISOString(),
    });

    const { transport, content } = transports(app);
    store = await createStore({ workspaceId, driver: bunDriver(), transport, now: () => clock });
    await store.sync();
    const s = await settingsNow();
    current.rules = s["sections.rules"];
    current.order = s["sections.order"];
    current.actions = s["actions.custom"];
    inbox = await createStoreInbox(store, {
      content,
      sections: {
        rules: () => current.rules,
        order: () => current.order,
        owner: fixture.address,
        groupNames: () => Object.fromEntries((inbox?.groups() ?? []).map((g) => [g.id, g.name])),
        actions: () => current.actions,
        judgeThreshold: () => 0.7,
      },
    });
    session = (await (
      await send("/sessions", { workspace: workspaceId })
    ).json()) as SessionSummary;
  }, 120_000);

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
  });

  afterAll(async () => {
    inbox?.close();
    await store?.close();
    await engine?.close();
    await db?.drop();
  });

  let sectionCardId = "";
  let actionCardId = "";

  test("one turn creates the Reading section (nav) and the forward-to-accounting action; both cards apply", async () => {
    converse.script((call) => {
      // The system prompt's paragraph on organizing mail by talking reached the model.
      expect(call.system).toContain("organizes mail by talking");
      expect(call.tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(["create_section", "create_action", "create_group"]),
      );
      return {
        text: "Setting both up.",
        toolCalls: [
          {
            id: "c-section",
            name: "create_section",
            args: {
              name: "Reading",
              sentence: "newsletters, to read later",
              when: { bulk: true },
              placement: "nav",
              position: "top",
            },
          },
          {
            id: "c-action",
            name: "create_action",
            args: {
              label: "Forward to accounting",
              on: { group: "Finance" },
              tool: "forward_thread",
              args: { to: "accounting@monday.test", note: "Invoice: {{thread.subject}}" },
            },
          },
        ],
      };
    }, "Done: Reading is in your nav and invoice threads have a Forward to accounting button.");
    const events = await turn(SENTENCE);
    const section = cards(events, "create_section").at(-1);
    const action = cards(events, "create_action").at(-1);
    expect(section?.kind === "tool" && section.call.status).toBe("done");
    expect(action?.kind === "tool" && action.call.status).toBe("done");
    if (section?.kind !== "tool" || action?.kind !== "tool") throw new Error("no cards");
    sectionCardId = section.call.id;
    actionCardId = action.call.id;
    // Reversible: the cards applied without asking and carry Undo.
    expect(section.call.tier).toBe("reversible");
    expect(section.call.undoable).toBe(true);
    expect(action.call.undoable).toBe(true);
    // The card names what will exist and how many Threads it holds.
    const preview = section.preview?.kind === "text" ? section.preview.text : "";
    expect(preview).toContain('Create section "Reading" in the nav');
    expect(preview).toContain("list mail");
    expect(preview).toMatch(/\d+ threads? of the newest \d+ would be in it/);
    const actionPreview = action.preview?.kind === "text" ? action.preview.text : "";
    expect(actionPreview).toContain('Add button "Forward to accounting" on threads in Finance');
    expect(actionPreview).toContain("forward_thread");
    expect(actionPreview).toContain("asks first");

    const s = await settingsNow();
    const reading = s["sections.rules"].find((r) => r.id === "reading");
    expect(reading).toMatchObject({
      name: "Reading",
      placement: "nav",
      createdBy: "agent",
      when: { bulk: true },
    });
    expect(s["sections.order"][0]).toBe("reading");
    expect(s["actions.custom"]).toEqual([
      expect.objectContaining({
        id: "forward-to-accounting",
        label: "Forward to accounting",
        on: { group: "Finance" },
        tool: "forward_thread",
        createdBy: "agent",
      }),
    ]);
  });

  test("the nav model lists Reading with a count, and the stream keeps the newsletter out of the other Sections", async () => {
    await resection();
    const model = await nav();
    expect(model.sections).toEqual([{ key: "section:reading", label: "Reading" }]);
    // The delivered newsletter and the fixture's own digest: both unread list mail.
    expect(model.counts["section:reading"]).toBeGreaterThanOrEqual(1);
    expect(model.rail.map((r) => r.key)).toContain("section:reading");
    const newsletter = inbox.thread(newsletterId);
    expect(newsletter?.section).toBe("reading");
    // No other Section claims it: the shipped newsletters rule comes after Reading in the order.
    expect(inbox.threads().filter((t) => t.section === "newsletters")).toHaveLength(0);
  });

  test("the reader for the invoice Thread shows Forward to accounting, which asks before it forwards", async () => {
    const thread = inbox.thread(invoiceId) as Thread;
    expect(thread.group).toBe(financeId);
    const actions = customActionsFor(current.actions, thread, {
      groupNames: Object.fromEntries(inbox.groups().map((g) => [g.id, g.name])),
    });
    expect(actions.map((a) => a.label)).toEqual(["Forward to accounting"]);
    const newsletter = inbox.thread(newsletterId) as Thread;
    expect(customActionsFor(current.actions, newsletter, {})).toEqual([]);

    // The toolbar and the chip row carry it with the always-ask affordance.
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const r = root;
    const clicked: string[] = [];
    await act(async () =>
      r.render(
        <Reader
          thread={thread}
          messages={[]}
          brief={undefined}
          tags={[]}
          sheet={false}
          now={NOW}
          strings={{
            close: "Close",
            archive: "Archive",
            snooze: "Snooze",
            move: "Move",
            delete: "Delete",
            ask: "Ask",
            more: "More",
            star: "Star",
            unstar: "Unstar",
            unread: "Unread",
            read: "Read",
            message: "1 message",
            messages: "{n} messages",
            briefSource: "",
            briefUpdating: "",
            replyTo: "Reply to {name}",
            send: "Send",
            draftReply: "Draft",
            attach: "Attach",
            replyAll: "Reply all",
            forward: "Forward",
            asksFirst: "asks first",
          }}
          keys={{ archive: "E", snooze: "H", delete: "#", close: "Esc" }}
          onClose={() => {}}
          onAsk={() => {}}
          onArchive={() => {}}
          onSnooze={() => {}}
          onMove={() => {}}
          onDelete={() => {}}
          onStar={() => {}}
          onToggleRead={() => {}}
          actions={actions.map((a) => ({
            id: a.id,
            label: a.label,
            tier: customActionTier(a),
          }))}
          onAction={(id) => clicked.push(id)}
        />,
      ),
    );
    const button = host.querySelector<HTMLButtonElement>(
      '.col-head [data-action="forward-to-accounting"]',
    );
    expect(button?.textContent).toBe(" Forward to accounting");
    expect(button?.dataset.tier).toBe("always-ask");
    const chip = host.querySelector<HTMLButtonElement>(
      '.brief-actions .custom-action[data-action="forward-to-accounting"]',
    );
    expect(chip?.textContent).toBe("Forward to accounting");
    await act(async () => button?.click());
    expect(clicked).toEqual(["forward-to-accounting"]);

    // Run through the Server host, as the composer would: the tool asks with
    // the recipients and text (a card), and declining leaves nothing scheduled.
    const action = actions[0] as CustomActionSetting;
    const args = renderActionArgs(action, thread);
    // The Cache holds the headers-only subject prefix (lowercased); the template renders it.
    expect(String(args.note).toLowerCase()).toBe(
      "invoice: invoice 2026-09 for project monday-sync",
    );
    const asked: unknown[] = [];
    const outcome = await intelligence.agent.tools(workspaceId).call(
      {
        name: action.tool,
        args: { ...args, thread_id: thread.id },
        callId: "c-fwd",
        sessionId: null,
      },
      {
        ask: async (_row, preview) => {
          asked.push(preview);
          return "declined";
        },
      },
    );
    expect(outcome.text).toContain("Declined by the user; nothing changed");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      kind: "send",
      to: [{ email: "accounting@monday.test" }],
      subject: "Fwd: Invoice 2026-09 for project monday-sync",
    });
    expect(outcome.activity.tier).toBe("always-ask");
    expect(outcome.activity.decision).toBe("declined");
    expect(await db.handle.db.select().from(scheduledSends)).toHaveLength(0);
  });

  test("Undo of each card removes what it made", async () => {
    const undoAction = await send(`/activity/${actionCardId}/undo`, { session: session.id });
    expect(undoAction.status).toBe(200);
    expect(((await undoAction.json()) as { result?: string }).result).toContain("Undone");
    const undoSection = await send(`/activity/${sectionCardId}/undo`, { session: session.id });
    expect(undoSection.status).toBe(200);
    const s = await settingsNow();
    expect(s["actions.custom"]).toEqual([]);
    expect(s["sections.rules"].map((r) => r.id)).toEqual([
      "needs-reply",
      "waiting",
      "newsletters",
      "fyi",
    ]);
    expect(s["sections.order"]).toEqual(["needs-reply", "waiting", "fyi", "newsletters"]);
    await resection();
    const model = await nav();
    expect(model.sections).toEqual([]);
    expect(inbox.thread(newsletterId)?.section).toBe("newsletters");
    expect(customActionsFor(current.actions, inbox.thread(invoiceId) as Thread, {})).toEqual([]);
  });
});
