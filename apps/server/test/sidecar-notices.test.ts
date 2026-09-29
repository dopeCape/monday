// Desktop notifications the Sidecar posts itself while monday is closed
// (ADR 0013): the app's rules for new mail and waiting approvals, gated by
// the notifications.* Settings, nothing told while a client is connected (it
// tells) and nothing told twice, and what was told reported for the app. The
// source is a fake for the rules and the real database for the queries.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account } from "@monday/shared";
import { settingsSchema } from "@monday/shared";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { activity, settings, workflowRunSteps, workflowRuns, workflows } from "../src/db/schema.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import {
  type ArrivedMessage,
  approvalNotices,
  createDbNoticeSource,
  createSidecarNotices,
  mailNotices,
  type Notice,
  type NoticeSource,
  SIDECAR_NOTICE_KEYS,
  type SidecarNoticeSettings,
  type WaitingRun,
} from "../src/service/notices.ts";
import { readDeviceSettings } from "../src/settings/read.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const defaults = (): SidecarNoticeSettings =>
  Object.fromEntries(
    SIDECAR_NOTICE_KEYS.map((k) => [k, settingsSchema[k].default]),
  ) as unknown as SidecarNoticeSettings;

const NOW = new Date("2026-09-29T09:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const mail = (over: Partial<ArrivedMessage> = {}): ArrivedMessage => ({
  id: "m1",
  workspaceId: "ws1",
  address: "me@example.test",
  threadId: "t1",
  from: { name: "Kenji", email: "kenji@example.test" },
  date: minutesAgo(1),
  subject: "Term sheet",
  unread: true,
  archived: false,
  deleted: false,
  snoozed: false,
  bulk: false,
  ...over,
});

const run = (over: Partial<WaitingRun> = {}): WaitingRun => ({
  key: "r1:a1",
  workspaceId: "ws1",
  workflowName: "Invoices",
  stepIndex: 1,
  stepName: "Forward",
  what: "send message to accounting",
  subject: "Invoice 42",
  since: minutesAgo(2),
  ...over,
});

describe("the rules", () => {
  test("one new message: the sender and the subject", () => {
    expect(mailNotices([mail()], defaults(), NOW)).toEqual([
      { title: "Kenji", body: "Term sheet" },
    ]);
  });

  test("several in one Workspace are one notice; each Workspace its own", () => {
    const notices = mailNotices(
      [mail(), mail({ id: "m2" }), mail({ id: "m3", workspaceId: "ws2", address: "work@x.test" })],
      defaults(),
      NOW,
    );
    expect(notices).toEqual([
      { title: "2 new emails", body: "me@example.test" },
      { title: "Kenji", body: "Term sheet" },
    ]);
  });

  test("old mail, own sends, read, archived, deleted, snoozed and bulk stay quiet", () => {
    const quiet = [
      mail({ date: minutesAgo(30) }),
      mail({ from: { name: "Me", email: "ME@example.test" } }),
      mail({ unread: false }),
      mail({ archived: true }),
      mail({ deleted: true }),
      mail({ snoozed: true }),
      mail({ bulk: true }),
    ];
    expect(mailNotices(quiet, defaults(), NOW)).toEqual([]);
    expect(
      mailNotices(
        [mail({ bulk: true })],
        { ...defaults(), "notifications.new_mail_bulk": true },
        NOW,
      ),
    ).toHaveLength(1);
  });

  test("the switches turn mail off", () => {
    expect(mailNotices([mail()], { ...defaults(), "notifications.enabled": false }, NOW)).toEqual(
      [],
    );
    expect(mailNotices([mail()], { ...defaults(), "notifications.new_mail": false }, NOW)).toEqual(
      [],
    );
  });

  test("an approval is told once, in the app's words; old or switched off ones are marked told", () => {
    const first = approvalNotices([run()], new Set(), defaults(), NOW);
    expect(first.notices).toEqual([
      {
        title: "Invoices is waiting for your approval",
        body: "Step 2, Forward: send message to accounting",
      },
    ]);
    expect(approvalNotices([run()], first.told, defaults(), NOW).notices).toEqual([]);
    const old = approvalNotices([run({ since: minutesAgo(600) })], new Set(), defaults(), NOW);
    expect(old.notices).toEqual([]);
    expect(old.told.has("r1:a1")).toBe(true);
    const off = approvalNotices(
      [run()],
      new Set(),
      { ...defaults(), "notifications.workflow_approvals": false },
      NOW,
    );
    expect(off.notices).toEqual([]);
    expect(off.told.has("r1:a1")).toBe(true);
  });
});

