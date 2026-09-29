// Templates III (slice 38): the draft_from_template Step in the Workflow
// schema and runner, the verification request and its three checks, and
// Standing approvals that require clean checks. The fixture Thread asks two
// questions; a draft that skips one is flagged "Leaves 1 unanswered", and a
// Standing approval does not send that Run: it waits with the badges on the
// approval card. A clean draft sends unattended. A Placeholder the Thread
// does not fill saves the Draft with its chips and the Run waits; a deleted
// Template fails the Step. Fake judge and fake chat at the seams.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  Account,
  ActivityRecord,
  RunView,
  TemplateChecks,
  WorkflowView,
} from "@monday/shared";
import {
  defaultSettings,
  describeStep,
  parseWorkflowInput,
  stepTier,
  templateBadges,
} from "@monday/shared";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import {
  createIntelligence,
  type Intelligence,
  WORKFLOW_STEP_STEP,
} from "../src/intelligence/index.ts";
import {
  createFakeChat,
  createFakeJudge,
  type FakeChat,
  type FakeJudge,
} from "../src/intelligence/runtime/fake/index.ts";
import type { Ask } from "../src/intelligence/templates/ask.ts";
import { detailsNotInThread, verifyDraft } from "../src/intelligence/templates/index.ts";
import { createJobs, type Jobs } from "../src/jobs/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const d = defaultSettings();
const VERIFY = {
  unsureBand: d["templates.verify.unsure_band"],
  questions: {
    asks: d["templates.verify.question.asks"],
    answers: d["templates.verify.question.answers"],
    commits: d["templates.verify.question.commits"],
    supports: d["templates.verify.question.supports"],
    supportsCriteria: {
      supported: d["templates.verify.supports.supported"],
      partly: d["templates.verify.supports.partly"],
      unsupported: d["templates.verify.supports.unsupported"],
    },
    leak: d["templates.verify.question.leak"],
  },
};
const BADGES = {
  answersAll: d["strings.templates.badge.answers_all"],
  answersSome: d["strings.templates.badge.answers_some"],
  noPromises: d["strings.templates.badge.no_promises"],
  promises: d["strings.templates.badge.promises"],
  noDetails: d["strings.templates.badge.no_details"],
  details: d["strings.templates.badge.details"],
  confidential: d["strings.templates.badge.confidential"],
  couldNotCheck: d["strings.templates.badge.could_not_check"],
};

const QUESTIONS_TEXT =
  "Hi Sam, thanks for the invoice. Can you send the W-9? When will the payment go out? Best, Priya";

function askOver(judge: FakeJudge): Ask {
  return async (state, questions) => {
    const r = await judge.judge({ model: "jev", key: "k", state, questions });
    return { answers: r.answers as never, by: "typesafe" };
  };
}

