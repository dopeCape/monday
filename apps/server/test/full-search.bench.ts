// The full search's speed on a synthetic encrypted mailbox (ADR 0015):
// 56,000 Threads, one to three Messages each, every subject, body and snippet
// sealed under the Workspace's envelope exactly as the Mailstore seals them.
// Not part of `bun test`; run it by hand:
//
//   bun test/full-search.bench.ts [threads]
//
// It starts its own embedded Postgres in a temp dir (never the Sidecar's),
// fills it, times a few queries at a few concurrencies, and stops it.

import { parseQuery } from "@monday/shared";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { createDb } from "../src/db/client.ts";
import { createMailstore } from "../src/mailstore/index.ts";
import { TEST_CLUSTER_KEY, type TestClusterGlobal } from "./cluster-key.ts";
import { testDatabase } from "./harness.ts";

const THREADS = Number(process.argv[2] ?? 56_000);
const WORDS =
  "thanks attached the latest draft please review before friday meeting notes from yesterday we agreed to move forward with plan let me know if anything changes happy walk through it on a call this week best regards quick update numbers look good one open question about budget launch contract renewal offsite metrics onboarding proposal feedback release sprint hiring partnership webinar invoice roadmap candidate interview design".split(
    " ",
  );
const PEOPLE = Array.from({ length: 400 }, (_, i) => ({
  name: `Person ${i}`,
  email: `person${i}@example${i % 37}.org`,
}));
const ME = { name: "Tejas", email: "tejas@genai-labs.io" };

let seed = 7;
const rand = () => {
  seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)] as T;
const words = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(" ");

async function main() {
  const test = await testDatabase();
  try {
    await bench(test);
  } finally {
    await test.drop().catch(() => {});
    await (globalThis as TestClusterGlobal)[TEST_CLUSTER_KEY]?.stop();
  }
}

async function bench(test: Awaited<ReturnType<typeof testDatabase>>) {
  const handle = createDb(test.url, { max: 8 });
  const keys = createKeys(handle.db);
  await keys.unlock(randomKey());
  const store = createMailstore(handle.db, keys);
  const ws = (
    await store.createWorkspace({
      id: "acct-bench",
      provider: "imap",
      address: ME.email,
      displayName: "Tejas",
      capabilities: {
        push: false,
        labels: false,
        snooze: false,
        mute: false,
        calendar: false,
        meetingLink: null,
      },
    })
  ).id;

  const fillStarted = performance.now();
  const start = Date.UTC(2014, 0, 1);
  const span = Date.UTC(2026, 8, 1) - start;
  let messageCount = 0;
  let cipherBytes = 0;
  const BATCH = 500;
  for (let b = 0; b < THREADS; b += BATCH) {
    const threadRows: Record<string, unknown>[] = [];
    const messageRows: Record<string, unknown>[] = [];
    for (let i = b; i < Math.min(THREADS, b + BATCH); i++) {
      const id = `t${i}`;
      const from = pick(PEOPLE);
      const subject = `${words(3)} ${i}`;
      const last = new Date(start + (span * i) / THREADS);
      const s = await store.storeContent(ws, "subject", subject);
      threadRows.push({
        id,
        workspace_id: ws,
        provider_thread_id: id,
        subject_enc: s.chunks[0],
        subject_key: s.key,
        subject_search: subject.slice(0, 80).toLowerCase(),
        participants: JSON.stringify([from, ME]),
        last_activity: last.toISOString(),
        message_count: 1,
        unread: i % 7 === 0,
      });
      const n = 1 + (i % 2) + (i % 5 === 0 ? 1 : 0);
      for (let m = 0; m < n; m++) {
        // Twenty old Threads say a word nothing else does.
        const planted = i % Math.floor(THREADS / 20) === 3 && m === 0 ? " quetzalcoatl" : "";
        const text = `${words(150 + Math.floor(rand() * 450))}${planted}`;
        const html = `<div style="font-family:Arial,sans-serif;font-size:14px"><p>${text.replaceAll(". ", "</p><p>")}</p><p style="color:#888">Sent from my phone</p></div>`;
        const body = await store.storeContent(ws, "body", JSON.stringify({ text, html }));
        const snippet = await store.storeContent(ws, "snippet", text.slice(0, 120));
        cipherBytes += body.chunks[0]?.length ?? 0;
        messageRows.push({
          id: `${id}m${m}`,
          thread_id: id,
          workspace_id: ws,
          provider_message_id: `${id}m${m}`,
          from: JSON.stringify(m === 0 ? from : ME),
          to: JSON.stringify(m === 0 ? [ME] : [from]),
          cc: JSON.stringify([]),
          date: new Date(last.getTime() - (n - m) * 3_600_000).toISOString(),
          headers: JSON.stringify({}),
          body_enc: body.chunks[0],
          body_key: body.key,
          snippet_enc: snippet.chunks[0],
          snippet_key: snippet.key,
        });
        messageCount += 1;
      }
    }
    await handle.sql`insert into threads ${handle.sql(threadRows as never)}`;
    await handle.sql`insert into messages ${handle.sql(messageRows as never)}`;
  }
  await handle.sql`analyze threads`;
  await handle.sql`analyze messages`;
  console.log(
    `filled ${THREADS} Threads, ${messageCount} Messages, ${(cipherBytes / 1e6).toFixed(0)} MB of body ciphertext in ${((performance.now() - fillStarted) / 1000).toFixed(1)} s`,
  );

  const time = async (q: string, pageSize: number, concurrency: number, limit = 1000) => {
    const run = await store.searchFull(ws, {
      query: parseQuery(q),
      limit,
      pageSize,
      concurrency,
    });
    let hits = 0;
    for await (const e of run) {
      if (e.type === "hit") hits += 1;
      if (e.type === "done") {
        const rate = Math.round(e.scanned / (e.elapsedMs / 1000));
        console.log(
          `${JSON.stringify(q).padEnd(28)} page ${String(pageSize).padStart(4)} x${concurrency}: ${String(hits).padStart(4)} hits, scanned ${e.scanned}/${e.total}, decrypted ${e.decrypted}, ${(e.elapsedMs / 1000).toFixed(2)} s (${rate} Threads/s)`,
        );
      }
    }
  };

  // Warm Postgres' buffers once, then measure; the defaults are 500 x 3.
  await time("quetzalcoatl", 500, 3);
  for (const concurrency of [1, 3, 6]) await time("quetzalcoatl", 500, concurrency);
  for (const pageSize of [100, 250, 1000]) await time("quetzalcoatl", pageSize, 3);
  await time("quetzalcoatl -budget", 500, 3);
  await time("meeting", 500, 3, 100);
  await time("from:person7 quetzalcoatl", 500, 3);
  await time("is:unread quetzalcoatl", 500, 3);
  await time("from:person7", 500, 3);

  await handle.close();
}

await main();
