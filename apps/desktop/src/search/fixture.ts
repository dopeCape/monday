// A generated mailbox for the search tests and the 50,000-thread benchmark:
// deterministic, so a ranking assertion means the same thing on every run.
// Threads carry one to three Messages with bodies, senders from a small
// directory, and subjects and bodies drawn from word lists, plus a handful of
// planted Threads the tests reason about by id.

import type { Group, Message, Person, Thread } from "@monday/shared";
import type { Statement } from "../store/driver.ts";
import type { SeedData } from "../store/seed.ts";
import { seedStatements } from "../store/seed.ts";

export const ME: Person = { name: "Tejas", email: "tejas@genai-labs.io" };
export const KENJI: Person = { name: "Kenji Watanabe", email: "kenji.w@meridianfund.co" };
export const AOIFE: Person = { name: "Aoife Brennan", email: "aoife@northlight.dev" };

const FIRST = [
  "Mateus",
  "Ngozi",
  "Sofia",
  "Tomasz",
  "Ravi",
  "Priya",
  "Lena",
  "Omar",
  "Yuki",
  "Farah",
];
const LAST = [
  "Ferreira",
  "Adeyemi",
  "Lindqvist",
  "Kowalczyk",
  "Shankar",
  "Raghunathan",
  "Novak",
  "Haddad",
  "Tanaka",
  "Osei",
];
const DOMAINS = [
  "ferreira.design",
  "gmail.com",
  "lindqvist.se",
  "proton.me",
  "genai-labs.io",
  "northwind.co",
  "example.org",
];

const SUBJECT_WORDS = [
  "invoice",
  "roadmap",
  "candidate",
  "interview",
  "design",
  "review",
  "budget",
  "launch",
  "contract",
  "renewal",
  "offsite",
  "metrics",
  "onboarding",
  "proposal",
  "feedback",
  "release",
  "sprint",
  "hiring",
  "partnership",
  "webinar",
];
const BODY_WORDS = [
  "thanks",
  "attached",
  "the",
  "latest",
  "draft",
  "please",
  "review",
  "before",
  "friday",
  "meeting",
  "notes",
  "from",
  "yesterday",
  "we",
  "agreed",
  "to",
  "move",
  "forward",
  "with",
  "the",
  "plan",
  "let",
  "me",
  "know",
  "if",
  "anything",
  "changes",
  "happy",
  "to",
  "walk",
  "through",
  "it",
  "on",
  "a",
  "call",
  "this",
  "week",
  "best",
  "regards",
  "quick",
  "update",
  "numbers",
  "look",
  "good",
  "one",
  "open",
  "question",
  "about",
  "timeline",
  "and",
  "scope",
];

/** A small xorshift so the fixture is the same on every machine. */
export function rng(seed = 42): () => number {
  let x = seed || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 1_000_000) / 1_000_000;
  };
}

export interface GeneratedMailbox extends SeedData {
  people: Person[];
}

export interface GenerateOptions {
  threads: number;
  /** The newest activity; earlier Threads spread back over `spanDays`. */
  now?: Date;
  spanDays?: number;
  seed?: number;
  /** Bodies present on this share of Messages; the rest are headers only. */
  bodyShare?: number;
}

const pick = <T>(r: () => number, list: readonly T[]): T =>
  list[Math.floor(r() * list.length)] as T;

function words(r: () => number, list: readonly string[], n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(pick(r, list));
  return out.join(" ");
}

export function generateMailbox(options: GenerateOptions): GeneratedMailbox {
  const r = rng(options.seed ?? 42);
  const now = options.now ?? new Date("2026-09-16T10:00:00");
  const spanDays = options.spanDays ?? 800;
  const bodyShare = options.bodyShare ?? 1;
  // The planted people stay out of the random pool so a test can name them.
  const people: Person[] = [];
  for (let i = 0; i < 40; i++) {
    const first = pick(r, FIRST);
    const last = pick(r, LAST);
    people.push({
      name: `${first} ${last}`,
      email: `${first.toLowerCase()}.${last.toLowerCase()}${i}@${pick(r, DOMAINS)}`,
    });
  }
  const groups: Group[] = [
    {
      id: "hiring",
      workspaceId: "",
      parentId: null,
      name: "Hiring",
      rule: { sentence: "", predicate: {}, prompt: "" },
      threshold: null,
      briefPolicy: null,
    },
    {
      id: "finance",
      workspaceId: "",
      parentId: null,
      name: "Finance",
      rule: { sentence: "", predicate: {}, prompt: "" },
      threshold: null,
      briefPolicy: null,
    },
  ];
  const threads: Thread[] = [];
  const messages: Message[] = [];
  for (let i = 0; i < options.threads; i++) {
    const id = `t${i}`;
    const sender = pick(r, people);
    const count = 1 + Math.floor(r() * 3);
    const ageDays = r() * spanDays;
    const last = new Date(now.getTime() - ageDays * 86_400_000);
    const subject =
      `${words(r, SUBJECT_WORDS, 2 + Math.floor(r() * 3))} ${i % 7 === 0 ? "" : String(i)}`.trim();
    const group = i % 5 === 0 ? "hiring" : i % 11 === 0 ? "finance" : null;
    for (let k = 0; k < count; k++) {
      const at = new Date(last.getTime() - (count - 1 - k) * 3_600_000);
      const from = k % 2 === 0 ? sender : ME;
      const withBody = r() < bodyShare;
      messages.push({
        id: `${id}m${k}`,
        threadId: id,
        from,
        to: [from === ME ? sender : ME],
        cc: [],
        date: at.toISOString(),
        ...(withBody ? { bodyText: words(r, BODY_WORDS, 20 + Math.floor(r() * 40)) } : {}),
        attachments: [],
      });
    }
    threads.push({
      id,
      workspaceId: "",
      subject,
      participants: [sender, ME],
      lastActivity: last.toISOString(),
      messageCount: count,
      unread: i % 3 === 0,
      starred: i % 13 === 0,
      archived: i % 17 === 0,
      snoozedUntil: null,
      section: null,
      group,
      subgroup: null,
      tags: [],
      labels: [],
      hasAttachments: i % 4 === 0,
      snippet: words(r, BODY_WORDS, 8),
    });
  }
  return { threads, messages, tags: [], sections: [], groups, briefs: [], people, drafts: [] };
}

/** Plants one Thread with a single Message; `body` undefined means headers only. */
export function plant(
  box: GeneratedMailbox,
  thread: Partial<Thread> & { id: string; subject: string; lastActivity: string },
  message: { from?: Person; body?: string; to?: Person[] } = {},
): void {
  const from = message.from ?? AOIFE;
  box.threads.push({
    workspaceId: "",
    participants: [from, ME],
    messageCount: 1,
    unread: false,
    starred: false,
    archived: false,
    snoozedUntil: null,
    section: null,
    group: null,
    subgroup: null,
    tags: [],
    labels: [],
    hasAttachments: false,
    snippet: "",
    ...thread,
  });
  box.messages.push({
    id: `${thread.id}m0`,
    threadId: thread.id,
    from,
    to: message.to ?? [ME],
    cc: [],
    date: thread.lastActivity,
    ...(message.body !== undefined ? { bodyText: message.body } : {}),
    attachments: [],
  });
}

export function mailboxStatements(box: GeneratedMailbox, at?: string): Statement[] {
  return seedStatements(box, at);
}