describe("the checks", () => {
  const draft = "Hi Priya,\n\nThe payment goes out on Friday. Thanks,";
  const run = (judge: FakeJudge | null) =>
    verifyDraft({
      ask: judge ? askOver(judge) : async () => null,
      workspaceId: "ws",
      newest: { from: "Priya <priya@acme.test>", text: QUESTIONS_TEXT },
      threadText: QUESTIONS_TEXT,
      template: "Hi Priya, thanks for the invoice.",
      draft,
      signature: "Sam",
      settings: VERIFY,
    });

  test("a draft that skips one of two questions leaves 1 unanswered; the rest is clean", async () => {
    const judge = createFakeJudge({
      ask_0: 0.05,
      ask_3: 0.02,
      answered_1: 0.1,
      answered_2: 0.95,
      commits_0: 0.05,
      commits_1: 0.9,
      supported_1: "supported",
      commits_2: 0.02,
      leak: 0.05,
    });
    const checks = await run(judge);
    expect(judge.calls[0]?.questions).toContain("answered_1");
    expect(judge.calls[0]?.questions).not.toContain("ask_1");
    expect(checks.answers).toEqual({
      state: "flagged",
      answered: 1,
      total: 2,
      unanswered: ["Can you send the W-9?"],
    });
    expect(checks.promises.state).toBe("clean");
    expect(checks.leaks).toEqual({ state: "clean", details: [], confidential: false });
    const badges = templateBadges(checks, BADGES).map((b) => b.text);
    expect(badges).toEqual([
      "Leaves 1 unanswered: Can you send the W-9?",
      "No new promises",
      "No outside details",
    ]);
  });

  test("a promise the thread does not support, a detail from outside, and Unsure", async () => {
    const judge = createFakeJudge({
      commits_1: 0.9,
      supported_1: "unsupported",
      leak: 0.5,
      answered_1: 0.9,
      answered_2: 0.9,
      ask_0: 0,
      ask_3: 0,
    });
    const checks = await verifyDraft({
      ask: askOver(judge),
      workspaceId: "ws",
      newest: { from: "Priya", text: QUESTIONS_TEXT },
      threadText: QUESTIONS_TEXT,
      template: "",
      draft: "Hi Priya,\n\nThe payment goes out on Friday to priya@acme.com for $4,200. Thanks,",
      signature: "Sam",
      settings: VERIFY,
    });
    expect(checks.promises).toEqual({
      state: "flagged",
      unsupported: ["The payment goes out on Friday to priya@acme.com for $4,200."],
    });
    expect(checks.leaks.details).toEqual(["priya@acme.com", "$4,200"]);
    expect(checks.leaks.state).toBe("flagged");
    expect(templateBadges(checks, BADGES)[2]?.text).toBe(
      "2 details not in the thread: priya@acme.com, $4,200",
    );
    // With no judge at all, every check the judge owns is "Could not check".
    const none = await run(null);
    expect(none.answers.state).toBe("unsure");
    expect(none.promises.state).toBe("unsure");
    expect(templateBadges(none, BADGES).map((b) => b.text)).toEqual([
      "Could not check",
      "Could not check",
      "Could not check",
    ]);
  });

  test("details not in the thread: names, addresses, amounts and references the sources do not have", () => {
    expect(
      detailsNotInThread("Hi Priya, Ravi Menon will call from +44 20 7946 0958 about INV-2291.", [
        "Priya wrote about INV-2291",
      ]),
    ).toEqual(["+44 20 7946 0958", "Ravi Menon"]);
  });
});

