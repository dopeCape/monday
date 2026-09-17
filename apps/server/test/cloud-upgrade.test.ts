// Slice 21's "done when", walked through the interfaces with fakes at the
// seams: a Sidecar-only install with an embedded database and one IMAP
// Account schedules a send for later; the user deploys to Vercel, the Sidecar
// copies its database into the Cloud's Postgres and this Device re-pairs with
// the Cloud URL; the Sidecar attaches to the shared database ("both" mode);
// the laptop closes, so the Sidecar's heartbeat goes stale and nothing on
// the laptop runs; the Vercel cron tick claims the send Job and the message
// leaves through the Provider.
//
// Two databases stand in for the embedded Postgres and the Cloud's; one fake
// Provider stands in for the mail server both Servers talk to; a fake clock
// drives run_at, leases and heartbeats; the Vercel worker is the serverless
// kicker's tick, exactly what the cron route calls.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, Capabilities, ScheduledSend } from "@monday/shared";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { claimableNeeds } from "../src/capabilities.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { createDb } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import { createDrafts, DELIVER_STEP, type Drafts } from "../src/drafts/index.ts";
import { cloudIsAlive, removeHeartbeat, writeHeartbeat } from "../src/heartbeat.ts";
import { createJobs, type Jobs } from "../src/jobs/index.ts";
import { createServerlessKicker, type ServerlessKicker } from "../src/kicker/serverless.ts";
import { VERCEL_MAX_DURATION_MS } from "../src/kicker/vercel.ts";
import { createMailstore } from "../src/mailstore/index.ts";
import { createCredentialStore } from "../src/providers/credentials.ts";
import {
  createFakeProvider,
  type FakeProvider,
  fakeCredentials,
  generateFixture,
} from "../src/providers/fake/index.ts";
import { createProviderRegistry } from "../src/providers/index.ts";
import { createSyncEngine, type SyncEngine } from "../src/providers/sync.ts";
import { upgradeRoutes } from "../src/routes/upgrade.ts";
import { type AttachStore, createUpgrade } from "../src/upgrade/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const SIDECAR_TOKEN = "per-launch-token";
const SIDECAR_ID = "sidecar-laptop";
const VERCEL_ID = "vercel-prod";
const SETUP_CODE = "778899";
const fixture = generateFixture(4);

