// The brief policy (slice 13) through its seam: the shipped rule over
// Thread facts, the gates a trigger passes, mode "model" over the fake chat,
// and over Postgres the Job's decisions the end-to-end test does not reach:
// a per-Group override of never removes a Brief and tells the feed, the
// model's word is metered as a classify call, and an ask with no key queues
// nothing.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, BriefPolicy, HostedProvider } from "@monday/shared";
import { defaultSettings } from "@monday/shared";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys, type Keys } from "../src/crypto/keys.ts";
import { settings as settingsTable } from "../src/db/schema.ts";
import { BRIEF_STEP, briefJobId } from "../src/intelligence/brief.ts";
import { createIntelligence, type Intelligence } from "../src/intelligence/index.ts";
import {
  type BriefPolicySettings,
  type BriefThreadFacts,
  createBriefPolicyRule,
  isAutomated,
  isNewsletter,
  parsePolicyOutput,
  policyPrompt,
  rulePolicy,
  shouldCompute,
  wordCount,
} from "../src/intelligence/policy.ts";
import { createFakeChat, createFakeRuntime } from "../src/intelligence/runtime/fake/index.ts";
import { createJobs, type Jobs } from "../src/jobs/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const SIDECAR_TOKEN = "per-launch-token";
const me = "sam@monday.test";
const aoife = { name: "Aoife Byrne", email: "aoife@northwind.test" };
const sam = { name: "Sam Rivera", email: me };

/** The shipped Settings as the policy reads them. */
function policySettings(overrides: Partial<BriefPolicySettings> = {}): BriefPolicySettings {
  const d = defaultSettings();
  return {
    mode: d["briefs.policy_mode"],
    defaultPolicy: d["briefs.policy_default"],
    groups: d["briefs.policy_groups"],
    prompt: d["briefs.prompt"],
    background: d["briefs.background"],
    lookbackDays: d["briefs.background_lookback_days"],
    skipUnderWords: d["briefs.skip_under_words"],
    fyiMinMessages: d["briefs.fyi_min_messages"],
    fyiMinWords: d["briefs.fyi_min_words"],
    automatedSenders: d["briefs.automated_senders"],
    ...overrides,
  };
}

function facts(overrides: Partial<BriefThreadFacts> = {}): BriefThreadFacts {
  return {
    threadId: "t1",
    workspaceId: "ws",
    me,
    subject: "Take-home review",
    messageCount: 1,
    hasAttachments: false,
    lastActivity: "2026-09-17T09:00:00.000Z",
    section: null,
    groupId: null,
    subgroupId: null,
    latest: {
      from: aoife,
      to: [sam],
      cc: [],
      date: "2026-09-17T09:00:00.000Z",
      headers: {},
      text: "Can you give me a yes or no by Friday?",
    },
    words: 9,
    ...overrides,
  };
}

const NOW = new Date("2026-09-17T10:00:00Z");

