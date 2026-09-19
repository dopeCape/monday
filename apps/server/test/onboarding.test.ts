// Onboarding (slice 20, docs/spec/onboarding.md, CONTEXT.md "AI level") over
// the routes and the Jobs table with the fake seams: the recorded fixture
// mailbox stands in for a fresh Fastmail account. The done-when: the user
// picks `automate`, the conversation runs on the Agent host with the fake
// chat scripted through the five questions, the Groups proposal lists the
// count of Threads that would move, approving applies them, the Workflows
// proposal shows a Dry run and approving enables exactly one, and the whole
// thing completes under a fake clock inside 5 minutes with every model call
// metered. Then the level: `off` renders no Brief, enqueues no route Job on
// arrival and refuses runtime.run with ai_off; lowering from `automate` to
// `off` keeps every Group and Workflow row.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  Account,
  AgentEvent,
  GroupView,
  SessionSummary,
  ToolPreview,
  WorkflowView,
} from "@monday/shared";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { createChangeBus } from "../src/changes/bus.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys, type Keys } from "../src/crypto/keys.ts";
import {
  AiOffError,
  createFakeIntegrations,
  createFakeMcpClients,
  createIntelligence,
  type Intelligence,
  ROUTE_STEP,
} from "../src/intelligence/index.ts";
import { createFakeChat, createFakeConverse } from "../src/intelligence/runtime/fake/index.ts";
import { createJobs, type Jobs } from "../src/jobs/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { createCredentialStore } from "../src/providers/credentials.ts";
import {
  createFakeProvider,
  type FakeProvider,
  fakeCredentials,
  generateFixture,
} from "../src/providers/fake/index.ts";
import { createProviderRegistry } from "../src/providers/index.ts";
import { createSyncEngine, defaultSyncSettings, type SyncEngine } from "../src/providers/sync.ts";
import { matchCatalog, WORKFLOW_CATALOG } from "../src/workflows/catalog.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const SIDECAR_TOKEN = "per-launch-token";
const fixture = generateFixture();
const START = new Date(fixture.recordedAt);

