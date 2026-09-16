// A recorded mailbox for tests: 60 Messages across four folders in 24 Threads
// with flags, a newsletter, attachments and dates spread over 120 days, all
// from a seeded generator so every run and every machine sees the same JSON.

import type { IsoDate, Person } from "@monday/shared";

export interface FixtureAttachment {
  name: string;
  mediaType: string;
  /** UTF-8 text content; enough for round trips and sizes. */
  text: string;
}

export interface FixtureMessage {
  id: string;
  mailbox: "inbox" | "archive" | "sent" | "trash" | "drafts";
  /** The Thread the generator put it in; the expected grouping for threading tests. */
  threadKey: string;
  from: Person;
  to: Person[];
  cc: Person[];
  subject: string;
  date: IsoDate;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  headers: Record<string, string>;
  text: string;
  html: string | null;
  attachments: FixtureAttachment[];
}

export interface FixtureMailbox {
  id: string;
  name: string;
  role: "inbox" | "archive" | "sent" | "trash" | "drafts";
}

export interface Fixture {
  address: string;
  owner: Person;
  /** The moment the fixture was recorded; dates are relative to it. */
  recordedAt: IsoDate;
  mailboxes: FixtureMailbox[];
  messages: FixtureMessage[];
}

export const FIXTURE_MESSAGE_COUNT = 60;

