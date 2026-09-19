// Workflows (slice 16, ADR 0003, ADR 0002, ADR 0005) through the routes and
// the Jobs table over the fake seams: the "Candidate intake" Workflow from
// the mock as its JSON document, a fixture Thread arriving through the sync
// engine over the fake Provider, the trigger Job, the Run as a chain of Step
// Jobs, the agentic Step through the LangGraph loop with the fake model
// scripted, the pause at Slack with its approval card, the Standing approval
// that lets it finish, Dry runs that apply nothing, versions, and the failure
// policy.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  Account,
  ActivityRecord,
  DryRunPreview,
  GroupView,
  RunView,
  Thread,
  WorkflowInputRaw,
  WorkflowView,
} from "@monday/shared";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { createChangeBus } from "../src/changes/bus.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys, type Keys } from "../src/crypto/keys.ts";
import {
  createFakeIntegrations,
  createFakeMcpClients,
  createIntelligence,
  type Intelligence,
  ROUTE_STEP,
  WORKFLOW_SCHEDULE_STEP,
  WORKFLOW_STEP_STEP,
  WORKFLOW_TRIGGER_STEP,
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
import { type TestDatabase, testDatabase } from "./harness.ts";

const SIDECAR_TOKEN = "per-launch-token";
const fixture = generateFixture();
const NOW = new Date(fixture.recordedAt);

const account: Account = {
  id: "acct-workflows",
  provider: "imap",
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

/** The "Candidate intake" Workflow from design/js/data.js, as the document the Agent would write. */
function candidateIntake(candidatesGroupId: string): WorkflowInputRaw {
  return {
    name: "Candidate intake",
    sentence:
      "When a candidate emails about any open role, extract name, role and links, post a summary to the Hiring Notion database, label the thread and ping #hiring on Slack if the role is Rust.",
    kind: "hybrid",
    trigger: { kind: "arrival", group: candidatesGroupId },
    steps: [
      {
        id: "extract",
        kind: "agentic",
        name: "Extract",
        prompt:
          "Read the thread and extract the candidate's name, the role they are applying for and any links they shared.",
        tools: ["read_thread"],
        budget: { calls: 4 },
        outputs: ["name", "role", "links"],
      },
      {
        id: "notion",
        kind: "notion",
        name: "Notion",
        database: "Hiring",
        properties: {
          Name: "{{steps.extract.name}}",
          Role: "{{steps.extract.role}}",
          Links: "{{steps.extract.links}}",
          Thread: "{{thread.subject}}",
        },
      },
      { id: "label", kind: "tag", name: "Label", add: ["candidate"] },
      {
        id: "rust",
        kind: "condition",
        name: "If role is Rust",
        when: { left: "{{steps.extract.role}}", op: "contains", value: "rust" },
      },
      {
        id: "slack",
        kind: "slack",
        name: "Slack",
        channel: "#hiring",
        text: "New candidate: {{steps.extract.name}} for {{steps.extract.role}}",
      },
    ],
    placement: "server",
    failurePolicy: "stop",
    // The Notion row is pre-approved, as the mock's Run log shows; Slack is not.
    standingApprovals: ["notion"],
  };
}

const candidateMail = (n: number, name: string, email: string, role: string) => ({
  mailbox: "inbox" as const,
  threadKey: `cand-${n}`,
  from: { name, email },
  to: [fixture.owner],
  cc: [],
  subject: `Application: ${role}`,
  date: new Date(NOW.getTime() - n * 60_000).toISOString(),
  messageId: `cand-${n}@candidates.test`,
  inReplyTo: null,
  references: [],
  seen: false,
  flagged: false,
  answered: false,
  headers: {},
  text: `Hi, I am ${name} and I would like to apply for the ${role} role. My work: https://github.com/${name.split(" ")[0]?.toLowerCase()}`,
  html: null,
  attachments: [],
});

describe("the Candidate intake workflow runs on a fixture arrival, pauses at Slack without a Standing approval, and completes after one", () => {
  let db: TestDatabase;
  let keys: Keys;
  let store: Mailstore;
  let jobs: Jobs;
  let engine: SyncEngine;
  let fake: FakeProvider;
  let intelligence: Intelligence;
  let app: Hono<AppEnv>;
  let workspaceId = "";
  let candidatesId = "";
  let workflowId = "";
  let runId = "";
  const integrations = createFakeIntegrations();
  const converse = createFakeConverse();
  const bus = createChangeBus();
  const ran: string[] = [];

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

  const syncAll = async () => {
    let report = await engine.syncAccount(account.id);
    for (let i = 0; i < 20 && report.more; i++) report = await engine.syncAccount(account.id);
  };

  /** Runs every routing and Workflow Job that is due, in the order the table hands them out. */
  const drain = async (): Promise<string[]> => {
    const wanted = new Set([
      ROUTE_STEP,
      WORKFLOW_TRIGGER_STEP,
      WORKFLOW_STEP_STEP,
      WORKFLOW_SCHEDULE_STEP,
    ]);
    const classes: string[] = [];
    for (let i = 0; i < 50; i++) {
      const job = await jobs.claim("server-a", ["needs-process"], 30_000);
      if (!job) break;
      if (!wanted.has(job.class)) {
        await jobs.requeue(job.id, "server-a", 600_000);
        continue;
      }
      const result = await jobs.run(job, 30_000);
      classes.push(`${job.class}${result === "done" ? "" : `:${JSON.stringify(result)}`}`);
      ran.push(job.class);
    }
    return classes;
  };

  const runOf = async (id: string): Promise<RunView> => {
    const res = await request(`/workflows/runs/${id}`);
    expect(res.status).toBe(200);
    return (await res.json()) as RunView;
  };
  const threadBySubject = async (subject: string): Promise<Thread> => {
    const page = await store.listThreads(workspaceId, { limit: 500, includeArchived: true });
    for (const t of page.threads) {
      if ((await store.readThreadSubject(t.id)) === subject) return t;
    }
    throw new Error(`no thread ${subject}`);
  };

  beforeAll(async () => {
    db = await testDatabase();
    keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    const credentials = createCredentialStore(db.handle.db, store);
    fake = createFakeProvider(fixture);
    workspaceId = (await store.createWorkspace(account)).id;
    await credentials.store(workspaceId, account.id, fakeCredentials());
    jobs = createJobs(db.handle.db, { now: () => NOW });
    engine = createSyncEngine({
      db: db.handle.db,
      mailstore: store,
      providers: createProviderRegistry({ overrides: { imap: fake } }),
      credentials,
      settings: async () => ({ ...defaultSyncSettings(), batchSize: 25 }),
      now: () => NOW,
      watchDebounceMs: 50,
    });
    intelligence = createIntelligence({
      // These slices ran before the AI level existed; they assume the full level (slice 20).
      level: async () => "automate",
      db: db.handle.db,
      mailstore: store,
      chat: createFakeChat("Dear candidate, thank you for applying.").chat,
      converse: converse.converse,
      integrations,
      mcp: createFakeMcpClients(),
      now: () => NOW,
    });
    intelligence.registerSteps(jobs);
    await intelligence.keys.put(workspaceId, "anthropic", "sk-ant-shared");
    const auth = createAuth({ db: db.handle.db, sidecarToken: SIDECAR_TOKEN });
    app = createApp({
      db: db.handle.db,
      auth,
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
    // Hiring › Candidates, placed by Predicate so routing needs no model call.
    const hiring = (await (
      await send("/groups", {
        workspace: workspaceId,
        name: "Hiring",
        predicate: { domains: ["candidates.test"] },
      })
    ).json()) as GroupView;
    const candidates = (await (
      await send("/groups", {
        workspace: workspaceId,
        name: "Candidates",
        parentId: hiring.id,
        predicate: { domains: ["candidates.test"] },
      })
    ).json()) as GroupView;
    candidatesId = candidates.id;
  }, 120_000);

  afterAll(async () => {
    await engine.close();
    await db.drop();
  });

  test("the document is created through the route, disabled, at version 1, and enabling arms it", async () => {
    const created = await send("/workflows", {
      workspace: workspaceId,
      ...candidateIntake(candidatesId),
    });
    expect(created.status).toBe(201);
    const view = (await created.json()) as WorkflowView;
    workflowId = view.id;
    expect(view).toMatchObject({
      name: "Candidate intake",
      enabled: false,
      version: 1,
      placementInEffect: "server",
      standingApprovals: ["notion"],
    });
    expect(view.steps.map((s) => s.kind)).toEqual([
      "agentic",
      "notion",
      "tag",
      "condition",
      "slack",
    ]);
    // A bad document never saves: the send step names a draft step that does not exist.
    const bad = await send("/workflows", {
      workspace: workspaceId,
      name: "Broken",
      trigger: { kind: "manual" },
      steps: [{ id: "go", kind: "send", name: "Send", draftFrom: "nope" }],
    });
    expect(bad.status).toBe(400);
    // Nothing listens until a Workflow is enabled: the arrival hook enqueues nothing.
    expect(await intelligence.workflows.onArrival(workspaceId, "any")).toBeNull();
    const enabled = await send(`/workflows/${workflowId}/enable`, { enabled: true });
    expect(enabled.status).toBe(200);
    expect(((await enabled.json()) as WorkflowView).enabled).toBe(true);
  });

  test("a fixture arrival enqueues the trigger Job behind routing, the Steps run as Jobs in order, and the Run pauses at Slack", async () => {
    converse.script(
      // The agentic Step reads the Thread it was pointed at, then reports the fields.
      (call) => {
        expect(call.tools.map((t) => t.name)).toEqual(["read_thread"]);
        const user = call.messages[0];
        const threadId = /id ([0-9a-f-]{36})/.exec(user?.role === "user" ? user.content : "")?.[1];
        return { toolCalls: [{ id: "c1", name: "read_thread", args: { thread_id: threadId } }] };
      },
      (call) => {
        const tool = call.messages.at(-1);
        expect(tool?.role === "tool" && tool.content).toContain("Aoife Brennan");
        return 'Done. {"name": "Aoife Brennan", "role": "Senior Rust engineer", "links": "https://github.com/aoife"}';
      },
    );
    fake.deliver(
      candidateMail(1, "Aoife Brennan", "aoife@candidates.test", "Senior Rust engineer"),
    );
    await syncAll();
    const thread = await threadBySubject("Application: Senior Rust engineer");
    // Through the Jobs table, never inline: routing first, then the trigger.
    expect((await jobs.get(`${ROUTE_STEP}:${thread.id}`))?.status).toBe("queued");
    expect((await jobs.get(`${WORKFLOW_TRIGGER_STEP}:${thread.id}`))?.status).toBe("queued");
    const first = await drain();
    expect(first).toEqual([
      ROUTE_STEP,
      WORKFLOW_TRIGGER_STEP,
      WORKFLOW_STEP_STEP,
      WORKFLOW_STEP_STEP,
      WORKFLOW_STEP_STEP,
      WORKFLOW_STEP_STEP,
      WORKFLOW_STEP_STEP,
    ]);
    const runs = (await (await request(`/workflows/runs?workspace=${workspaceId}`)).json()) as {
      runs: RunView[];
    };
    expect(runs.runs).toHaveLength(1);
    const run = runs.runs[0] as RunView;
    runId = run.id;
    expect(run).toMatchObject({
      workflowId,
      version: 1,
      status: "paused",
      threadId: thread.id,
      subject: "Application: Senior Rust engineer",
      waitingStep: 4,
      trigger: { kind: "arrival", threadId: thread.id },
    });
    expect(run.steps.map((s) => [s.name, s.status])).toEqual([
      ["Extract", "done"],
      ["Notion", "done"],
      ["Label", "done"],
      ["If role is Rust", "done"],
      ["Slack", "waiting"],
    ]);
    expect(run.steps[0]?.detail).toBe(
      "name: Aoife Brennan, role: Senior Rust engineer, links: https://github.com/aoife",
    );
    // The Notion row went out under its Standing approval; Slack did not.
    expect(integrations.posts.map((p) => p.post.integration)).toEqual(["notion"]);
    expect(integrations.posts[0]?.post).toMatchObject({
      database: "Hiring",
      properties: {
        Name: "Aoife Brennan",
        Role: "Senior Rust engineer",
        Thread: "Application: Senior Rust engineer",
      },
    });
    // The Tag landed through the same intent path a manual one takes.
    const tagged = await threadBySubject("Application: Senior Rust engineer");
    expect(tagged.tags).toHaveLength(1);
    expect(tagged.subgroup).toBe(candidatesId);
    // The Activity log holds every Step under the Run id, and the pause is a waiting row with the card's preview.
    const activity = (await (await request(`/workflows/runs/${runId}/activity`)).json()) as {
      activity: ActivityRecord[];
    };
    // Under the frozen clock every row shares one timestamp, so compare as a set.
    expect(activity.activity.map((a) => [a.tool, a.status, a.approvedBy].join(" ")).sort()).toEqual(
      [
        "workflow.agentic done ",
        "read_thread done ",
        "add_notion_row done standing",
        "tag_threads done ",
        "post_to_slack waiting ",
      ].sort(),
    );
    const waiting = activity.activity.find((a) => a.tool === "post_to_slack") as ActivityRecord;
    expect(waiting.id).toBe(run.waitingActivityId as string);
    expect(waiting.tier).toBe("always-ask");
    expect(waiting.preview).toEqual({
      kind: "text",
      text: "Slack #hiring:\nNew candidate: Aoife Brennan for Senior Rust engineer",
    });
    expect(waiting.runId).toBe(runId);
    // The agentic Step metered under its own Task, not the composer's.
    const meter = intelligence.meter;
    const month = await meter.month(workspaceId, NOW.toISOString().slice(0, 7));
    expect(month.lines.map((l) => [l.task, l.calls])).toEqual([["agentic-step", 2]]);
  });

  test("a Standing approval granted through the route lets the resumed Run complete, and the Slack fake received the post", async () => {
    const granted = await send(`/workflows/${workflowId}/approvals`, {
      step: "slack",
      granted: true,
    });
    expect(granted.status).toBe(200);
    expect(((await granted.json()) as WorkflowView).standingApprovals).toEqual(["notion", "slack"]);
    const resumed = await send(`/workflows/runs/${runId}/approvals`, { decision: "approved" });
    expect(resumed.status).toBe(200);
    expect(await drain()).toEqual([WORKFLOW_STEP_STEP]);
    const run = await runOf(runId);
    expect(run.status).toBe("done");
    expect(run.finishedAt).not.toBeNull();
    expect(run.steps.map((s) => s.status)).toEqual(["done", "done", "done", "done", "done"]);
    expect(integrations.posts.map((p) => p.post.integration)).toEqual(["notion", "slack"]);
    expect(integrations.posts[1]?.post).toEqual({
      integration: "slack",
      channel: "#hiring",
      text: "New candidate: Aoife Brennan for Senior Rust engineer",
    });
    const activity = (await (await request(`/workflows/runs/${runId}/activity`)).json()) as {
      activity: ActivityRecord[];
    };
    const slack = activity.activity.find((a) => a.tool === "post_to_slack") as ActivityRecord;
    expect(slack).toMatchObject({ status: "done", approvedBy: "standing" });
    // Approving again is refused: the Run is no longer waiting.
    expect(
      (await send(`/workflows/runs/${runId}/approvals`, { decision: "approved" })).status,
    ).toBe(409);
  });

  test("a non-Rust candidate stops at the condition and never reaches Slack", async () => {
    converse.script(
      { toolCalls: [{ id: "c2", name: "read_thread", args: { thread_id: "x" } }] },
      '{"name": "Ngozi Adeyemi", "role": "Design Engineer", "links": ""}',
    );
    fake.deliver(candidateMail(2, "Ngozi Adeyemi", "ngozi@candidates.test", "Design Engineer"));
    await syncAll();
    await drain();
    const runs = (await (
      await request(`/workflows/runs?workspace=${workspaceId}&workflow=${workflowId}`)
    ).json()) as { runs: RunView[] };
    const run = runs.runs.find((r) => r.subject === "Application: Design Engineer") as RunView;
    expect(run.status).toBe("done");
    expect(run.steps.map((s) => [s.name, s.status])).toEqual([
      ["Extract", "done"],
      ["Notion", "done"],
      ["Label", "done"],
      ["If role is Rust", "done"],
      ["Slack", "skipped"],
    ]);
    expect(run.steps[3]?.detail).toBe("No: Design Engineer");
    expect(integrations.posts.filter((p) => p.post.integration === "slack")).toHaveLength(1);
  });

  test("a Dry run reports what would happen over recent matching Threads and applies nothing", async () => {
    const before = integrations.posts.length;
    const res = await send(`/workflows/${workflowId}/dry-run`, { recent: 5 });
    expect(res.status).toBe(200);
    const preview = (await res.json()) as DryRunPreview;
    expect(preview).toMatchObject({ workflowId, version: 1, considered: 2 });
    expect(preview.threads.map((t) => t.subject).sort()).toEqual([
      "Application: Design Engineer",
      "Application: Senior Rust engineer",
    ]);
    const one = preview.threads[0] as DryRunPreview["threads"][number];
    expect(one.steps.map((s) => [s.name, s.status])).toEqual([
      ["Extract", "would_apply"],
      ["Notion", "would_apply"],
      ["Label", "would_apply"],
      ["If role is Rust", "stopped"],
      ["Slack", "skipped"],
    ]);
    expect(one.steps[1]?.detail).toBe("Add a row to Hiring: Notion Hiring");
    expect(integrations.posts).toHaveLength(before);
    expect(converse.calls).toHaveLength(4);
    const activity = (await (await request(`/activity?workspace=${workspaceId}`)).json()) as {
      activity: ActivityRecord[];
    };
    expect(activity.activity.filter((a) => a.runId?.startsWith("dry:"))).toHaveLength(0);
    // Without the Standing approval, the Dry run says the Slack step would ask.
    await send(`/workflows/${workflowId}/approvals`, { step: "slack", granted: false });
    const revoked = (await (
      await send(`/workflows/${workflowId}/dry-run`, {})
    ).json()) as DryRunPreview;
    const view = (await (await request(`/workflows/${workflowId}`)).json()) as WorkflowView;
    expect(view.standingApprovals).toEqual(["notion"]);
    expect(revoked.threads[0]?.steps[1]?.status).toBe("would_apply");
  });

  test("a version bump keeps the old Run's version and the old document", async () => {
    const doc = candidateIntake(candidatesId);
    const edited = {
      ...doc,
      steps: doc.steps.map((s) => (s.id === "slack" ? { ...s, channel: "#hiring-rust" } : s)),
    };
    const updated = await send(`/workflows/${workflowId}`, edited, "PUT");
    expect(updated.status).toBe(200);
    const view = (await updated.json()) as WorkflowView;
    expect(view.version).toBe(2);
    expect(view.steps.find((s) => s.id === "slack")).toMatchObject({ channel: "#hiring-rust" });
    expect((await runOf(runId)).version).toBe(1);
    const v1 = (await (await request(`/workflows/${workflowId}/versions/1`)).json()) as {
      version: number;
      document: { steps: Array<{ id: string; channel?: string }> };
    };
    expect(v1.document.steps.find((s) => s.id === "slack")?.channel).toBe("#hiring");
    expect((await request(`/workflows/${workflowId}/versions/3`)).status).toBe(404);
  });

  test("the failure policy: stop fails the Run and skips the rest, skip carries on, and the Setting notifies", async () => {
    const make = async (policy: "stop" | "skip") => {
      const res = await send("/workflows", {
        workspace: workspaceId,
        name: `Nudge (${policy})`,
        trigger: { kind: "manual" },
        failurePolicy: policy,
        steps: [
          { id: "ping", kind: "discord", name: "Discord", channel: "#ops", text: "Run {{run.id}}" },
          { id: "note", kind: "notify", name: "Notify", text: "After Discord" },
        ],
        standingApprovals: ["ping"],
      });
      expect(res.status).toBe(201);
      const view = (await res.json()) as WorkflowView;
      await send(`/workflows/${view.id}/enable`, { enabled: true });
      return view.id;
    };
    const stopId = await make("stop");
    integrations.failNext("discord", "Discord is down");
    const started = await send(`/workflows/${stopId}/run`, {});
    expect(started.status).toBe(202);
    const run = (await started.json()) as RunView;
    expect(run).toMatchObject({ status: "queued", trigger: { kind: "manual", threadId: null } });
    // A tool that failed is a failed Activity row the ledger would answer from again, so the policy applies at once.
    expect(await drain()).toEqual([WORKFLOW_STEP_STEP]);
    const failed = await runOf(run.id);
    expect(failed.status).toBe("failed");
    expect(failed.failedStep).toBe(0);
    expect(failed.error).toBe("Discord is down");
    expect(failed.steps.map((s) => s.status)).toEqual(["failed", "skipped"]);
    const activity = (await (await request(`/workflows/runs/${run.id}/activity`)).json()) as {
      activity: ActivityRecord[];
    };
    expect(activity.activity.find((a) => a.tool === "workflow.failed")).toMatchObject({
      inputSummary: "Workflow Nudge (stop) failed at Discord",
    });
    // skip: the failing Step is skipped and the next one runs.
    const skipId = await make("skip");
    integrations.failNext("discord", "Discord is down");
    const skipRun = (await (await send(`/workflows/${skipId}/run`, {})).json()) as RunView;
    expect(await drain()).toEqual([WORKFLOW_STEP_STEP, WORKFLOW_STEP_STEP]);
    const skipped = await runOf(skipRun.id);
    expect(skipped.status).toBe("done");
    expect(skipped.steps.map((s) => [s.status, s.detail])).toEqual([
      ["skipped", "Skipped after failure: Discord is down"],
      ["done", "After Discord"],
    ]);
  });

  test("an error outside a tool gets the Jobs table's retries with backoff before the policy applies (ADR 0005)", async () => {
    const res = await send("/workflows", {
      workspace: workspaceId,
      name: "Flaky model",
      trigger: { kind: "manual" },
      steps: [
        { id: "think", kind: "agentic", name: "Think", prompt: "Say hello.", budget: { calls: 2 } },
      ],
    });
    const view = (await res.json()) as WorkflowView;
    await send(`/workflows/${view.id}/enable`, { enabled: true });
    const down = () => {
      throw new Error("model down");
    };
    converse.script(down, down, down);
    const run = (await (await send(`/workflows/${view.id}/run`, {})).json()) as RunView;
    // Attempt one throws: the Job is requeued with backoff and the Run waits, not failed.
    expect(await drain()).toEqual([`${WORKFLOW_STEP_STEP}:"failed"`]);
    const stepJob = await jobs.get(`${WORKFLOW_STEP_STEP}:${run.id}:0`);
    expect(stepJob).toMatchObject({ status: "queued", attempts: 1, lastError: "model down" });
    expect(stepJob?.runAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect((await runOf(run.id)).status).toBe("queued");
    // A later clock claims it again: attempt two throws once more, attempt three is past the retries.
    const late = createJobs(db.handle.db, { now: () => new Date(NOW.getTime() + 3_600_000) });
    intelligence.registerSteps(late);
    const claimStep = async (from: Jobs) => {
      for (let i = 0; i < 200; i++) {
        const job = await from.claim("server-b", ["needs-process"], 30_000);
        if (!job) return null;
        if (job.class === WORKFLOW_STEP_STEP) return job;
        await from.requeue(job.id, "server-b", 30 * 86_400_000);
      }
      return null;
    };
    const second = await claimStep(late);
    expect(second?.attempts).toBe(2);
    expect(await late.run(second as NonNullable<typeof second>, 30_000)).toBe("failed");
    const third = createJobs(db.handle.db, { now: () => new Date(NOW.getTime() + 7_200_000) });
    intelligence.registerSteps(third);
    const last = await claimStep(third);
    expect(last?.class).toBe(WORKFLOW_STEP_STEP);
    expect(last?.attempts).toBe(3);
    expect(await third.run(last as NonNullable<typeof last>, 30_000)).toBe("done");
    const failed = await runOf(run.id);
    expect(failed.status).toBe("failed");
    expect(failed.steps[0]).toMatchObject({ status: "failed", detail: "model down" });
    intelligence.registerSteps(jobs);
  });

  test("a declined approval applies the failure policy, and the composer's tool answers a paused Run with the card", async () => {
    const res = await send("/workflows", {
      workspace: workspaceId,
      name: "Ask first",
      trigger: { kind: "manual" },
      failurePolicy: "stop",
      steps: [
        {
          id: "hook",
          kind: "webhook",
          name: "Webhook",
          url: "https://hooks.test/x",
          body: { run: "{{run.id}}" },
        },
      ],
    });
    const view = (await res.json()) as WorkflowView;
    await send(`/workflows/${view.id}/enable`, { enabled: true });
    const run = (await (await send(`/workflows/${view.id}/run`, {})).json()) as RunView;
    await drain();
    expect((await runOf(run.id)).status).toBe("paused");
    const declined = await send(`/workflows/runs/${run.id}/approvals`, { decision: "declined" });
    expect(declined.status).toBe(200);
    await drain();
    const after = await runOf(run.id);
    expect(after.status).toBe("failed");
    expect(after.steps[0]).toMatchObject({ status: "failed", detail: "Declined by you" });
    expect(integrations.posts.filter((p) => p.post.integration === "webhook")).toHaveLength(0);
    // The Agent's approve_workflow_step tool shows the paused Step's payload and asks; approving resumes.
    const again = (await (await send(`/workflows/${view.id}/run`, {})).json()) as RunView;
    await drain();
    const tools = intelligence.agent.tools(workspaceId);
    const asked: string[] = [];
    const outcome = await tools.call(
      {
        name: "approve_workflow_step",
        args: { run_id: again.id, decision: "approved" },
        callId: "a1",
        sessionId: null,
      },
      {
        ask: async (_row, preview) => {
          asked.push(preview.kind === "text" ? preview.text : preview.kind);
          return "approved";
        },
      },
    );
    expect(outcome.isError).toBe(false);
    expect(asked[0]).toContain('Approve step "Webhook"');
    await drain();
    expect((await runOf(again.id)).status).toBe("done");
    expect(integrations.posts.filter((p) => p.post.integration === "webhook")).toHaveLength(1);
  });

  test("a scheduled Workflow is a Job that fires at the next cron minute and re-arms itself", async () => {
    const res = await send("/workflows", {
      workspace: workspaceId,
      name: "Friday digest",
      trigger: { kind: "schedule", cron: "0 16 * * fri" },
      steps: [{ id: "note", kind: "notify", name: "Notify", text: "It is Friday" }],
    });
    const view = (await res.json()) as WorkflowView;
    await send(`/workflows/${view.id}/enable`, { enabled: true });
    const armed = await jobs.get(`${WORKFLOW_SCHEDULE_STEP}:${view.id}:1`);
    expect(armed?.status).toBe("queued");
    expect(armed?.runAt.getUTCDay()).toBe(5);
    expect(armed?.runAt.getUTCHours()).toBe(16);
    expect(armed?.runAt.getTime()).toBeGreaterThan(NOW.getTime());
    // Not due yet under the frozen clock; due under a clock past it.
    expect(await drain()).toEqual([]);
    const friday = createJobs(db.handle.db, { now: () => armed?.runAt as Date });
    intelligence.registerSteps(friday);
    let job = await friday.claim("server-c", ["needs-process"], 30_000);
    while (job && job.class !== WORKFLOW_SCHEDULE_STEP) {
      await friday.requeue(job.id, "server-c", 30 * 86_400_000);
      job = await friday.claim("server-c", ["needs-process"], 30_000);
    }
    expect(job?.class).toBe(WORKFLOW_SCHEDULE_STEP);
    const result = await friday.run(job as NonNullable<typeof job>, 30_000);
    // The module's clock is frozen at NOW, so the re-arm lands on the same Friday.
    expect(typeof result === "object" && result.sleepMs).toBe(
      (armed?.runAt.getTime() as number) - NOW.getTime(),
    );
    const runs = (await (
      await request(`/workflows/runs?workspace=${workspaceId}&workflow=${view.id}`)
    ).json()) as { runs: RunView[] };
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]?.trigger).toEqual({ kind: "schedule", at: NOW.toISOString() });
    intelligence.registerSteps(jobs);
  });

  test("a Thread event off the Changes feed starts the Workflow that listens for it", async () => {
    const res = await send("/workflows", {
      workspace: workspaceId,
      name: "On archive",
      trigger: { kind: "thread_event", event: "archived" },
      steps: [{ id: "note", kind: "notify", name: "Notify", text: "Archived {{thread.subject}}" }],
    });
    const view = (await res.json()) as WorkflowView;
    await send(`/workflows/${view.id}/enable`, { enabled: true });
    const thread = await threadBySubject("Application: Design Engineer");
    const seq = await store
      .applyIntent({
        kind: "archive",
        threadId: thread.id,
        at: NOW.toISOString(),
        actor: "user",
      })
      .then(() => store.latestSeq(workspaceId));
    bus.emit({ workspaceId, seq });
    // The watcher enqueues a trigger Job from the feed row; nothing ran inline.
    await new Promise((r) => setTimeout(r, 50));
    const classes = await drain();
    expect(classes[0]).toBe(WORKFLOW_TRIGGER_STEP);
    const runs = (await (
      await request(`/workflows/runs?workspace=${workspaceId}&workflow=${view.id}`)
    ).json()) as { runs: RunView[] };
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]).toMatchObject({
      status: "done",
      trigger: { kind: "thread_event", threadId: thread.id, event: "archived" },
    });
    expect(runs.runs[0]?.steps[0]?.detail).toBe("Archived Application: Design Engineer");
  });

  test("a silence trigger checks daily and starts one Run per Thread with no reply from the user", async () => {
    const res = await send("/workflows", {
      workspace: workspaceId,
      name: "Follow-up nudge",
      trigger: { kind: "silence", days: 1 },
      steps: [
        {
          id: "draft",
          kind: "draft_reply",
          name: "Draft",
          instructions: "A short, warm follow-up.",
        },
        { id: "remind", kind: "notify", name: "Remind", text: "Follow up: {{thread.subject}}" },
      ],
    });
    expect(res.status).toBe(201);
    const view = (await res.json()) as WorkflowView;
    await send(`/workflows/${view.id}/enable`, { enabled: true });
    const armed = await jobs.get(`${WORKFLOW_SCHEDULE_STEP}:${view.id}:1`);
    expect(armed?.status).toBe("queued");
    expect(armed?.runAt.getUTCHours()).toBe(9);
    // Which fixture Threads are silent: older than a day, last word not the user's.
    const page = await store.listThreads(workspaceId, { limit: 500, includeArchived: true });
    const silent: string[] = [];
    for (const t of page.threads) {
      if (t.archived || Date.parse(t.lastActivity) >= NOW.getTime() - 86_400_000) continue;
      const last = (await store.listMessages(t.id)).at(-1);
      if (last && last.from.email.toLowerCase() === fixture.address.toLowerCase()) continue;
      silent.push(t.id);
    }
    expect(silent.length).toBeGreaterThan(0);
    expect(silent.length).toBeLessThan(page.threads.length);
    const claimSchedule = async (from: Jobs, owner: string) => {
      let job = await from.claim(owner, ["needs-process"], 30_000);
      while (job && job.class !== WORKFLOW_SCHEDULE_STEP) {
        await from.requeue(job.id, owner, 60 * 86_400_000);
        job = await from.claim(owner, ["needs-process"], 30_000);
      }
      return job;
    };
    const nine = createJobs(db.handle.db, { now: () => armed?.runAt as Date });
    intelligence.registerSteps(nine);
    const job = await claimSchedule(nine, "server-d");
    expect(job?.class).toBe(WORKFLOW_SCHEDULE_STEP);
    expect(await nine.run(job as NonNullable<typeof job>, 30_000)).toMatchObject({
      sleepMs: expect.any(Number),
    });
    const runs = (await (
      await request(`/workflows/runs?workspace=${workspaceId}&workflow=${view.id}`)
    ).json()) as { runs: RunView[] };
    expect(runs.runs.map((r) => r.threadId).sort()).toEqual(silent.sort());
    expect(runs.runs.every((r) => r.trigger.kind === "silence")).toBe(true);
    // The Steps run: a Draft in the user's voice through the draft-in-voice Task, then the reminder.
    for (let i = 0; i < 200; i++) {
      const step = await nine.claim("server-d", ["needs-process"], 30_000);
      if (!step) break;
      if (step.class !== WORKFLOW_STEP_STEP) {
        await nine.requeue(step.id, "server-d", 60 * 86_400_000);
        continue;
      }
      await nine.run(step, 30_000);
    }
    const done = (await (
      await request(`/workflows/runs?workspace=${workspaceId}&workflow=${view.id}`)
    ).json()) as { runs: RunView[] };
    const one = done.runs[0] as RunView;
    expect(one.status).toBe("done");
    expect(one.steps.map((s) => [s.name, s.status])).toEqual([
      ["Draft", "done"],
      ["Remind", "done"],
    ]);
    expect(one.steps[0]?.detail).toContain("Draft");
    expect(one.steps[1]?.detail).toBe(`Follow up: ${one.subject}`);
    // Checking again the next day starts nothing twice for the same Thread.
    const again = createJobs(db.handle.db, {
      now: () => new Date((armed?.runAt.getTime() as number) + 86_400_000),
    });
    intelligence.registerSteps(again);
    const next = await claimSchedule(again, "server-e");
    expect(next?.class).toBe(WORKFLOW_SCHEDULE_STEP);
    await again.run(next as NonNullable<typeof next>, 30_000);
    const after = (await (
      await request(`/workflows/runs?workspace=${workspaceId}&workflow=${view.id}`)
    ).json()) as { runs: RunView[] };
    expect(after.runs).toHaveLength(silent.length);
    intelligence.registerSteps(jobs);
  });

  test("the Workflow list carries the Run summary the page shows, and the Agent tools list it", async () => {
    const list = (await (await request(`/workflows?workspace=${workspaceId}`)).json()) as {
      workflows: WorkflowView[];
    };
    const intake = list.workflows.find((w) => w.id === workflowId) as WorkflowView;
    expect(intake.recent).toEqual(["done", "done"]);
    expect(intake.runsToday).toBe(2);
    expect(intake.lastRunAt).toBe(NOW.toISOString());
    expect(intake.paused).toBe(0);
    const tools = intelligence.agent.tools(workspaceId);
    const listed = await tools.call(
      { name: "list_workflows", args: {}, callId: "l1", sessionId: null },
      { ask: async () => "declined" },
    );
    expect(listed.text).toContain('"Candidate intake" v2 enabled on server');
    const dry = await tools.call(
      {
        name: "dry_run_workflow",
        args: { workflow_id: workflowId, recent: 1 },
        callId: "d1",
        sessionId: null,
      },
      { ask: async () => "declined" },
    );
    expect(dry.text).toContain("Dry run over 1 of 2 matching threads");
  });
});
