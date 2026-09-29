// Recommended actions II (docs/spec/actions.md; slice 35): Pay or file with
// the link-domain check (acceptance 1), Add to calendar from the event's parts
// (acceptance 2), Unsubscribe by RFC 8058 through the tool's approval, which a
// fake list server records (acceptance 3), learning that raises Archive's
// threshold and an Undo that restores it (acceptance 5), and a Thread with
// hidden instructions offering only RSVP and Unsubscribe (acceptance 6).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, SignalReading } from "@monday/shared";
import { defaultSettings, recommendationLabel, recommendationWords } from "@monday/shared";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { settings as settingsTable } from "../src/db/schema.ts";
import { learnThreshold } from "../src/intelligence/actions/learning.ts";
import {
  eventTitle,
  payLinkAllowed,
  type RecommendSettings,
  recommendFor,
} from "../src/intelligence/actions/recommend.ts";
import { ACTION_SIGNAL } from "../src/intelligence/actions/signals.ts";
import { listName, oneClick, unsubscribePlan } from "../src/intelligence/actions/unsubscribe.ts";
import { createIntelligence, type Intelligence } from "../src/intelligence/index.ts";
import { createFakeChat, createFakeJudge } from "../src/intelligence/runtime/fake/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { recommendationsRoutes } from "../src/routes/recommendations.ts";
import { readGlobalSettings } from "../src/settings/read.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const NOW = new Date("2026-09-29T12:00:00Z");
const owner = { name: "Sam Okafor", email: "sam@monday.test" };
const words = recommendationWords(defaultSettings());

const SETTINGS: RecommendSettings = {
  noulLow: 0.3,
  noulHigh: 0.7,
  confidenceBelow: 0.5,
  nonEnglish: "unsure",
  zone: "UTC",
  morningHour: 8,
  afternoonHour: 14,
  eveningHour: 18,
  weekStart: 1,
  beforeDeadlineHours: 24,
};

describe("the rules code owns", () => {
  test("a payment link only on the sender's domain or a trusted processor's", () => {
    expect(payLinkAllowed("pay.hetzner.com", "hetzner.com", [])).toBe(true);
    expect(payLinkAllowed("accounts.hetzner.com", "billing.hetzner.com", [])).toBe(true);
    expect(payLinkAllowed("pay.stripe.com", "hetzner.com", ["stripe.com"])).toBe(true);
    expect(payLinkAllowed("hetzner.com.evil.test", "hetzner.com", ["stripe.com"])).toBe(false);
    expect(payLinkAllowed("pay.example.co.uk", "billing.other.co.uk", [])).toBe(false);
  });
  test("the list's way out: one-click only when the list says so, else mailto, else the browser", () => {
    expect(
      unsubscribePlan({
        "list-unsubscribe": "<mailto:leave@list.test?subject=unsubscribe>, <https://list.test/u/1>",
        "list-unsubscribe-post": "List-Unsubscribe=One-Click",
      }),
    ).toEqual({ method: "one_click", target: "https://list.test/u/1" });
    expect(
      unsubscribePlan({
        "list-unsubscribe": "<mailto:leave@list.test?subject=unsubscribe>, <https://list.test/u/1>",
      }),
    ).toEqual({ method: "mailto", target: "leave@list.test", subject: "unsubscribe" });
    expect(unsubscribePlan({ "list-unsubscribe": "<https://list.test/u/1>" })).toEqual({
      method: "browser",
      target: "https://list.test/u/1",
    });
    expect(unsubscribePlan({ "list-unsubscribe": "<http://list.test/u/1>" })).toBeNull();
    expect(listName({ "list-id": "Weekly Rust <weekly.rust.test>" }, "x")).toBe("Weekly Rust");
    expect(eventTitle("Re: Fwd: Podcast recording")).toBe("Podcast recording");
  });
  test("the RFC 8058 request is a POST of the one-click form, never a GET", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const res = await oneClick("https://list.test/u/1", async (url, init) => {
      seen.push({ url, init });
      return new Response(null, { status: 202 });
    });
    expect(res.status).toBe(202);
    expect(seen[0]?.init.method).toBe("POST");
    expect(seen[0]?.init.body).toBe("List-Unsubscribe=One-Click");
    await expect(oneClick("http://list.test/u/1", async () => new Response())).rejects.toThrow();
  });
  test("learning: rarely used raises by a step up to the ceiling; much used lowers, never below the shipped default", () => {
    const settings = {
      enabled: true,
      window: 50,
      minUseRate: 0.1,
      highUseRate: 0.6,
      step: 0.05,
      maxThreshold: 0.95,
    };
    const outcomes = (used: number, n = 50) =>
      Array.from({ length: n }, (_, i): "used" | "dismissed" => (i < used ? "used" : "dismissed"));
    expect(
      learnThreshold({ outcomes: outcomes(0), current: 0.85, shipped: 0.85, settings }),
    ).toEqual({ next: 0.9, shown: 50, used: 0 });
    expect(
      learnThreshold({ outcomes: outcomes(0, 49), current: 0.85, shipped: 0.85, settings }),
    ).toBeNull();
    expect(
      learnThreshold({ outcomes: outcomes(0), current: 0.95, shipped: 0.85, settings }),
    ).toBeNull();
    expect(
      learnThreshold({ outcomes: outcomes(40), current: 0.9, shipped: 0.85, settings })?.next,
    ).toBe(0.85);
    expect(
      learnThreshold({ outcomes: outcomes(40), current: 0.85, shipped: 0.85, settings }),
    ).toBeNull();
    expect(
      learnThreshold({
        outcomes: outcomes(0),
        current: 0.85,
        shipped: 0.85,
        settings: { ...settings, enabled: false },
      }),
    ).toBeNull();
  });
});

