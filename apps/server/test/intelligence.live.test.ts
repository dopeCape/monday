// Opt-in: the real Hosted runtime against Anthropic. Runs only when
// ANTHROPIC_API_KEY is in the environment (never read from a file, never
// hardcoded); skipped otherwise. Proves slice 11's "done when" end to end:
// a Brief for the fixture Thread produced by Haiku 4.5 through LangChain,
// stored under the envelope, with a Meter row whose cost came from the
// price Setting and the tokens Anthropic reported.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account } from "@monday/shared";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { createIntelligence, type Intelligence } from "../src/intelligence/index.ts";
import { createJobs, type Jobs } from "../src/jobs/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const API_KEY = process.env.ANTHROPIC_API_KEY;

const account: Account = {
  id: "acct-live",
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

describe.skipIf(!API_KEY)("Hosted runtime against Anthropic (ANTHROPIC_API_KEY set)", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let jobs: Jobs;
  let intelligence: Intelligence;
  let workspaceId = "";
  let threadId = "";

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    jobs = createJobs(db.handle.db);
    intelligence = createIntelligence({ db: db.handle.db, mailstore: store });
    intelligence.registerSteps(jobs);
    workspaceId = (await store.createWorkspace(account)).id;
    // The key goes through the share path, so the Job reads it from the envelope.
    await intelligence.keys.put(workspaceId, "anthropic", API_KEY as string);
    threadId = await store.upsertThread({
      workspaceId,
      providerThreadId: "thr-live",
      subject: "Take-home review",
      participants: [{ name: "Aoife Byrne", email: "aoife@northwind.test" }],
      lastActivity: "2026-09-16T12:00:00.000Z",
    });
    await store.upsertMessage({
      threadId,
      providerMessageId: "msg-live-1",
      from: { name: "Aoife Byrne", email: "aoife@northwind.test" },
      to: [{ name: "Me", email: "me@example.test" }],
      cc: [],
      date: "2026-09-16T12:00:00.000Z",
      headers: {},
      bodyText:
        "Hi,\n\nThe panel scored Mateo's take-home 4 of 5. Can you give me a yes or no by Friday so the offer goes out next week? The only open question is whether we hire at senior or staff.\n\nAoife",
      bodyHtml: null,
      snippet: "The panel scored the take-home 4 of 5.",
    });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  test("Haiku 4.5 writes the Brief for the fixture Thread and the Meter shows its cost", async () => {
    const jobId = await intelligence.briefs.enqueue(workspaceId, threadId);
    const job = await jobs.claim("live", ["needs-process"], 60_000);
    expect(job?.id).toBe(jobId);
    const outcome = await jobs.run(job as NonNullable<typeof job>, 60_000);
    if (outcome === "failed") throw new Error((await jobs.get(jobId))?.lastError ?? "failed");
    expect(outcome).toBe("done");

    const brief = await intelligence.briefs.get(threadId);
    expect(brief).not.toBeNull();
    expect(brief?.bullets.length).toBeGreaterThanOrEqual(1);
    expect(brief?.bullets.length).toBeLessThanOrEqual(3);
    const text = JSON.stringify(brief?.bullets);
    expect(text.toLowerCase()).toMatch(/take-home|offer|friday|panel|mateo/);

    const month = await intelligence.meter.month(workspaceId, monthNow());
    expect(month.lines).toHaveLength(1);
    const line = month.lines[0];
    expect(line).toMatchObject({ task: "brief", provider: "anthropic", calls: 1 });
    expect(line?.inputTokens).toBeGreaterThan(100);
    expect(line?.outputTokens).toBeGreaterThan(10);
    expect(line?.costMicros).toBeGreaterThan(0);
    const rows = await db.handle.sql<{ model: string; job_id: string; cost_micros: string }[]>`
        select model, job_id, cost_micros from meter
      `;
    expect(rows[0]?.model).toContain("claude-haiku-4-5");
    expect(rows[0]?.job_id).toBe(jobId);
    console.error(
      `[live] ${rows[0]?.model}: ${line?.inputTokens} in, ${line?.outputTokens} out, ${line?.costMicros} micro-dollars; brief: ${text}`,
    );
  }, 120_000);
});

function monthNow(): string {
  const at = new Date();
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}