describe("the loop", () => {
  function harness() {
    let now = NOW;
    let present = false;
    // The fake Changes feed: every message written, with its position.
    const feed: Array<{ seq: number; m: ArrivedMessage }> = [];
    let runs: WaitingRun[] = [];
    let settings = defaults();
    const posted: Notice[] = [];
    const source: NoticeSource = {
      async latest() {
        return feed.at(-1)?.seq ?? 0;
      },
      async arrivedAfter(cursor) {
        const out = feed.filter((f) => f.seq > cursor);
        return { messages: out.map((f) => f.m), cursor: out.at(-1)?.seq ?? cursor };
      },
      async waitingRuns() {
        return runs;
      },
    };
    const notices = createSidecarNotices({
      source,
      settings: async () => settings,
      present: () => present,
      post: async (n) => void posted.push(n),
      now: () => now,
    });
    return {
      notices,
      posted,
      set: {
        now: (d: Date) => {
          now = d;
        },
        present: (p: boolean) => {
          present = p;
        },
        arrived: (m: ArrivedMessage[]) => {
          for (const x of m) feed.push({ seq: feed.length + 1, m: x });
        },
        runs: (r: WaitingRun[]) => {
          runs = r;
        },
        settings: (s: SidecarNoticeSettings) => {
          settings = s;
        },
      },
    };
  }

  test("the first look primes: what waits at start is not news", async () => {
    const h = harness();
    h.set.runs([run()]);
    expect(await h.notices.tick()).toEqual([]);
    expect(await h.notices.tick()).toEqual([]);
    expect(h.posted).toEqual([]);
  });

  test("with the app closed it tells new mail and new approvals, once, and reports them", async () => {
    const h = harness();
    await h.notices.tick();
    h.set.arrived([mail({ date: new Date(NOW.getTime() + 1000) })]);
    h.set.runs([run({ since: NOW })]);
    const told = await h.notices.tick();
    expect(told.map((n) => n.title)).toEqual(["Kenji", "Invoices is waiting for your approval"]);
    expect(h.posted).toHaveLength(2);
    expect(await h.notices.tick()).toEqual([]);
    expect(h.notices.told()).toEqual({
      mailThrough: new Date(NOW.getTime() + 1000).toISOString(),
      approvals: ["r1:a1"],
    });
  });

  test("while the app is connected nothing is told, and nothing it saw is told later", async () => {
    const h = harness();
    await h.notices.tick();
    h.set.present(true);
    h.set.arrived([mail({ date: new Date(NOW.getTime() + 1000) })]);
    h.set.runs([run({ since: NOW })]);
    expect(await h.notices.tick()).toEqual([]);
    h.set.present(false);
    expect(await h.notices.tick()).toEqual([]);
    expect(h.posted).toEqual([]);
    expect(h.notices.told()).toEqual({ mailThrough: null, approvals: [] });
  });

  test("the Settings gate it like the app: off means nothing, and not later either", async () => {
    const h = harness();
    await h.notices.tick();
    h.set.settings({ ...defaults(), "notifications.enabled": false });
    h.set.arrived([mail({ date: new Date(NOW.getTime() + 1000) })]);
    h.set.runs([run({ since: NOW })]);
    expect(await h.notices.tick()).toEqual([]);
    h.set.settings(defaults());
    expect(await h.notices.tick()).toEqual([]);
    expect(h.posted).toEqual([]);
  });

  test("a Message written again (a flag changed) is told once", async () => {
    const h = harness();
    await h.notices.tick();
    const m = mail({ date: new Date(NOW.getTime() + 1000) });
    h.set.arrived([m]);
    expect(await h.notices.tick()).toHaveLength(1);
    h.set.arrived([m]);
    expect(await h.notices.tick()).toEqual([]);
    expect(h.posted).toHaveLength(1);
  });

  test("a Run that stopped waiting leaves the told set", async () => {
    const h = harness();
    await h.notices.tick();
    h.set.runs([run({ since: NOW })]);
    await h.notices.tick();
    expect(h.notices.told().approvals).toEqual(["r1:a1"]);
    h.set.runs([]);
    await h.notices.tick();
    expect(h.notices.told().approvals).toEqual([]);
  });
});