describe("which of the slice 35 actions a Thread allows", () => {
  const current = (noul: number): SignalReading => ({ noul, stale: false, version: 1 });
  const choice = (c: string, confidence = 0.9): SignalReading => ({
    choice: c,
    confidence,
    stale: false,
    version: 1,
  });
  const base = {
    now: NOW,
    facts: { last_activity_at: "2026-09-29T09:00:00.000Z", deadline_at: null },
    picks: undefined,
    people: [],
    settings: SETTINGS,
  };
  test("RSVP on an unanswered Invite, with its clash; Unsubscribe after the unread streak", () => {
    const recs = recommendFor({
      ...base,
      answers: { newsletter: current(0.9) },
      context: {
        invite: {
          id: "inv1",
          title: "Design review",
          start: "2026-10-01T10:00:00.000Z",
          answered: false,
          clash: "Planning",
        },
        unsubscribe: {
          listId: "<weekly.list.test>",
          listName: "Weekly",
          method: "one_click",
          target: "https://list.test/u/1",
          issues: 23,
          streak: true,
        },
      },
    });
    expect(recs.map((r) => r.kind)).toEqual(["rsvp", "unsubscribe"]);
    expect(recs[0]).toMatchObject({ clash: "Planning" });
    expect(recommendationLabel(recs[0] as never, words, NOW)).toBe("Accept · Maybe · Decline");
  });
  test("a Thread with hidden instructions offers only RSVP and Unsubscribe (acceptance 6)", () => {
    const recs = recommendFor({
      ...base,
      answers: {
        needs_reply: current(0.95),
        [ACTION_SIGNAL.archiveFits]: current(0.95),
        hidden_instructions: current(0.97),
        newsletter: current(0.9),
      },
      context: {
        invite: {
          id: "inv1",
          title: "Sync",
          start: "2026-10-01T10:00:00.000Z",
          answered: false,
          clash: null,
        },
        unsubscribe: {
          listId: "l",
          listName: "L",
          method: "mailto",
          target: "leave@list.test",
          issues: 3,
          streak: true,
        },
      },
    });
    expect(recs.map((r) => r.kind).sort()).toEqual(["rsvp", "unsubscribe"]);
  });
  test("Track a package on its carrier's page; Run a Workflow by the pick's probability", () => {
    const recs = recommendFor({
      ...base,
      answers: {
        [ACTION_SIGNAL.trackFits]: current(0.9),
        [ACTION_SIGNAL.trackNumber]: choice("picked"),
        [ACTION_SIGNAL.workflowPick]: choice("picked", 0.7),
      },
      picks: {
        [ACTION_SIGNAL.trackNumber]: { value: "1Z999AA10123456784", confidence: 0.9 },
        [ACTION_SIGNAL.workflowPick]: { value: "wf1", confidence: 0.7, probability: 0.85 },
      },
      context: {
        carrierUrls: { ups: "https://www.ups.com/track?tracknum={number}" },
        trackingCarrier: () => "ups",
        workflows: [{ id: "wf1", name: "Candidate intake" }],
      },
    });
    expect(recs.find((r) => r.kind === "track")).toMatchObject({
      url: "https://www.ups.com/track?tracknum=1Z999AA10123456784",
      carrier: "ups",
    });
    expect(recs.find((r) => r.kind === "workflow")).toMatchObject({
      fit: 0.85,
      confidence: 0.7,
      name: "Candidate intake",
    });
  });
});