function fakeClock(start = Date.parse("2026-09-17T08:00:00Z")) {
  let t = start;
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const account: Account = {
  id: "acct-laptop",
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

/** One Server's modules over one database: what an entry builds at boot. */
interface Stack {
  db: TestDatabase;
  jobs: Jobs;
  drafts: Drafts;
  sync: SyncEngine;
  app: Hono<AppEnv>;
}

function memoryAttach(): AttachStore & { value: string | null } {
  const store = {
    value: null as string | null,
    read: async () => store.value,
    write: async (url: string) => {
      store.value = url;
    },
    clear: async () => {
      store.value = null;
    },
  };
  return store;
}

describe("cloud modes and upgrade", () => {
  const clock = fakeClock();
  const rootKey = randomKey();
  let fake: FakeProvider;
  let local: TestDatabase;
  let cloudDb: TestDatabase;
  let sidecar: Stack;
  let cloud: Stack;
  let cloudKicker: ServerlessKicker;
  let workspaceId = "";
  let sendId = "";
  let deviceToken = "";
  const ranOnSidecar: string[] = [];

  /**
   * Builds a Server over a database with the fake Provider, the way
   * entry/services.ts wires the real ones. `mode` decides its need tags.
   */
  async function buildStack(
    db: TestDatabase,
    mode: "sidecar" | "vercel",
    serverId: string,
    extra: { onEnqueue?: () => void; sidecarToken?: string; setupCode?: string } = {},
  ): Promise<Stack> {
    const keys = createKeys(db.handle.db);
    await keys.unlock(rootKey);
    const mailstore = createMailstore(db.handle.db, keys);
    const credentials = createCredentialStore(db.handle.db, mailstore);
    const jobs = createJobs(db.handle.db, {
      now: clock.now,
      ...(extra.onEnqueue ? { onEnqueue: extra.onEnqueue } : {}),
    });
    const sync = createSyncEngine({
      db: db.handle.db,
      mailstore,
      providers: createProviderRegistry({ overrides: { imap: fake } }),
      credentials,
      now: clock.now,
    });
    sync.registerSteps(jobs);
    const drafts = createDrafts({ db: db.handle.db, mailstore, sync, now: clock.now });
    drafts.registerSteps(jobs);
    const auth = createAuth({
      db: db.handle.db,
      sidecarToken: extra.sidecarToken ?? null,
      setupCode: extra.setupCode ?? null,
    });
    const app = createApp({
      db: db.handle.db,
      auth,
      mode,
      keys,
      mailstore,
      drafts,
      jobs,
      sync,
      serverId,
      remoteAddress: () => (mode === "sidecar" ? "127.0.0.1" : "203.0.113.7"),
    });
    return { db, jobs, drafts, sync, app };
  }

  /** What the process kicker's loop does on the Sidecar each iteration, by the failover rule. */
  async function sidecarClaims(stack: Stack): Promise<string[]> {
    const ran: string[] = [];
    for (let i = 0; i < 10; i++) {
      const alive = await cloudIsAlive(stack.db.handle.db, SIDECAR_ID, clock.now());
      const job = await stack.jobs.claim(SIDECAR_ID, claimableNeeds("sidecar", alive), 60_000);
      if (!job) break;
      await stack.jobs.run(job, 60_000);
      ran.push(job.class);
      ranOnSidecar.push(job.class);
    }
    return ran;
  }

  const bearer = (token: string) => ({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  });

  beforeAll(async () => {
    fake = createFakeProvider(fixture);
    local = await testDatabase();
    sidecar = await buildStack(local, "sidecar", SIDECAR_ID, { sidecarToken: SIDECAR_TOKEN });
    // The install: one Account, headers synced by the Sidecar.
    const keys = createKeys(local.handle.db);
    await keys.unlock(rootKey);
    const mailstore = createMailstore(local.handle.db, keys);
    const credentials = createCredentialStore(local.handle.db, mailstore);
    workspaceId = (await mailstore.createWorkspace(account)).id;
    await credentials.store(workspaceId, account.id, fakeCredentials());
    let report = await sidecar.sync.syncAccount(account.id, { headersOnly: true });
    for (let i = 0; i < 20 && report.more; i++) {
      report = await sidecar.sync.syncAccount(account.id, { headersOnly: true });
    }
    await writeHeartbeat(local.handle.db, SIDECAR_ID, "sidecar", clock.now());
  }, 120_000);

  afterAll(async () => {
    await sidecar.sync.close();
    await cloud?.sync.close();
    await local.drop();
    await cloudDb?.drop();
  });

  test("a Sidecar-only install upgrades to Vercel, the laptop closes, and a scheduled send still goes out", async () => {
    /* ---- Sidecar only: the topology says so and a send is scheduled for later ---- */
    const before = (await (
      await sidecar.app.request("/capabilities", { headers: bearer(SIDECAR_TOKEN) })
    ).json()) as Capabilities;
    expect(before.topology).toBe("sidecar");
    expect(before.features.scheduledSendsWhileClosed).toBe(false);

    const put = await sidecar.app.request("/drafts/draft-later", {
      method: "PUT",
      headers: bearer(SIDECAR_TOKEN),
      body: JSON.stringify({
        workspace: workspaceId,
        at: clock.now().toISOString(),
        updatedBy: "laptop",
        content: {
          threadId: null,
          kind: "new",
          inReplyToMessageId: null,
          to: [{ name: "Aoife", email: "aoife@northlight.dev" }],
          cc: [],
          bcc: [],
          subject: "Sent while the laptop was closed",
          bodyText: "See you Monday.",
          bodyHtml: "<p>See you Monday.</p>",
          attachments: [],
        },
      }),
    });
    expect(put.status).toBe(200);
    const inAnHour = new Date(clock.now().getTime() + 3_600_000).toISOString();
    const scheduled = await sidecar.app.request("/drafts/draft-later/send", {
      method: "POST",
      headers: bearer(SIDECAR_TOKEN),
      body: JSON.stringify({ sendId: "send-later", at: inAnHour }),
    });
    expect(scheduled.status).toBe(200);
    sendId = ((await scheduled.json()) as { sendId: string }).sendId;
    expect(sendId).toBe("send-later");
    // The Job waits for its time; the mirror step is the only thing due now.
    const pending = await sidecar.jobs.get(sendId);
    expect(pending?.status).toBe("queued");
    expect(pending?.needs).toEqual(["needs-always-on"]);
    clock.advance(6_000);
    expect(await sidecarClaims(sidecar)).not.toContain(DELIVER_STEP);

    /* ---- Deploy: the Cloud database is empty; the Sidecar copies its own into it ---- */
    cloudDb = await testDatabase();
    const attach = memoryAttach();
    const upgrade = createUpgrade({
      mode: "sidecar",
      sourceUrl: local.url,
      connect: (url) => createDb(url, { max: 2 }),
      migrate: (sql) => migrate(sql),
      exportPath: () => "/tmp/unused.dump",
      attach,
      now: clock.now,
    });
    const sidecarWithUpgrade = createApp({
      db: local.handle.db,
      auth: createAuth({ db: local.handle.db, sidecarToken: SIDECAR_TOKEN }),
      mode: "sidecar",
      remoteAddress: () => "127.0.0.1",
      mounts: [upgradeRoutes(upgrade)],
    });
    const copied = await sidecarWithUpgrade.request("/upgrade/copy", {
      method: "POST",
      headers: bearer(SIDECAR_TOKEN),
      body: JSON.stringify({ databaseUrl: cloudDb.url }),
    });
    expect(copied.status).toBe(201);
    const tables = ((await copied.json()) as { tables: { name: string; rows: number }[] }).tables;
    expect(tables.find((t) => t.name === "scheduled_sends")?.rows).toBe(1);
    expect(tables.find((t) => t.name === "jobs")?.rows).toBeGreaterThanOrEqual(1);

    /* ---- The Vercel function boots on the shared database and its cron ticks ---- */
    let wake: (() => void) | null = null;
    cloud = await buildStack(cloudDb, "vercel", VERCEL_ID, {
      onEnqueue: () => wake?.(),
      setupCode: SETUP_CODE,
    });
    cloudKicker = createServerlessKicker({
      jobs: cloud.jobs,
      db: cloudDb.handle.db,
      serverId: VERCEL_ID,
      mode: "vercel",
      invocationLimitMs: VERCEL_MAX_DURATION_MS,
      canServe: async () =>
        claimableNeeds("vercel", await cloudIsAlive(cloudDb.handle.db, VERCEL_ID, clock.now())),
      now: clock.now,
    });
    wake = () => cloudKicker.wake();
    const firstTick = await cloudKicker.tick();
    expect(firstTick.ran).toBe(0); // the send is not due yet

    /* ---- Re-pair: this Device enters the Cloud URL and the setup code ---- */
    const paired = await cloud.app.request("/pair/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: SETUP_CODE, name: "Laptop" }),
    });
    expect(paired.status).toBe(201);
    deviceToken = ((await paired.json()) as { token: string }).token;
    const cloudCaps = (await (
      await cloud.app.request("/capabilities", { headers: bearer(deviceToken) })
    ).json()) as Capabilities;
    expect(cloudCaps.mode).toBe("vercel");
    expect(cloudCaps.topology).toBe("cloud");
    expect(cloudCaps.features.scheduledSendsWhileClosed).toBe(true);
    // The copied Draft and send are there behind the new token.
    const onCloud = (await (
      await cloud.app.request(`/sends/${sendId}`, { headers: bearer(deviceToken) })
    ).json()) as ScheduledSend;
    expect(onCloud.status).toBe("scheduled");

    /* ---- Both: the Sidecar attaches to the shared database and restarts on it ---- */
    const attached = await sidecarWithUpgrade.request("/upgrade/attach", {
      method: "POST",
      headers: bearer(SIDECAR_TOKEN),
      body: JSON.stringify({ databaseUrl: cloudDb.url }),
    });
    expect(attached.status).toBe(200);
    expect(await attached.json()).toEqual({ restartRequired: true });
    expect(attach.value).toBe(cloudDb.url);
    await sidecar.sync.close();
    sidecar = await buildStack(cloudDb, "sidecar", SIDECAR_ID, { sidecarToken: SIDECAR_TOKEN });
    await writeHeartbeat(cloudDb.handle.db, SIDECAR_ID, "sidecar", clock.now());
    const both = (await (
      await cloud.app.request("/capabilities", { headers: bearer(deviceToken) })
    ).json()) as Capabilities;
    expect(both.topology).toBe("both");
    expect(both.servers.map((s) => s.id).sort()).toEqual([SIDECAR_ID, VERCEL_ID].sort());
    expect(both.features.holdsConnections).toBe(true);

    // With the Cloud alive, the Sidecar leaves the send alone even once it is due.
    clock.advance(3_600_000);
    await writeHeartbeat(cloudDb.handle.db, SIDECAR_ID, "sidecar", clock.now());
    await writeHeartbeat(cloudDb.handle.db, VERCEL_ID, "vercel", clock.now());
    expect(await sidecarClaims(sidecar)).not.toContain(DELIVER_STEP);
    expect((await cloud.jobs.get(sendId))?.status).toBe("queued");

    /* ---- The laptop closes: no Sidecar heartbeat, no Sidecar claims ---- */
    await removeHeartbeat(cloudDb.handle.db, SIDECAR_ID);
    await sidecar.sync.close();
    const sidecarSendsBefore = fake.calls.send ?? 0;

    /* ---- The cron tick a minute later: the Vercel worker sends ---- */
    clock.advance(60_000);
    const tick = await cloudKicker.tick();
    expect(tick.ran).toBeGreaterThanOrEqual(1);
    expect(fake.calls.send).toBe(sidecarSendsBefore + 1);
    const sent = (await (
      await cloud.app.request(`/sends/${sendId}`, { headers: bearer(deviceToken) })
    ).json()) as ScheduledSend;
    expect(sent.status).toBe("sent");
    expect(sent.sentAt).toBe(clock.now().toISOString());
    expect((await cloud.jobs.get(sendId))?.status).toBe("done");
    expect(ranOnSidecar).not.toContain(DELIVER_STEP);
    expect(fake.snapshot().some((m) => m.mailboxIds.includes("Sent"))).toBe(true);
  }, 120_000);
});
