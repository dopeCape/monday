// A Cache three times bigger than what a list holds, for the Filter menu's
// tests: ninety Inbox Threads, thirty in each of 2026, 2025 and 2024, from
// three senders at two domains, with a fourth writing into every fifth one.
// Tests only: it loads the design fixtures and bun:sqlite.

import type { Message, Person, Thread } from "@monday/shared";
import { threads as fixtureThreads } from "@monday/ui/fixtures";
import { bunDriver } from "../../store/bun-driver.ts";
import { createFakeStore } from "../../store/fake.ts";
import { fixtureSeed } from "../../store/seed.ts";
import { createStoreInbox, type StoreInbox } from "./store-inbox.ts";

export const FILTER_TOTAL = 90;
export const FILTER_WINDOW = 10;
/** Thursday 17 September 2026, 09:00 local. */
export const FILTER_NOW = new Date(2026, 8, 17, 9, 0);
export const filterId = (i: number) => `f${String(i).padStart(2, "0")}`;
export const FILTER_SENDERS: readonly Person[] = [
  { name: "Alice Ng", email: "alice@acme.com" },
  { name: "Bob Ray", email: "Bob@Acme.com" },
  { name: "Carol Diaz", email: "carol@globex.io" },
];
export const FILTER_DAN: Person = { name: "Dan Ito", email: "dan@initech.org" };

/** f00 newest; thirty Threads a year, local days. */
export function filterWhen(i: number): Date {
  const year = 2026 - Math.floor(i / 30);
  const back = i % 30;
  return year === 2026 ? new Date(2026, 8, 16 - back, 12) : new Date(year, 5, 15 - back, 12);
}

/** Unread every other one, starred every fourth from f01, an attachment every seventh. */
export function filterThreads(): Thread[] {
  const base = fixtureThreads[0] as Thread;
  return Array.from({ length: FILTER_TOTAL }, (_, i) => ({
    ...base,
    id: filterId(i),
    subject: `Thread ${i}`,
    snippet: `Snippet ${i}`,
    participants: [FILTER_SENDERS[i % 3] as Person],
    lastActivity: filterWhen(i).toISOString(),
    unread: i % 2 === 0,
    starred: i % 4 === 1,
    hasAttachments: i % 7 === 0,
    archived: false,
    snoozedUntil: null,
    section: "fyi",
    group: null,
    subgroup: null,
    tags: [],
    labels: [],
  }));
}

export function filterMessages(): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < FILTER_TOTAL; i++) {
    const at = filterWhen(i);
    out.push({
      id: `${filterId(i)}-m1`,
      threadId: filterId(i),
      from: FILTER_SENDERS[i % 3] as Person,
      to: [{ name: "Me", email: "me@example.com" }],
      cc: [],
      date: new Date(at.getTime() - 3_600_000).toISOString(),
      attachments: [],
    });
    if (i % 5 === 0) {
      out.push({
        id: `${filterId(i)}-m2`,
        threadId: filterId(i),
        from: FILTER_DAN,
        to: [],
        cc: [],
        date: at.toISOString(),
        attachments: [],
      });
    }
  }
  return out;
}

/** The ids of the Threads a filter keeps, newest first. */
export function filterExpected(keep: (i: number) => boolean): string[] {
  return Array.from({ length: FILTER_TOTAL }, (_, i) => i)
    .filter(keep)
    .map(filterId);
}

/** A Store over that Cache and the Inbox seam holding FILTER_WINDOW rows per list. */
export async function openFilterCache(): Promise<{
  inbox: StoreInbox;
  fake: Awaited<ReturnType<typeof createFakeStore>>;
}> {
  const seed = fixtureSeed();
  seed.threads = filterThreads();
  seed.messages = filterMessages();
  seed.briefs = [];
  seed.drafts = [];
  seed.decisions = [];
  seed.decisionThreads = [];
  const fake = await createFakeStore({
    driver: bunDriver(),
    seed,
    backoff: { minMs: 5, maxMs: 20 },
  });
  const inbox = await createStoreInbox(fake.store, {
    memoryWindow: () => FILTER_WINDOW,
    owner: "me@example.com",
  });
  return { inbox, fake };
}