describe("slice 35 over the Store", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let workspaceId: string;
  const judge = createFakeJudge();
  let intelligence: Intelligence;
  const posted: Array<{ url: string; method: string | undefined; body: unknown }> = [];

  const subjectOf = (state: unknown) =>
    (state as { thread?: { subject?: string } }).thread?.subject ?? "";
  let seq = 0;
  const addThread = async (
    subject: string,
    from: { name: string; email: string },
    text: string,
    headers: Record<string, string> = {},
    unread = true,
  ) => {
    seq += 1;
    const threadId = await store.upsertThread({
      workspaceId,
      providerThreadId: `t-${seq}`,
      subject,
      participants: [from, owner],
      lastActivity: new Date(Date.parse("2026-09-29T09:00:00.000Z") - seq * 60_000).toISOString(),
      unread,
    });
    await store.upsertMessage({
      threadId,
      providerMessageId: `m-${seq}`,
      from,
      to: [owner],
      cc: [],
      date: "2026-09-29T09:00:00.000Z",
      headers,
      bodyText: text,
      bodyHtml: null,
      snippet: text.slice(0, 60),
    });
    return threadId;
  };
  const labelOf = (
    recs: Awaited<ReturnType<Intelligence["recommendations"]["get"]>>,
    kind: string,
  ) => {
    const r = recs?.actions.find((a) => a.kind === kind);
    return r ? recommendationLabel(r, words, NOW, "UTC") : null;
  };

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    const account: Account = {
      id: "acct-recs-ii",
      provider: "jmap",
      address: owner.email,
      displayName: owner.name,
      capabilities: {
        push: true,
        labels: false,
        snooze: false,
        mute: false,
        calendar: false,
        meetingLink: null,
      },
    };
    workspaceId = (await store.createWorkspace(account)).id;
    const invoice = {
      money_involved: 0.96,
      money_amount: "$1,315.50",
      money_direction: "owner_pays",
      has_deadline: 0.93,
      deadline_form: "absolute",
      deadline_month: "october",
      deadline_day: "3",
      deadline_year: "none",
      deadline_hour: "none",
      needs_reply: 0.05,
      [ACTION_SIGNAL.payFits]: 0.92,
    };
    judge.when((state) => subjectOf(state) === "Invoice INV-2291 for September", {
      ...invoice,
      [ACTION_SIGNAL.payLink]: "l1",
    });
    judge.when((state) => subjectOf(state) === "Invoice INV-2292 for October", {
      ...invoice,
      [ACTION_SIGNAL.payLink]: "l1",
    });
    judge.when((state) => subjectOf(state) === "Podcast recording", {
      needs_reply: 0.4,
      [ACTION_SIGNAL.calendarFits]: 0.9,
      "action:calendar.form": "relative",
      "action:calendar.anchor": "weekday",
      "action:calendar.weekday": "thursday",
      "action:calendar.week": "this",
      "action:calendar.hour": "15",
      [ACTION_SIGNAL.calendarMinute]: "00",
    });
    judge.when((state) => subjectOf(state).startsWith("Weekly Rust"), {
      newsletter: 0.95,
      needs_reply: 0.02,
    });
    judge.when((state) => subjectOf(state) === "Receipt", {
      needs_reply: 0.02,
      waiting_on_me: 0.02,
      has_deadline: 0.02,
      [ACTION_SIGNAL.archiveFits]: 0.95,
    });
    intelligence = createIntelligence({
      level: async () => "automate",
      db: db.handle.db,
      mailstore: store,
      chat: createFakeChat("{}").chat,
      judge: judge.judge,
      keys: async (provider) => (provider === "typesafe" ? "ts-key" : null),
      now: () => NOW,
      fetch: async (url, init) => {
        posted.push({ url, method: init.method, body: init.body });
        return new Response(null, { status: 200 });
      },
    });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  test("the Hetzner invoice: Pay $1,315.50 by Oct 3 with Remind me; a link off Hetzner's domain is never offered (acceptance 1)", async () => {
    const hetzner = { name: "Hetzner Billing", email: "billing@hetzner.com" };
    const good = await addThread(
      "Invoice INV-2291 for September",
      hetzner,
      "Dear customer, your invoice INV-2291 over $1,315.50 is due on 3 October. Pay at https://pay.hetzner.com/i/2291 today.",
    );
    await intelligence.signals.ask(workspaceId, good, { reason: "arrival" });
    const recs = await intelligence.recommendations.get(good);
    expect(labelOf(recs, "pay")).toBe("Pay $1,315.50 by Oct 3");
    expect(recs?.actions.find((a) => a.kind === "pay")).toMatchObject({
      link: { url: "https://pay.hetzner.com/i/2291", domain: "pay.hetzner.com" },
      due: "2026-10-03T23:59:00.000Z",
      remindAt: "2026-10-01T23:59:00.000Z",
    });
    expect(words.remindPay).toBe("Remind me to pay");
    // The judge picks a link on another domain: no link, the chip is Remind me to pay.
    const bad = await addThread(
      "Invoice INV-2292 for October",
      hetzner,
      "Your invoice INV-2292 over $1,315.50 is due on 3 October. Pay at https://hetzner-pay.evil.test/i/2292 now.",
    );
    await intelligence.signals.ask(workspaceId, bad, { reason: "arrival" });
    const refused = await intelligence.recommendations.get(bad);
    expect(refused?.actions.find((a) => a.kind === "pay")).toMatchObject({ link: null });
    expect(labelOf(refused, "pay")).toBe("Remind me to pay");
  });

  test("a meeting proposal on Thursday at 3pm: Add Thu 15:00 to calendar, no invitees (acceptance 2)", async () => {
    const thread = await addThread(
      "Podcast recording",
      { name: "Sofia Marques", email: "sofia@podcast.test" },
      "Would Thursday at 3pm work for the recording? It takes about half an hour.",
    );
    await intelligence.signals.ask(workspaceId, thread, { reason: "arrival" });
    const recs = await intelligence.recommendations.get(thread);
    const cal = recs?.actions.find((a) => a.kind === "calendar");
    expect(cal).toMatchObject({
      day: "2026-10-01",
      start: "2026-10-01T15:00:00.000Z",
      end: "2026-10-01T15:30:00.000Z",
      title: "Podcast recording",
    });
    expect(labelOf(recs, "calendar")).toBe("Add Thu 15:00 to calendar");
  });

  test("a newsletter left unread five issues running: Unsubscribe by RFC 8058, which the fake list server records (acceptance 3)", async () => {
    const list = { name: "Weekly Rust", email: "news@rust.test" };
    const headers = {
      "list-id": "Weekly Rust <weekly.rust.test>",
      "list-unsubscribe": "<mailto:leave@rust.test>, <https://rust.test/u/abc>",
      "list-unsubscribe-post": "List-Unsubscribe=One-Click",
      precedence: "list",
    };
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await addThread(`Weekly Rust #${40 + i}`, list, "This week in Rust: ...", headers));
    }
    for (const id of ids) await intelligence.signals.ask(workspaceId, id, { reason: "arrival" });
    const newest = ids[0] as string;
    const recs = await intelligence.recommendations.refresh(workspaceId, newest);
    expect(recs?.actions.find((a) => a.kind === "unsubscribe")).toMatchObject({
      method: "one_click",
      target: "https://rust.test/u/abc",
      listName: "Weekly Rust",
      issues: 5,
    });
    const routes = recommendationsRoutes(intelligence);
    const exit = await routes.request(`/threads/${newest}/unsubscribe?workspace=${workspaceId}`);
    expect(await exit.json()).toMatchObject({
      method: "one_click",
      target: "https://rust.test/u/abc",
    });
    // A request that is not what the card showed is declined inside the tool: nothing is sent.
    const wrong = await routes.request(`/threads/${newest}/unsubscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace: workspaceId,
        method: "one_click",
        target: "https://rust.test/u/other",
      }),
    });
    expect(wrong.status).toBe(409);
    expect(posted).toEqual([]);
    const approved = await routes.request(`/threads/${newest}/unsubscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace: workspaceId,
        method: "one_click",
        target: "https://rust.test/u/abc",
      }),
    });
    expect(approved.status).toBe(200);
    expect(posted).toEqual([
      { url: "https://rust.test/u/abc", method: "POST", body: "List-Unsubscribe=One-Click" },
    ]);
    const rows = await intelligence.activity.list(workspaceId, { limit: 5 });
    expect(rows.find((r) => r.tool === "unsubscribe" && r.status === "done")).toBeDefined();
    // One issue read breaks the streak: no Unsubscribe.
    await db.handle.sql`update threads set unread = false where id = ${ids[2] as string}`;
    const after = await intelligence.recommendations.refresh(workspaceId, newest);
    expect(after?.actions.find((a) => a.kind === "unsubscribe")).toBeUndefined();
  });

  test("dismissing Archive on 45 of 50 Threads raises its threshold to 0.9; the Activity log shows it and Undo restores 0.85 (acceptance 5)", async () => {
    const receipt = await addThread(
      "Receipt",
      { name: "Shop", email: "orders@shop.test" },
      "Thanks for your order. Nothing more to do.",
    );
    await intelligence.signals.ask(workspaceId, receipt, { reason: "arrival" });
    expect((await intelligence.recommendations.get(receipt))?.actions.map((a) => a.kind)).toContain(
      "archive",
    );
    let learned: Awaited<ReturnType<Intelligence["recommendations"]["record"]>>["learned"] = null;
    for (let i = 0; i < 50; i++) {
      const result = await intelligence.recommendations.record({
        workspace: workspaceId,
        threadId: receipt,
        shown: [{ kind: "archive", fit: 0.95 }],
        outcome: { kind: "archive", outcome: i < 45 ? "dismissed" : "ignored" },
      });
      if (result.learned) learned = result.learned;
    }
    expect(learned).toMatchObject({
      action: "archive",
      from: 0.85,
      to: 0.9,
      text: "Archive suggestions: shown 50 times, used 0; now shown only when 90% sure",
    });
    const read = async () =>
      (await readGlobalSettings(db.handle.db, ["actions.recommended.archive.threshold"]))[
        "actions.recommended.archive.threshold"
      ];
    expect(await read()).toBe(0.9);
    const row = await intelligence.activity.get(learned?.activityId ?? "");
    expect(row?.inputSummary).toContain("now shown only when 90% sure");
    expect(row?.undo).toEqual({
      kind: "settings",
      entries: [{ key: "actions.recommended.archive.threshold", previous: 0.85 }],
    });
    const stats = await intelligence.recommendations.stats(workspaceId);
    expect(stats.find((s) => s.action === "archive")).toMatchObject({
      threshold: 0.9,
      shipped: 0.85,
    });
    await intelligence.agent.undo(learned?.activityId ?? "");
    expect(await read()).toBe(0.85);
    // "Not this" took Archive off this Thread version.
    expect(
      (await intelligence.recommendations.get(receipt))?.actions.map((a) => a.kind),
    ).not.toContain("archive");
    await db.handle.db
      .delete(settingsTable)
      .where(
        (await import("drizzle-orm")).eq(
          settingsTable.key,
          "actions.recommended.archive.threshold",
        ),
      );
  });
});