describe("the shipped rule over Thread facts", () => {
  test("a Message from someone else addressed to me needs a reply: always", () => {
    expect(rulePolicy(facts(), policySettings())).toBe("always");
  });

  test("a newsletter or a notification waits for open", () => {
    const list = facts({
      latest: { ...facts().latest, headers: { "list-unsubscribe": "<mailto:u@x.test>" } },
    });
    expect(rulePolicy(list, policySettings())).toBe("on_open");
    const bulk = facts({ latest: { ...facts().latest, headers: { Precedence: "bulk" } } });
    expect(rulePolicy(bulk, policySettings())).toBe("on_open");
    const noreply = facts({
      latest: { ...facts().latest, from: { name: "GitHub", email: "noreply@github.test" } },
    });
    expect(rulePolicy(noreply, policySettings())).toBe("on_open");
    const auto = facts({
      latest: { ...facts().latest, headers: { "auto-submitted": "auto-generated" } },
    });
    expect(rulePolicy(auto, policySettings())).toBe("on_open");
    expect(isNewsletter({ "List-Id": "<x.test>" })).toBe(true);
    expect(isAutomated(aoife, { "auto-submitted": "no" }, ["noreply"])).toBe(false);
  });

  test("For your information earns a background Brief only with substance", () => {
    const cc = facts({ latest: { ...facts().latest, to: [aoife], cc: [sam] } });
    expect(rulePolicy(cc, policySettings())).toBe("on_open");
    expect(rulePolicy({ ...cc, messageCount: 2 }, policySettings())).toBe("always");
    expect(rulePolicy({ ...cc, hasAttachments: true }, policySettings())).toBe("always");
    expect(rulePolicy({ ...cc, words: 801 }, policySettings())).toBe("always");
    expect(rulePolicy({ ...cc, words: 801 }, policySettings({ fyiMinWords: 1000 }))).toBe(
      "on_open",
    );
    // The workspace default takes the rest.
    expect(rulePolicy(cc, policySettings({ defaultPolicy: "never" }))).toBe("never");
    // My own last word makes it FYI too: a two-message exchange still briefs in the background.
    const mine = facts({ messageCount: 2, latest: { ...facts().latest, from: sam, to: [aoife] } });
    expect(rulePolicy(mine, policySettings())).toBe("always");
  });

  test("a per-Group policy beats the rule, the Sub-group's entry beats the Group's", () => {
    const groups: Record<string, BriefPolicy> = { hiring: "never", candidates: "always" };
    expect(rulePolicy(facts({ groupId: "hiring" }), policySettings({ groups }))).toBe("never");
    expect(
      rulePolicy(
        facts({ groupId: "hiring", subgroupId: "candidates" }),
        policySettings({ groups }),
      ),
    ).toBe("always");
    expect(rulePolicy(facts({ groupId: "finance" }), policySettings({ groups }))).toBe("always");
  });

  test("the gates: user asks always compute; open computes unless never; sync needs always, background and the lookback", () => {
    const s = policySettings();
    const f = { messageCount: 3, words: 400, lastActivity: "2026-09-16T10:00:00.000Z" };
    expect(shouldCompute("always", "sync", f, s, NOW)).toBe(true);
    expect(shouldCompute("on_open", "sync", f, s, NOW)).toBe(false);
    expect(shouldCompute("on_open", "open", f, s, NOW)).toBe(true);
    expect(shouldCompute("never", "open", f, s, NOW)).toBe(false);
    expect(shouldCompute("never", "user", f, s, NOW)).toBe(true);
    expect(shouldCompute("always", "sync", f, { ...s, background: false }, NOW)).toBe(false);
    const old = { ...f, lastActivity: "2026-09-01T10:00:00.000Z" };
    expect(shouldCompute("always", "sync", old, s, NOW)).toBe(false);
    expect(shouldCompute("always", "open", old, s, NOW)).toBe(true);
    expect(shouldCompute("always", "sync", old, { ...s, lookbackDays: 0 }, NOW)).toBe(true);
    // One short Message gets no Brief, on sync or on open (docs/spec/inbox.md).
    const short = { messageCount: 1, words: 40, lastActivity: f.lastActivity };
    expect(shouldCompute("always", "sync", short, s, NOW)).toBe(false);
    expect(shouldCompute("always", "open", short, s, NOW)).toBe(false);
    expect(shouldCompute("always", "user", short, s, NOW)).toBe(true);
    expect(wordCount("  a b\n c ")).toBe(3);
    expect(wordCount("")).toBe(0);
  });
});

describe("mode model over the fake chat", () => {
  test("the model's one word decides, the prompt carries the user's instructions and the facts", async () => {
    const { runtime, chat, meter } = createFakeRuntime({ answer: "on_open" });
    const settings = policySettings({ mode: "model", prompt: "Only my team deserves a Brief." });
    const rule = createBriefPolicyRule({ settings: async () => settings, runtime });
    expect(await rule.for(facts())).toBe("on_open");
    expect(chat.calls).toHaveLength(1);
    expect(chat.calls[0]?.system).toContain("Only my team deserves a Brief.");
    expect(chat.calls[0]?.system).toContain("always, on_open or never");
    expect(chat.calls[0]?.prompt).toContain("Subject: Take-home review");
    expect(chat.calls[0]?.prompt).toContain(
      "Newest message from: Aoife Byrne <aoife@northwind.test>",
    );
    expect(chat.calls[0]?.maxOutputTokens).toBe(4096);
    // On the fast Role, metered as the classify Task.
    expect(meter.rows[0]).toMatchObject({ task: "classify", model: "claude-haiku-4-5" });
  });

  test("an answer that is not a policy word, or a failed call, falls back to the rule", async () => {
    const { runtime } = createFakeRuntime({ answer: "I would say it depends." });
    const rule = createBriefPolicyRule({
      settings: async () => policySettings({ mode: "model" }),
      runtime,
    });
    expect(await rule.for(facts())).toBe("always");
    const { runtime: noKey } = createFakeRuntime({ keys: {} });
    const fallback = createBriefPolicyRule({
      settings: async () => policySettings({ mode: "model" }),
      runtime: noKey,
    });
    expect(await fallback.for(facts())).toBe("always");
    expect(parsePolicyOutput("Never.")).toBe("never");
    expect(parsePolicyOutput("ON_OPEN please")).toBe("on_open");
    expect(parsePolicyOutput("maybe")).toBeNull();
  });

  test("a Group override skips the model", async () => {
    const { runtime, chat } = createFakeRuntime({ answer: "always" });
    const rule = createBriefPolicyRule({
      settings: async () => policySettings({ mode: "model", groups: { hiring: "never" } }),
      runtime,
    });
    expect(await rule.for(facts({ groupId: "hiring" }))).toBe("never");
    expect(chat.calls).toHaveLength(0);
    expect(policyPrompt(facts({ latest: { ...facts().latest, text: "" } }))).toContain(
      "not fetched yet",
    );
  });
});

