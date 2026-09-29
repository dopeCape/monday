// Operator parity (ADR 0015): the client and the Server read a query with one
// parser (packages/shared search-query.ts), and the Server's plaintext
// matcher (search-match.ts) finds the same Threads the Cache's FTS5 index
// does. One fixture, every body present, run through both.

import { describe, expect, test } from "bun:test";
import {
  compileMatcher,
  peopleText,
  searchTokens,
  parseQuery as sharedParse,
} from "@monday/shared";
import { bunDriver } from "../store/bun-driver.ts";
import { createFakeStore } from "../store/fake.ts";
import { FTS_MERGE_SQL } from "../store/store.ts";
import { AOIFE, generateMailbox, KENJI, mailboxStatements, plant } from "./fixture.ts";
import { createSearch } from "./index.ts";
import { parseQuery } from "./query.ts";

const NOW = new Date("2026-09-16T10:00:00");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function fixture() {
  const box = generateMailbox({ threads: 120, now: NOW, seed: 11 });
  plant(
    box,
    { id: "clause", subject: "Board observer seat", lastActivity: daysAgo(300) },
    { from: KENJI, body: "The pro-rata clause is now capped. Café terms." },
  );
  plant(
    box,
    { id: "notes", subject: "Notes from Montréal", lastActivity: daysAgo(2) },
    { from: AOIFE, body: "Kenji Watanabe said the term sheet lands Monday." },
  );
  plant(
    box,
    { id: "zebra", subject: "Zebra migration plan", lastActivity: daysAgo(40) },
    { body: "the zebra migration plan is ready for review" },
  );
  return box;
}

const QUERIES = [
  "zebra",
  "pro-rata",
  "pro",
  "kenji",
  "kenji watanabe",
  "from:kenji",
  "from:kenji.w@meridianfund.co",
  "from:aoife -from:kenji",
  "to:tejas",
  "subject:zebra",
  "subject:notes",
  '"migration plan"',
  '"plan migration"',
  "zebra -review",
  "the -zebra",
  "quarterly",
  "invoice review",
  "roadmap budget",
  "cafe",
  "montreal",
  "ridianfun",
  "thanks -friday",
  "-thanks",
];

describe("operator parity", () => {
  test("the client's parser is the shared one", () => {
    expect(parseQuery).toBe(sharedParse);
    const q = parseQuery('from:kenji "term sheet" -draft older_than:7d', { now: NOW });
    expect(q.from).toEqual([{ text: "kenji", negated: false }]);
    expect(q.phrases).toEqual([{ text: "term sheet", negated: false }]);
    expect(q.words).toEqual([{ text: "draft", negated: true }]);
    expect(q.before).not.toBeNull();
  });

  test("tokens fold case and diacritics like unicode61", () => {
    expect(searchTokens("Café, MONTRÉAL; kenji.w@meridianfund.co")).toEqual([
      "cafe",
      "montreal",
      "kenji",
      "w",
      "meridianfund",
      "co",
    ]);
  });

  test("the Server's matcher finds the Threads the Cache's index finds", async () => {
    const box = fixture();
    const fake = await createFakeStore({ driver: bunDriver(), seed: null, workspaceId: "ws" });
    await fake.store.write(mailboxStatements(box, NOW.toISOString()));
    await fake.store.query(FTS_MERGE_SQL);
    const search = createSearch({
      sources: () => [{ store: fake.store, account: "a" }],
      now: () => NOW,
    });

    const byThread = new Map<string, typeof box.messages>();
    for (const m of box.messages) {
      const list = byThread.get(m.threadId) ?? [];
      list.push(m);
      byThread.set(m.threadId, list);
    }
    for (const text of QUERIES) {
      const q = parseQuery(text, { now: NOW });
      const cache = await search.search(q, { workspace: "ws", limit: 500 });
      const local = new Set(cache.hits.map((h) => h.thread.id));
      const match = compileMatcher(q);
      const server = new Set(
        box.threads
          .filter(
            (t) =>
              match({
                subject: t.subject,
                participants: peopleText(t.participants),
                messages: (byThread.get(t.id) ?? []).map((m) => ({
                  sender: `${m.from.name} ${m.from.email}`,
                  recipients: peopleText([...m.to, ...m.cc]),
                  body: m.bodyText ?? "",
                })),
              }).matched,
          )
          .map((t) => t.id),
      );
      expect({ text, ids: [...server].sort() }).toEqual({ text, ids: [...local].sort() });
    }
  });
});
