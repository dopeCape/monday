// The batching measurement (slice 28; docs/spec/signals.md "Measure first"):
// the script's --fake mode writes every table and a verdict; the bars keep
// batching when it agrees and drop it when it drifts or when too few Threads
// are labelled; and the Sidecar's endpoint refuses unless the Setting is on,
// answers only on loopback on a Sidecar, samples the owner's mail, meters
// every request as judge.eval and returns numbers and Thread ids only.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account } from "@monday/shared";
import { and, eq } from "drizzle-orm";
import { main, parseArgs, runFake, runLive } from "../scripts/judge-batching-eval.ts";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { meter, settings as settingsTable } from "../src/db/schema.ts";
import { createIntelligence } from "../src/intelligence/index.ts";
import {
  compare,
  type EvalRun,
  summarize,
  verdictFor,
} from "../src/intelligence/measure/batching.ts";
import { renderBatchingReport, verdictLine } from "../src/intelligence/measure/report.ts";
import { createFakeChat, createFakeJudge } from "../src/intelligence/runtime/fake/index.ts";
import { createJobs } from "../src/jobs/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const TABLES = [
  "## Sample",
  "## Placement agreement with Single (repeat 1)",
  "## Accuracy on the labelled Threads",
  "## Group confidence and Needs a decision",
  "## Nouls at 0.7 and urgency",
  "## Tokens, cost and time",
  "## The bar, per batch size",
  "## Threads that placed differently",
];

describe("the batching measurement, against the fake judge", () => {
  test("--fake writes a report with every table and the verdict", async () => {
    const dir = await mkdtemp(join(tmpdir(), "monday-batching-"));
    const out = join(dir, "report.md");
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      expect(await main(["--fake", "--out", out])).toBe(0);
    } finally {
      console.log = log;
    }
    const text = await readFile(out, "utf8");
    for (const heading of TABLES) expect(text).toContain(heading);
    expect(text).toContain("| Noise floor (Single repeat 1 against repeat 2) |");
    expect(text).toContain("| Batch 10 |");
    expect(text).toContain("| Batch 50 |");
    expect(text).toContain("fake-jev");
    // The fake judge answers every Thread the same whatever shares its state: every bar holds.
    expect(lines[0]).toStartWith("VERDICT: batching passes every bar at 50");
    expect(lines[1]).toBe(`Report written to ${out}`);
    expect(text).not.toContain("—");
  });

  test("drift in large batches fails the placement bar there and keeps the smaller size", async () => {
    const report = await runFake(parseArgs(["--fake"]), (size) => (size >= 50 ? 0.1 : 0));
    const at50 = report.verdicts.find((v) => v.size === 50);
    const at10 = report.verdicts.find((v) => v.size === 10);
    expect(at50?.keep).toBe(false);
    expect(at50?.checks.find((c) => c.id === 1)?.holds).toBe(false);
    expect(at10?.keep).toBe(true);
    expect(report.recommendation).toBe(10);
    expect(report.noiseFloor.agreement).toBe(100);
    const arm50 = report.arms.find((a) => a.size === 50);
    expect(arm50?.vsSingle.differing.length).toBeGreaterThan(0);
    expect(renderBatchingReport(report)).toContain(arm50?.vsSingle.differing[0] ?? "?");
  });

  test("fewer than 30 labelled Threads is inconclusive, and batching is not kept", () => {
    const run = (size: number, repeat: number): EvalRun => ({
      size,
      repeat,
      requests: 1,
      inputTokens: 100,
      costMicros: 4,
      wallMs: 10,
      answers: new Map(
        Array.from({ length: 40 }, (_, i) => [
          `t${i}`,
          {
            outcome: "none",
            confidence: 0.9,
            nouls: { needs_reply: 0.1, waiting_on_others: 0.1, newsletter: 0.9, automated: 0.1 },
            urgency: 0,
          },
        ]),
      ),
    });
    const items = Array.from({ length: 40 }, (_, i) => ({
      id: `t${i}`,
      stratum: "newest" as const,
      facts: {
        subject: "",
        from: null,
        to: [],
        participants: [],
        headers: {},
        snippet: "",
        hasAttachments: false,
        messageCount: 1,
      },
      ...(i < 10 ? { label: { groupId: null } } : {}),
    }));
    const report = summarize([run(1, 1), run(1, 2), run(10, 1), run(10, 2)], items, {
      generatedAt: "2026-09-29T00:00:00.000Z",
      model: "jev-1.13.0",
    });
    expect(compare(run(1, 1), run(10, 1)).agreement).toBe(100);
    expect(report.verdicts[0]?.inconclusive).toBe(true);
    expect(report.verdicts[0]?.keep).toBe(false);
    expect(report.recommendation).toBeNull();
    expect(verdictLine(report)).toContain("inconclusive");
    const single = report.arms[0];
    const arm = report.arms[1];
    if (!single || !arm) throw new Error("arms missing");
    expect(
      verdictFor({ ...arm, meanConfidence: arm.meanConfidence - 0.05 }, single, report.noiseFloor)
        .checks[2]?.holds,
    ).toBe(false);
  });

  test("the script refuses a live run without its flags", () => {
    expect(() => parseArgs(["--server", "http://127.0.0.1:1"])).toThrow();
    expect(parseArgs(["--server", "http://x/", "--token", "t", "--workspace", "w"]).server).toBe(
      "http://x",
    );
  });
});