/** mulberry32: small, seedable, good enough for fixtures. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PEOPLE: Person[] = [
  { name: "Aoife Byrne", email: "aoife@northwind.test" },
  { name: "Mateo Silva", email: "mateo@lumen.test" },
  { name: "Priya Raman", email: "priya@raman.test" },
  { name: "Jonas Weber", email: "jonas@weber.test" },
  { name: "Hana Sato", email: "hana@sato.test" },
  { name: "Leila Haddad", email: "leila@haddad.test" },
  { name: "Tomás Ortega", email: "tomas@ortega.test" },
  { name: "Nadia Petrova", email: "nadia@petrova.test" },
];

const SUBJECTS = [
  "Q3 planning notes",
  "Invoice 2041 for August",
  "Can we move Thursday's call?",
  "Draft contract for review",
  "Candidate: Elin Vos, backend",
  "Office move logistics",
  "Your order has shipped",
  "Re-run of the routing rules",
  "Podcast recording slot",
  "Board deck feedback",
  "Renewal for the domain",
  "Photos from the offsite",
  "Security review findings",
  "Welcome to the team",
  "Expense report approval",
  "Trip to Lisbon",
  "Bug in the export flow",
  "Lunch next week?",
  "Design tokens v2",
  "Talk proposal deadline",
  "Holiday schedule",
  "Weekly digest",
  "Payment received",
  "Interview loop for Monday",
];

const WORDS =
  "the sync server holds one connection per account and replays the outbox in order while the client reads only from the store nothing blocks the list and search never waits on the network briefs are computed before open and every action asks first when it leaves the mailbox".split(
    " ",
  );

function sentence(random: () => number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(random() * WORDS.length)] ?? "and");
  const text = out.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function paragraph(random: () => number): string {
  const sentences = 2 + Math.floor(random() * 4);
  const parts: string[] = [];
  for (let i = 0; i < sentences; i++)
    parts.push(`${sentence(random, 6 + Math.floor(random() * 12))}.`);
  return parts.join(" ");
}

export function generateFixture(seed = 7): Fixture {
  const random = rng(seed);
  const owner: Person = { name: "Sam Rivera", email: "sam@monday.test" };
  const recordedAt = new Date("2026-09-16T12:00:00Z");
  const mailboxes: FixtureMailbox[] = [
    { id: "INBOX", name: "Inbox", role: "inbox" },
    { id: "Archive", name: "Archive", role: "archive" },
    { id: "Sent", name: "Sent", role: "sent" },
    { id: "Trash", name: "Trash", role: "trash" },
    { id: "Drafts", name: "Drafts", role: "drafts" },
  ];

  const messages: FixtureMessage[] = [];
  let counter = 0;
  const nextId = () => {
    counter += 1;
    return `m${String(counter).padStart(2, "0")}`;
  };

  // 24 Threads with lengths that sum to 60: a long tail of one-message
  // Threads and a few conversations.
  const lengths = [6, 5, 5, 4, 4, 4, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1];
  let total = 0;
  for (const length of lengths) total += length;
  if (total !== FIXTURE_MESSAGE_COUNT) throw new Error(`fixture sums to ${total}`);

  lengths.forEach((length, threadIndex) => {
    const threadKey = `t${String(threadIndex + 1).padStart(2, "0")}`;
    const subject = SUBJECTS[threadIndex % SUBJECTS.length] ?? "Untitled";
    const other = PEOPLE[Math.floor(random() * PEOPLE.length)] ?? owner;
    const third = PEOPLE[Math.floor(random() * PEOPLE.length)] ?? owner;
    const isNewsletter = threadIndex === 21;
    // Thread ages: the first Threads are recent, the last few are old (past the 90 day body window).
    const ageDays = threadIndex < 18 ? Math.floor(random() * 60) : 95 + Math.floor(random() * 25);
    const start = recordedAt.getTime() - ageDays * 86_400_000 - Math.floor(random() * 86_400_000);
    const mailbox: FixtureMessage["mailbox"] =
      threadIndex === 22 ? "trash" : threadIndex >= 14 && threadIndex < 18 ? "archive" : "inbox";

    let previous: FixtureMessage | null = null;
    for (let i = 0; i < length; i++) {
      const id = nextId();
      const fromOwner = i % 2 === 1;
      const from = isNewsletter
        ? { name: "The Weekly", email: "digest@theweekly.test" }
        : fromOwner
          ? owner
          : other;
      const to = fromOwner ? [other] : [owner];
      const cc = !fromOwner && length > 2 && i > 0 && random() > 0.5 ? [third] : [];
      const date = new Date(start + i * (3_600_000 * (2 + Math.floor(random() * 30))));
      const messageId = `${id}.${threadKey}@fixture.monday.test`;
      const text = `${paragraph(random)}\n\n${paragraph(random)}`;
      const attachments: FixtureAttachment[] = [];
      if (threadIndex === 1 && i === 0) {
        attachments.push({
          name: "invoice-2041.txt",
          mediaType: "text/plain",
          text: "Invoice 2041\nAmount due: 1,240.00 EUR\nDue: 2026-09-30\n",
        });
      }
      if (threadIndex === 3 && i === 0) {
        attachments.push(
          { name: "contract-draft.txt", mediaType: "text/plain", text: sentence(random, 80) },
          {
            name: "terms.csv",
            mediaType: "text/csv",
            text: "clause,term\n1,net 30\n2,exclusive\n",
          },
        );
      }
      const headers: Record<string, string> = {};
      if (isNewsletter) {
        headers["list-id"] = "<digest.theweekly.test>";
        headers["list-unsubscribe"] = "<https://theweekly.test/unsubscribe>";
        headers.precedence = "bulk";
      }
      const message: FixtureMessage = {
        id,
        mailbox: fromOwner && mailbox === "inbox" ? "sent" : mailbox,
        threadKey,
        from,
        to,
        cc,
        subject: i === 0 ? subject : `Re: ${subject}`,
        date: date.toISOString(),
        messageId,
        inReplyTo: previous ? previous.messageId : null,
        references: previous ? [...previous.references, previous.messageId] : [],
        seen: fromOwner || random() > 0.4,
        flagged: !fromOwner && random() > 0.85,
        answered: fromOwner ? false : i < length - 1,
        headers,
        text,
        html: random() > 0.5 ? `<p>${text.replace(/\n\n/g, "</p><p>")}</p>` : null,
        attachments,
      };
      messages.push(message);
      previous = message;
    }
  });

  return { address: owner.email, owner, recordedAt: recordedAt.toISOString(), mailboxes, messages };
}