describe("the database source", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let workspaceId = "";
  const account: Account = {
    id: "acct-notices",
    provider: "jmap",
    address: "me@example.test",
    displayName: "Me",
    capabilities: {
      push: true,
      labels: true,
      snooze: false,
      mute: false,
      calendar: false,
      meetingLink: null,
    },
  };

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    workspaceId = (await store.createWorkspace(account)).id;
  }, 60_000);

  afterAll(async () => {
    await db.drop();
  });

  test("arrivals from the Changes feed with their Thread's state and subject", async () => {
    const source = createDbNoticeSource(db.handle.db, (id) => store.readThreadSubject(id));
    const before = await source.latest();
    const threadId = await store.upsertThread({
      workspaceId,
      providerThreadId: "T1",
      subject: "Term sheet",
      participants: [{ name: "Kenji", email: "kenji@example.test" }],
      lastActivity: new Date().toISOString(),
      unread: true,
    });
    await store.upsertMessage({
      threadId,
      providerMessageId: "M1",
      from: { name: "Kenji", email: "kenji@example.test" },
      to: [{ name: "Me", email: "me@example.test" }],
      cc: [],
      date: new Date().toISOString(),
      headers: {},
      bodyText: "Hi",
      bodyHtml: null,
      snippet: "Hi",
    });
    const got = await source.arrivedAfter(before);
    expect(got.messages).toHaveLength(1);
    expect(got.messages[0]).toMatchObject({
      workspaceId,
      address: "me@example.test",
      threadId,
      subject: "Term sheet",
      unread: true,
      archived: false,
      bulk: false,
    });
    expect((await source.arrivedAfter(got.cursor)).messages).toEqual([]);
  });

  test("paused Runs with their waiting Step and the call it waits on", async () => {
    const source = createDbNoticeSource(db.handle.db, async () => "");
    await db.handle.db.insert(workflows).values({ id: "wf1", workspaceId, name: "Invoices" });
    await db.handle.db.insert(activity).values({
      id: "act1",
      workspaceId,
      actor: "agent",
      tool: "send_message",
      summary: "to accounting",
    });
    await db.handle.db.insert(workflowRuns).values({
      id: "run1",
      workflowId: "wf1",
      workspaceId,
      version: 1,
      status: "paused",
      trigger: { kind: "manual" } as never,
      subject: "Invoice 42",
      currentStep: 1,
      waitingActivityId: "act1",
    });
    await db.handle.db.insert(workflowRunSteps).values({
      runId: "run1",
      index: 1,
      stepId: "s2",
      name: "Forward",
      kind: "tool" as never,
      status: "waiting" as never,
    });
    const runs = await source.waitingRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      key: "run1:act1",
      workflowName: "Invoices",
      stepIndex: 1,
      stepName: "Forward",
      what: "send message to accounting",
      subject: "Invoice 42",
    });
  });

  test("the local client's device Settings win over global ones and the defaults", async () => {
    await db.handle.db.insert(settings).values([
      { scope: "global", deviceId: null, key: "notifications.new_mail", value: false },
      { scope: "device", deviceId: "local", key: "notifications.new_mail", value: true },
      { scope: "device", deviceId: "other", key: "notifications.enabled", value: false },
    ]);
    const s = await readDeviceSettings(db.handle.db, "local", [
      "notifications.new_mail",
      "notifications.enabled",
      "notifications.sidecar.absent_seconds",
    ]);
    expect(s).toEqual({
      "notifications.new_mail": true,
      "notifications.enabled": true,
      "notifications.sidecar.absent_seconds": 20,
    });
  });
});