describe("the measurement endpoint on the Sidecar", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let workspaceId: string;
  const judge = createFakeJudge();
  const owner = { name: "Sam Rivera", email: "sam@monday.test" };
  const account: Account = {
    id: "acct-eval",
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
  let remote = "127.0.0.1";
  const TOKEN = "eval-token";
  let app: ReturnType<typeof createApp>;

  const setSetting = async (key: string, value: unknown) => {
    await db.handle.db
      .insert(settingsTable)
      .values({ scope: "global", deviceId: null, key, value })
      .onConflictDoUpdate({
        target: [settingsTable.scope, settingsTable.deviceId, settingsTable.key],
        set: { value },
      });
  };

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    workspaceId = (await store.createWorkspace(account)).id;
    const now = new Date("2026-09-16T12:00:00Z");
    for (let i = 0; i < 14; i++) {
      const at = new Date(now.getTime() - i * 10 * 86_400_000).toISOString();
      const from = { name: "Vendor", email: `v${i}@vendor.test` };
      const threadId = await store.upsertThread({
        workspaceId,
        providerThreadId: `t${i}`,
        subject: `Secret subject ${i}`,
        participants: [from, owner],
        lastActivity: at,
      });
      await store.upsertMessage({
        threadId,
        providerMessageId: `m${i}`,
        from,
        to: [owner],
        cc: [],
        date: at,
        headers: {},
        bodyText: "Hello",
        bodyHtml: null,
        snippet: "Hello",
      });
    }
    const intelligence = createIntelligence({
      level: async () => "automate",
      db: db.handle.db,
      mailstore: store,
      chat: createFakeChat("{}").chat,
      judge: judge.judge,
      keys: async (provider) => (provider === "typesafe" ? "ts-key" : null),
      now: () => now,
    });
    await intelligence.routing.createGroup(workspaceId, { name: "Finance", sentence: "Invoices" });
    intelligence.registerSteps(createJobs(db.handle.db));
    app = createApp({
      db: db.handle.db,
      auth: createAuth({ db: db.handle.db, sidecarToken: TOKEN }),
      mode: "sidecar",
      keys,
      mailstore: store,
      intelligence,
      remoteAddress: () => remote,
    });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  const fetchApp = async (url: string, init?: RequestInit) =>
    app.request(url.replace("http://sidecar", ""), init);

  test("refuses while ai.judge.eval_enabled is off, and off loopback", async () => {
    const res = await fetchApp("http://sidecar/intelligence/eval/batching", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ workspace: workspaceId }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("eval_disabled");
    remote = "10.0.0.2";
    try {
      const away = await fetchApp("http://sidecar/intelligence/eval/batching/x", {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      // The Sidecar's own token is refused off loopback before the route is reached.
      expect([401, 403]).toContain(away.status);
    } finally {
      remote = "127.0.0.1";
    }
  });

  test("runs the arms over the sample, meters judge.eval, returns numbers and ids only", async () => {
    await setSetting("ai.judge.eval_enabled", true);
    // Older mail is drawn inside the Backlog sort's scope; the default (3 months) holds none of it.
    await setSetting("routing.backfill.scope", "all");
    const lines: string[] = [];
    const report = await runLive(
      parseArgs([
        "--server",
        "http://sidecar",
        "--token",
        TOKEN,
        "--workspace",
        workspaceId,
        "--sample",
        "9",
        "--poll",
        "1",
      ]),
      {
        fetch: fetchApp,
        sleep: () => new Promise((r) => setTimeout(r, 20)),
        log: (l) => lines.push(l),
      },
    );
    expect(report.sample.total).toBe(9);
    expect(report.arms.map((a) => a.size)).toEqual([1, 10, 50]);
    // Single asks every Thread alone, twice; each batch arm fits the whole sample in one request.
    expect(report.arms[0]?.requests).toBe(9);
    expect(report.arms[1]?.requests).toBe(1);
    const json = JSON.stringify(report);
    expect(json).not.toContain("Secret subject");
    expect(json).not.toContain("vendor.test");
    const rows = await db.handle.db
      .select()
      .from(meter)
      .where(and(eq(meter.workspaceId, workspaceId), eq(meter.task, "judge.eval")));
    expect(rows.length).toBe(9 * 2 + 1 * 2 + 1 * 2);
  });

  test("a Server that is not a Sidecar has no such route", async () => {
    const cloud = createApp({
      db: db.handle.db,
      auth: createAuth({ db: db.handle.db, sidecarToken: TOKEN }),
      mode: "container",
      mailstore: store,
      remoteAddress: () => "127.0.0.1",
    });
    const res = await cloud.request("/intelligence/eval/batching/x", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});