/** The fresh Account: the fixture's owner over the fake Provider standing in for Fastmail. */
const account: Account = {
  id: "acct-fresh",
  provider: "jmap",
  address: fixture.address,
  displayName: fixture.owner.name,
  capabilities: {
    push: true,
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

describe("a fresh Fastmail account ends onboarding with approved Groups and one enabled Workflow inside 5 minutes", () => {
  let db: TestDatabase;
  let keys: Keys;
  let store: Mailstore;
  let jobs: Jobs;
  let engine: SyncEngine;
  let fake: FakeProvider;
  let intelligence: Intelligence;
  let app: Hono<AppEnv>;
  let workspaceId = "";
  let session: SessionSummary;
  /** The fake wall clock: every turn and approval moves it forward. */
  let clock = START;
  const converse = createFakeConverse();
  // Classify answers for Threads no Predicate places: nothing confident, so they stay.
  const chat = createFakeChat('{"scores": {}}');
  const bus = createChangeBus();

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
  const setLevel = async (level: string) => {
    const res = await send("/settings/ai.level", { value: level, scope: "global" }, "PUT");
    expect(res.status).toBe(200);
  };
  const tick = (seconds: number) => {
    clock = new Date(clock.getTime() + seconds * 1000);
  };
  /** One user turn of the onboarding conversation: 20 seconds of typing, then the stream. */
  const turn = async (text: string): Promise<AgentEvent[]> => {
    tick(20);
    const res = await send(`/sessions/${session.id}/turns`, {
      text,
      context: { onboarding: true },
    });
    expect(res.status).toBe(200);
    return eventsOf(await res.text());
  };
  const approve = async (activityId: string): Promise<AgentEvent[]> => {
    tick(10);
    const res = await send(`/sessions/${session.id}/approvals/${activityId}`, {
      decision: "approved",
      context: { onboarding: true },
    });
    expect(res.status).toBe(200);
    return eventsOf(await res.text());
  };
  const waitingCard = (events: AgentEvent[], tool: string) => {
    const card = events.find(
      (e) => e.kind === "tool" && e.call.tool === tool && e.call.status === "waiting",
    );
    if (card?.kind !== "tool") throw new Error(`no waiting ${tool} card`);
    return card;
  };
  const textOf = (p: ToolPreview | null) => (p?.kind === "text" ? p.text : "");
  const syncAll = async () => {
    let report = await engine.syncAccount(account.id);
    for (let i = 0; i < 20 && report.more; i++) report = await engine.syncAccount(account.id);
  };
  const groups = async (): Promise<GroupView[]> =>
    ((await (await request(`/groups?workspace=${workspaceId}`)).json()) as { groups: GroupView[] })
      .groups;
  const workflows = async (): Promise<WorkflowView[]> =>
    (
      (await (await request(`/workflows?workspace=${workspaceId}`)).json()) as {
        workflows: WorkflowView[];
      }
    ).workflows;

  beforeAll(async () => {
    db = await testDatabase();
    keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    const credentials = createCredentialStore(db.handle.db, store);
    fake = createFakeProvider(fixture);
    workspaceId = (await store.createWorkspace(account)).id;
    await credentials.store(workspaceId, account.id, fakeCredentials());
    jobs = createJobs(db.handle.db, { now: () => clock });
    engine = createSyncEngine({
      db: db.handle.db,
      mailstore: store,
      providers: createProviderRegistry({ overrides: { jmap: fake } }),
      credentials,
      settings: async () => ({ ...defaultSyncSettings(), batchSize: 25 }),
      now: () => clock,
      watchDebounceMs: 50,
    });
    // The level is the Setting, read live: nothing pins it here.
    intelligence = createIntelligence({
      db: db.handle.db,
      mailstore: store,
      chat: chat.chat,
      converse: converse.converse,
      integrations: createFakeIntegrations(),
      mcp: createFakeMcpClients(),
      now: () => clock,
    });
    intelligence.registerSteps(jobs);
    await intelligence.keys.put(workspaceId, "anthropic", "sk-ant-shared");
    app = createApp({
      db: db.handle.db,
      auth: createAuth({ db: db.handle.db, sidecarToken: SIDECAR_TOKEN }),
      mode: "sidecar",
      keys,
      mailstore: store,
      jobs,
      sync: engine,
      intelligence,
      changes: bus,
      remoteAddress: () => "127.0.0.1",
    });
    await syncAll();
  }, 120_000);

  afterAll(async () => {
    await engine.close();
    await db.drop();
  });

  test("the catalog holds at least four documents and matches the tools chosen", () => {
    expect(WORKFLOW_CATALOG.length).toBeGreaterThanOrEqual(4);
    expect(WORKFLOW_CATALOG.map((e) => e.document.name)).toEqual(
      expect.arrayContaining([
        "Invoices to Drive",
        "Candidate intake",
        "Newsletter digest",
        "Receipts tag",
      ]),
    );
    expect(matchCatalog(["drive"], 2).map((e) => e.id)).toEqual([
      "invoices-to-drive",
      "newsletter-digest",
    ]);
    expect(matchCatalog(["Notion", "slack"], 2).map((e) => e.id)).toEqual([
      "candidates-to-notion",
      "hiring-to-slack",
    ]);
    expect(matchCatalog([], 2).every((e) => e.tools.length === 0)).toBe(true);
  });

  test("before onboarding the level is off: a Brief request answers ai_off, arrival enqueues no route Job, runtime.run is refused", async () => {
    expect(await intelligence.level()).toBe("off");
    const page = await store.listThreads(workspaceId, { limit: 1 });
    const threadId = page.threads[0]?.id ?? "";
    expect(threadId).not.toBe("");
    const brief = await send(`/threads/${threadId}/brief`, {
      workspace: workspaceId,
      trigger: "open",
    });
    expect(brief.status).toBe(409);
    expect(await brief.json()).toEqual({ error: "ai_off" });
    expect(await intelligence.routing.onArrival(workspaceId, threadId, clock.toISOString())).toBe(
      null,
    );
    expect(await jobs.get(`${ROUTE_STEP}:${threadId}`)).toBeNull();
    await expect(
      intelligence.runtime.run("brief", { system: "s", prompt: "p" }, { workspaceId }),
    ).rejects.toBeInstanceOf(AiOffError);
    expect(chat.calls).toHaveLength(0);
  });

  test("the user picks automate; the conversation asks five questions, proposes Groups with move counts, and approval applies them", async () => {
    await setLevel("automate");
    expect(await intelligence.level()).toBe("automate");
    const meterBefore = (
      await intelligence.meter.month(workspaceId, clock.toISOString().slice(0, 7))
    ).lines.length;
    session = (await (
      await send("/sessions", { workspace: workspaceId })
    ).json()) as SessionSummary;

    // The fake model, scripted through the conversation the onboarding prompt asks for.
    converse.script(
      // The onboarding prompt reached the model, filled in with the level and the knobs.
      (call) => {
        expect(call.system).toContain("This Session is onboarding");
        expect(call.system).toContain("AI level is automate");
        expect(call.system).toContain("at most 5 questions");
        return { toolCalls: [{ id: "c-ctx", name: "onboarding_context", args: {} }] };
      },
      (call) => {
        const ctx = call.messages.at(-1);
        expect(ctx?.role === "tool" && ctx.content).toContain("Top senders:");
        expect(ctx?.role === "tool" && ctx.content).toContain("aoife@northwind.test");
        return "Who are you and what do you do?";
      },
      "What mail matters most to you?",
      "Which tools do you use: Slack, Notion, Drive, Discord?",
      "May monday learn your voice from your sent mail?",
      "May monday read the last 30 days of mail to propose Groups?",
      // Q5 answered yes: the proposal, from the top senders and the answers.
      {
        text: "Here is what I would set up.",
        toolCalls: [
          {
            id: "c-groups",
            name: "propose_groups",
            args: {
              groups: [
                {
                  name: "Northwind",
                  sentence: "Everything from Aoife at Northwind.",
                  senders: ["aoife@northwind.test"],
                },
                {
                  name: "Lumen",
                  sentence: "Mail from anyone at Lumen.",
                  domains: ["lumen.test"],
                },
                {
                  name: "Nobody",
                  sentence: "A rule that matches nothing yet.",
                  domains: ["nowhere.test"],
                },
              ],
            },
          },
        ],
      },
      // After the approval lands, the Workflows proposal for the tool named.
      (call) => {
        const result = call.messages.at(-1);
        expect(result?.role === "tool" && result.content).toContain("Created 3 Groups");
        return {
          toolCalls: [{ id: "c-wf", name: "propose_workflows", args: { tools: ["drive"] } }],
        };
      },
      (call) => {
        const result = call.messages.at(-1);
        expect(result?.role === "tool" && result.content).toContain("Dry run");
        expect(result?.role === "tool" && result.content).toContain("invoices-to-drive");
        return "Two fit: Invoices to Drive and the Newsletter digest. Which one?";
      },
      {
        toolCalls: [
          { id: "c-adopt", name: "adopt_workflow", args: { catalog_id: "invoices-to-drive" } },
        ],
      },
      { toolCalls: [{ id: "c-keys", name: "set_keymap", args: { keymap: "natural" } }] },
      "Done. Set me up in the composer runs this again whenever you like.",
    );

    let events = await turn("Set me up.");
    expect(events.some((e) => e.kind === "tool" && e.call.tool === "onboarding_context")).toBe(
      true,
    );
    expect(events.at(-2)).toMatchObject({ kind: "text", text: "Who are you and what do you do?" });
    events = await turn("I run a small studio.");
    expect(events.at(-2)).toMatchObject({ kind: "text", text: "What mail matters most to you?" });
    events = await turn("Aoife Byrne, Mateo Silva");
    events = await turn("Drive");
    events = await turn("Skip");
    events = await turn("Yes");

    // The proposal card: each Group's sentence with the count of existing Threads that would move.
    const proposal = waitingCard(events, "propose_groups");
    expect(proposal.call).toMatchObject({
      tier: "reversible",
      inputSummary: "Northwind, Lumen, Nobody",
    });
    const listed = textOf(proposal.preview);
    expect(listed).toMatch(
      /Northwind: Everything from Aoife at Northwind\. \(\d+ threads? would move\)/,
    );
    expect(listed).toMatch(/Lumen: Mail from anyone at Lumen\. \(\d+ threads? would move\)/);
    expect(listed).toContain("Nobody: A rule that matches nothing yet. (0 threads would move)");
    const counted = [...listed.matchAll(/\((\d+) threads? would move\)/g)].map((m) => Number(m[1]));
    expect(counted).toHaveLength(3);
    expect(counted[0]).toBeGreaterThan(0);
    expect(counted[1]).toBeGreaterThan(0);
    expect(counted[2]).toBe(0);
    // Nothing applied until approved.
    expect(await groups()).toEqual([]);
    expect(events.at(-1)).toMatchObject({ kind: "done", waiting: proposal.call.id });

    // Approving creates the Groups and applies exactly the moves the card counted.
    events = await approve(proposal.call.id);
    const applied = events.find(
      (e) => e.kind === "tool" && e.call.tool === "propose_groups" && e.call.status === "done",
    );
    expect(applied?.kind === "tool" && applied.call).toMatchObject({
      approvedBy: "user",
      undoable: true,
    });
    const made = await groups();
    expect(made.map((g) => g.name).sort()).toEqual(["Lumen", "Nobody", "Northwind"]);
    const northwind = made.find((g) => g.name === "Northwind");
    const lumen = made.find((g) => g.name === "Lumen");
    expect(northwind?.threads).toBe(counted[0] ?? -1);
    expect(lumen?.threads).toBe(counted[1] ?? -1);
    expect(northwind?.rule.sentence).toBe("Everything from Aoife at Northwind.");

    // The conversation went on to the Workflows proposal: the model read the Dry runs and asked which one.
    expect(
      events.some(
        (e) => e.kind === "tool" && e.call.tool === "propose_workflows" && e.call.status === "done",
      ),
    ).toBe(true);
    expect(events.at(-2)).toMatchObject({
      kind: "text",
      text: expect.stringContaining("Which one?"),
    });
    expect(await workflows()).toEqual([]);
    // Picking one: the adopt card asks with its Dry run.
    events = await turn("Invoices");
    const adopt = waitingCard(events, "adopt_workflow");
    expect(textOf(adopt.preview)).toContain('Enable "Invoices to Drive"?');
    expect(textOf(adopt.preview)).toContain("Dry run");
    expect(await workflows()).toEqual([]);

    events = await approve(adopt.call.id);
    const enabled = await workflows();
    expect(enabled).toHaveLength(1);
    expect(enabled[0]).toMatchObject({ name: "Invoices to Drive", enabled: true, version: 1 });
    expect(enabled.filter((w) => w.enabled)).toHaveLength(1);
    // The keymap landed and the last line closed the conversation.
    expect(
      events.some(
        (e) => e.kind === "tool" && e.call.tool === "set_keymap" && e.call.status === "done",
      ),
    ).toBe(true);
    expect(events.at(-2)).toMatchObject({ kind: "text", text: expect.stringContaining("Done.") });
    const keymap = await (await request("/settings")).json();
    expect((keymap as { global: Record<string, unknown> }).global["keyboard.keymap"]).toBe(
      "natural",
    );

    // Inside 5 minutes on the fake clock, every model call metered.
    const elapsed = (clock.getTime() - START.getTime()) / 1000;
    expect(elapsed).toBeLessThan(300);
    const month = await intelligence.meter.month(workspaceId, clock.toISOString().slice(0, 7));
    const composer = month.lines.filter((r) => r.task === "composer");
    expect(composer.reduce((n, r) => n + r.calls, 0)).toBe(converse.calls.length);
    expect(month.lines.length).toBeGreaterThan(meterBefore);
  });

  test("assist skips the Groups and Workflows proposals: the tools refuse", async () => {
    await setLevel("assist");
    const tools = intelligence.agent.tools(workspaceId);
    const groupsRefused = await tools.preview({
      name: "propose_groups",
      args: { groups: [{ name: "X", sentence: "x", domains: ["x.test"] }] },
    });
    expect(groupsRefused).toMatchObject({
      kind: "refused",
      text: expect.stringContaining("automate"),
    });
    const wfRefused = await tools.preview({ name: "propose_workflows", args: { tools: [] } });
    expect(wfRefused).toMatchObject({ kind: "refused" });
    // The agent bar's tools still work: the level is assist, not off.
    const ctx = await tools.preview({ name: "onboarding_context", args: {} });
    expect(ctx).toMatchObject({
      kind: "result",
      text: expect.stringContaining("AI level: assist"),
    });
    // Background work stays off at assist: an arrival enqueues no route Job and no Workflow trigger.
    const page = await store.listThreads(workspaceId, { limit: 1 });
    const threadId = page.threads[0]?.id ?? "";
    expect(await intelligence.routing.onArrival(workspaceId, threadId, clock.toISOString())).toBe(
      null,
    );
    expect(await intelligence.workflows.onArrival(workspaceId, threadId)).toBe(null);
  });

  test("lowering from automate to off keeps every Group and Workflow row; the enabled flag stays", async () => {
    await setLevel("automate");
    const page = await store.listThreads(workspaceId, { limit: 1 });
    const threadId = page.threads[0]?.id ?? "";
    // At automate the arrival hooks enqueue again.
    expect(await intelligence.workflows.onArrival(workspaceId, threadId)).not.toBeNull();
    await setLevel("off");
    expect((await groups()).map((g) => g.name).sort()).toEqual(["Lumen", "Nobody", "Northwind"]);
    const kept = await workflows();
    expect(kept).toHaveLength(1);
    expect(kept[0]?.enabled).toBe(true);
    expect(await intelligence.workflows.onArrival(workspaceId, threadId)).toBeNull();
    // A turn at off ends with an ai_off error card, no model call.
    const before = converse.calls.length;
    const events = await turn("Anything?");
    expect(events.some((e) => e.kind === "error" && e.code === "ai_off")).toBe(true);
    expect(converse.calls.length).toBe(before);
  });
});