describe("the Step in the schema", () => {
  test("draft_from_template parses, is reversible, and describes itself", () => {
    const parsed = parseWorkflowInput({
      name: "Invoices",
      trigger: { kind: "manual" },
      steps: [
        {
          id: "reply",
          kind: "draft_from_template",
          name: "Reply",
          template: "choose",
          send: "send",
        },
      ],
      standingApprovals: ["reply"],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.steps[0]).toMatchObject({ send: "send", template: "choose" });
    expect(stepTier("draft_from_template")).toBe("reversible");
    expect(describeStep(parsed.value.steps[0] as never).detail).toBe(
      "the template that fits, sends when checked",
    );
  });
});

/* ------------------------------ The Run over Postgres ------------------------------ */

const SIDECAR_TOKEN = "per-launch-token";
const me = "sam@monday.test";
const priya = { name: "Priya Shah", email: "priya@acme.test" };
const sam = { name: "Sam Rivera", email: me };
const account: Account = {
  id: "acct-tpl3",
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

describe("draft_from_template in a Run", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let intelligence: Intelligence;
  let app: Hono<AppEnv>;
  let jobs: Jobs;
  let judge: FakeJudge;
  let chat: FakeChat;
  let workspaceId: string;
  let threadId: string;

  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${SIDECAR_TOKEN}` },
    });
  const send = (path: string, body: unknown, method = "POST") =>
    request(path, { method, body: JSON.stringify(body) });
  const drain = async (): Promise<string[]> => {
    const out: string[] = [];
    for (let i = 0; i < 20; i++) {
      const job = await jobs.claim("server-a", ["needs-process"], 30_000);
      if (!job) break;
      if (job.class !== WORKFLOW_STEP_STEP) {
        await jobs.requeue(job.id, "server-a", 600_000);
        continue;
      }
      const r = await jobs.run(job, 30_000);
      out.push(`${job.class}${r === "done" ? "" : `:${JSON.stringify(r)}`}`);
    }
    return out;
  };
  const runOf = async (id: string) =>
    (await (await request(`/workflows/runs/${id}`)).json()) as RunView;
  const activityOf = async (id: string) =>
    (
      (await (await request(`/workflows/runs/${id}/activity`)).json()) as {
        activity: ActivityRecord[];
      }
    ).activity;

  const makeWorkflow = async (name: string, step: Record<string, unknown>, standing: boolean) => {
    const res = await send("/workflows", {
      workspace: workspaceId,
      name,
      trigger: { kind: "manual" },
      steps: [{ id: "reply", name: "Reply from a template", kind: "draft_from_template", ...step }],
      standingApprovals: standing ? ["reply"] : [],
    });
    expect(res.status).toBe(201);
    const view = (await res.json()) as WorkflowView;
    await send(`/workflows/${view.id}/enable`, { enabled: true });
    return view.id;
  };

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    judge = createFakeJudge();
    chat = createFakeChat("");
    jobs = createJobs(db.handle.db);
    intelligence = createIntelligence({
      level: async () => "automate",
      db: db.handle.db,
      mailstore: store,
      chat: chat.chat,
      judge: judge.judge,
      keys: async (provider) =>
        ({ typesafe: "ts", anthropic: "sk" })[provider as "typesafe"] ?? null,
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
      providerThreadId: "thr-invoice",
      subject: "Invoice INV-2291",
      participants: [priya, sam],
      lastActivity: "2026-09-20T09:00:00.000Z",
    });
    await store.upsertMessage({
      threadId,
      providerMessageId: "msg-invoice",
      from: priya,
      to: [sam],
      cc: [],
      date: "2026-09-20T09:00:00.000Z",
      headers: {},
      bodyText: QUESTIONS_TEXT,
      bodyHtml: null,
      snippet: "thanks for the invoice",
    });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  /** The draft the model writes skips the W-9; the judge says so. */
  const scriptSkipsOne = () => {
    chat.answer(
      "Hi Priya,\n\nThanks for getting in touch. The payment goes out on Friday.\n\nThanks,",
    );
    judge.when((state) => JSON.stringify(state).includes("Thanks for getting in touch"), {
      ask_0: 0,
      ask_3: 0,
      answered_1: 0.05,
      answered_2: 0.95,
      commits_0: 0,
      commits_1: 0.05,
      commits_2: 0.9,
      supported_2: "supported",
      commits_3: 0,
      leak: 0.02,
    });
  };

  test("a draft that leaves a question unanswered shows it, and a Standing approval does not send that Run", async () => {
    scriptSkipsOne();
    const id = await makeWorkflow(
      "Thanks and send",
      { template: "t_thanks_received", send: "send" },
      true,
    );
    const run = (await (await send(`/workflows/${id}/run`, { threadId })).json()) as RunView;
    expect(await drain()).toEqual([WORKFLOW_STEP_STEP]);
    const waiting = await runOf(run.id);
    expect(waiting.status).toBe("paused");
    const step = waiting.steps[0];
    expect(step?.status).toBe("waiting");
    expect(step?.detail).toBe(
      "Waiting for your approval: Leaves 1 unanswered: Can you send the W-9?",
    );
    expect(step?.checks?.answers).toMatchObject({ state: "flagged", answered: 1, total: 2 });
    // The approval card carries the checks on the send preview.
    const rows = await activityOf(run.id);
    const sendRow = rows.find((a) => a.tool === "send_draft");
    expect(sendRow?.status).toBe("waiting");
    expect(
      (sendRow?.preview as { checks?: TemplateChecks } | null)?.checks?.answers.unanswered,
    ).toEqual(["Can you send the W-9?"]);
    // A Draft was written from the model's text, and nothing was scheduled.
    expect(rows.find((a) => a.tool === "draft_message")?.status).toBe("done");
    const sends = (await (await request(`/sends?workspace=${workspaceId}`)).json()) as {
      sends: unknown[];
    };
    expect(sends.sends).toHaveLength(0);
    // Approving by hand sends it.
    await send(`/workflows/runs/${run.id}/approvals`, { decision: "approved" });
    expect(await drain()).toEqual([WORKFLOW_STEP_STEP]);
    expect((await runOf(run.id)).status).toBe("done");
  });

  test("every check clean: the Standing approval sends unattended", async () => {
    chat.answer("Hi Priya,\n\nThe W-9 is attached and the payment goes out on Friday.\n\nThanks,");
    judge.when((state) => JSON.stringify(state).includes("The W-9 is attached"), {
      ask_0: 0,
      ask_3: 0,
      answered_1: 0.95,
      answered_2: 0.95,
      commits_0: 0,
      commits_1: 0.9,
      supported_1: "supported",
      commits_2: 0,
      leak: 0.02,
    });
    const id = await makeWorkflow(
      "Clean send",
      { template: "t_thanks_received", send: "send" },
      true,
    );
    const run = (await (await send(`/workflows/${id}/run`, { threadId })).json()) as RunView;
    await drain();
    const done = await runOf(run.id);
    expect(done.status).toBe("done");
    expect(done.steps[0]?.checks?.answers).toMatchObject({ state: "clean", answered: 2, total: 2 });
    expect((await activityOf(run.id)).find((a) => a.tool === "send_draft")?.decision).toBe(
      "standing",
    );
  });

  test("a Placeholder the Thread does not fill saves the Draft with its chip and the Run waits", async () => {
    const id = await makeWorkflow("Refund", { template: "t_refund", send: "draft" }, false);
    const run = (await (await send(`/workflows/${id}/run`, { threadId })).json()) as RunView;
    await drain();
    const waiting = await runOf(run.id);
    expect(waiting.status).toBe("paused");
    expect(waiting.steps[0]?.detail).toMatch(
      /^Could not fill (reference|company|amount|reason) from the thread$/,
    );
    const rows = await activityOf(run.id);
    const used = rows.find((a) => a.tool === "use_template");
    expect(used?.status).toBe("done");
    const draftId = used?.open?.draftId ?? "";
    const draft = (await (await request(`/drafts/${draftId}`)).json()) as { bodyHtml: string };
    expect(draft.bodyHtml).toContain('data-placeholder="reference"');
  });

  test("a draft-only Step saves the Draft with its checks; a deleted Template fails the Step", async () => {
    scriptSkipsOne();
    const id = await makeWorkflow(
      "Draft only",
      { template: "t_thanks_received", send: "draft" },
      false,
    );
    const run = (await (await send(`/workflows/${id}/run`, { threadId })).json()) as RunView;
    await drain();
    const done = await runOf(run.id);
    expect(done.status).toBe("done");
    expect(done.steps[0]?.detail).toBe("Drafted from Thanks, received");
    expect(done.steps[0]?.checks?.answers.state).toBe("flagged");

    const [made] = await intelligence.templates.store.create(workspaceId, {
      name: "Short",
      fitsWhen: "",
      kind: "reply",
      subject: null,
      body: "Thanks.",
      placeholders: [],
    });
    const gone = await makeWorkflow("Gone", { template: made?.id ?? "", send: "draft" }, false);
    await intelligence.templates.store.remove(made?.id ?? "");
    const failing = (await (await send(`/workflows/${gone}/run`, { threadId })).json()) as RunView;
    await drain();
    const failed = await runOf(failing.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe(`The template ${made?.id} no longer exists`);
  });
});