describe("the brief Job's decisions over Postgres", () => {
  let db: TestDatabase;
  let keys: Keys;
  let store: Mailstore;
  let jobs: Jobs;
  let intelligence: Intelligence;
  let chat: ReturnType<typeof createFakeChat>;
  let app: Hono<AppEnv>;
  let workspaceId = "";
  let threadId = "";
  let sharedKeys: Partial<Record<HostedProvider, string>> = { anthropic: "sk-ant-fake" };
  let clock = NOW;

  const BRIEF = JSON.stringify({
    bullets: ["**Aoife** wants a yes or no by **Friday**."],
    actions: [],
  });

  const account: Account = {
    id: "acct-policy",
    provider: "imap",
    address: me,
    displayName: "Sam",
    capabilities: {
      push: false,
      labels: false,
      snooze: false,
      mute: false,
      calendar: false,
      meetingLink: null,
    },
  };

  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${SIDECAR_TOKEN}` },
    });

  const setSetting = async (key: string, value: unknown) => {
    await db.handle.db
      .insert(settingsTable)
      .values({ scope: "global", deviceId: null, key, value })
      .onConflictDoUpdate({
        target: [settingsTable.scope, settingsTable.deviceId, settingsTable.key],
        set: { value },
      });
  };

  const runAll = async () => {
    const ran: string[] = [];
    for (;;) {
      const job = await jobs.claim("server-a", ["needs-process"], 30_000);
      if (!job) break;
      ran.push(`${job.class}:${String(await jobs.run(job, 30_000))}`);
    }
    return ran;
  };

  const briefChanges = async () =>
    (await store.listChanges(workspaceId, { since: 0, limit: 1000 })).changes.filter(
      (c) => c.kind === "brief",
    );

  beforeAll(async () => {
    db = await testDatabase();
    keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    jobs = createJobs(db.handle.db, { now: () => clock });
    chat = createFakeChat((call) => (call.system.includes("one word") ? "always" : BRIEF));
    intelligence = createIntelligence({
      // These slices ran before the AI level existed; they assume the full level (slice 20).
      level: async () => "automate",
      db: db.handle.db,
      mailstore: store,
      chat: chat.chat,
      keys: async (provider) => sharedKeys[provider] ?? null,
      now: () => clock,
    });
    intelligence.registerSteps(jobs);
    app = createApp({
      db: db.handle.db,
      auth: createAuth({ db: db.handle.db, sidecarToken: SIDECAR_TOKEN }),
      mode: "sidecar",
      keys,
      mailstore: store,
      jobs,
      intelligence,
      remoteAddress: () => "127.0.0.1",
    });
    workspaceId = (await store.createWorkspace(account)).id;
    threadId = await store.upsertThread({
      workspaceId,
      providerThreadId: "thr-policy",
      subject: "Take-home review",
      participants: [aoife, sam],
      lastActivity: "2026-09-17T09:00:00.000Z",
      group: "hiring",
    });
    await store.upsertMessage({
      threadId,
      providerMessageId: "msg-1",
      from: aoife,
      to: [sam],
      cc: [],
      date: "2026-09-17T09:00:00.000Z",
      headers: {},
      bodyText: `The panel scored the take-home 4 of 5. ${"Can you give me a yes or no by Friday so the offer goes out next week? ".repeat(12)}`,
      bodyHtml: null,
      snippet: "The panel scored the take-home 4 of 5.",
    });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  test("threadReady queues one sync Job per Thread version, and a repeat is ignored", async () => {
    await intelligence.briefs.threadReady(workspaceId, threadId);
    await intelligence.briefs.threadReady(workspaceId, threadId);
    const version = { messageCount: 1, latestMessageId: "" };
    const queued = await jobs.get(
      briefJobId(threadId, { ...version, latestMessageId: await latestMessageId() }, "sync"),
    );
    expect(queued?.status).toBe("queued");
    expect(queued?.payload).toMatchObject({ workspaceId, threadId, trigger: "sync" });
    expect(await runAll()).toEqual([`${BRIEF_STEP}:done`]);
    expect(await intelligence.briefs.get(threadId)).toMatchObject({ stale: false });
    expect(chat.calls).toHaveLength(1);
    expect((await briefChanges()).map((c) => c.payload)).toEqual([
      { threadId, computedAt: NOW.toISOString(), stale: false, messageCount: 1, deleted: false },
    ]);
  });

  test("an open that finds a fresh Brief queues nothing; the route says so", async () => {
    expect(await intelligence.briefs.request(workspaceId, threadId, "open")).toEqual({
      status: "fresh",
    });
    const res = await request(`/threads/${threadId}/brief`, {
      method: "POST",
      body: JSON.stringify({ workspace: workspaceId, trigger: "open" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fresh: true });
    expect(await runAll()).toEqual([]);
  });

  test("a per-Group policy of never: the user's ask still computes, a new Message removes the Brief and the feed says so", async () => {
    await setSetting("briefs.policy_groups", { hiring: "never" });
    clock = new Date(NOW.getTime() + 60_000);
    const res = await request(`/threads/${threadId}/brief`, {
      method: "POST",
      body: JSON.stringify({ workspace: workspaceId, trigger: "user" }),
    });
    expect(res.status).toBe(202);
    // The user's ask computes whatever the policy says (inbox.md: "or when the user asks") ...
    expect(await runAll()).toEqual([`${BRIEF_STEP}:done`]);
    expect(chat.calls).toHaveLength(2);
    // ... a repeat of the sync Job for the same version is ignored ...
    await intelligence.briefs.threadReady(workspaceId, threadId);
    expect(await runAll()).toEqual([]);
    // ... and a new Message, under never, removes the (now stale) Brief instead of recomputing.
    await store.upsertMessage({
      threadId,
      providerMessageId: "msg-2",
      from: aoife,
      to: [sam],
      cc: [],
      date: "2026-09-17T09:30:00.000Z",
      headers: {},
      bodyText: "One more thing: the deadline moved to Monday.",
      bodyHtml: null,
      snippet: "One more thing",
    });
    await intelligence.briefs.threadReady(workspaceId, threadId);
    expect(await intelligence.briefs.get(threadId)).toMatchObject({ stale: true });
    expect((await briefChanges()).at(-1)?.payload).toMatchObject({ stale: true, messageCount: 1 });
    expect(await runAll()).toEqual([`${BRIEF_STEP}:done`]);
    expect(chat.calls).toHaveLength(2);
    expect(await intelligence.briefs.get(threadId)).toBeNull();
    expect((await briefChanges()).at(-1)?.payload).toMatchObject({ threadId, deleted: true });
    expect((await request(`/threads/${threadId}/brief`)).status).toBe(404);
    await setSetting("briefs.policy_groups", {});
  });

  test("mode model asks the classify Task once per decision and meters it", async () => {
    await setSetting("briefs.policy_mode", "model");
    const before = chat.calls.length;
    expect(await intelligence.briefs.request(workspaceId, threadId, "open")).toMatchObject({
      status: "queued",
    });
    expect(await runAll()).toEqual([`${BRIEF_STEP}:done`]);
    const calls = chat.calls.slice(before);
    expect(calls.map((c) => (c.system.includes("one word") ? "classify" : "brief"))).toEqual([
      "classify",
      "brief",
    ]);
    const month = await intelligence.meter.month(workspaceId, "2026-09");
    expect(month.lines.map((l) => [l.task, l.calls])).toEqual([
      ["brief", 3],
      ["classify", 1],
    ]);
    await setSetting("briefs.policy_mode", "rule");
  });

  test("without a key for the brief Task nothing is queued; the route answers 409", async () => {
    sharedKeys = {};
    expect(await intelligence.briefs.request(workspaceId, threadId, "user")).toEqual({
      status: "no_key",
    });
    const res = await request(`/threads/${threadId}/brief`, {
      method: "POST",
      body: JSON.stringify({ workspace: workspaceId }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "no_shared_key", provider: "anthropic" });
    await intelligence.briefs.threadReady(workspaceId, threadId);
    expect(await runAll()).toEqual([]);
    sharedKeys = { anthropic: "sk-ant-fake" };
  });

  test("DELETE removes a Brief and the feed says so", async () => {
    expect(await intelligence.briefs.request(workspaceId, threadId, "user")).toMatchObject({
      status: "queued",
    });
    await runAll();
    expect(await intelligence.briefs.get(threadId)).not.toBeNull();
    expect((await request(`/threads/${threadId}/brief`, { method: "DELETE" })).status).toBe(204);
    expect(await intelligence.briefs.get(threadId)).toBeNull();
    expect((await briefChanges()).at(-1)?.payload).toMatchObject({ deleted: true });
    expect(await intelligence.briefs.remove(threadId)).toBe(false);
  });

  async function latestMessageId(): Promise<string> {
    const [m] = await store.listMessages(threadId);
    return m?.id ?? "";
  }
});
