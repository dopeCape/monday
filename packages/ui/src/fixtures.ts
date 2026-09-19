// The mock's fake data (design/js/data.js) as typed domain objects, for the
// desktop app's first render and for tests. Names and content are invented.
// Dates are local ISO strings without an offset so relative labels ("Today",
// "Mon") come out the same in any zone when paired with NOW.
import type {
  Account,
  Brief,
  DecisionCandidate,
  Draft,
  Group,
  Message,
  Person,
  Placement,
  RichText,
  Run,
  SectionRule,
  Tag,
  Thread,
  ToolCall,
  Workspace,
} from "@monday/shared";
import {
  ArchiveIcon,
  ArrowBendUpLeftIcon,
  BellIcon,
  BrainIcon,
  BroomIcon,
  CalendarBlankIcon,
  CalendarCheckIcon,
  CalendarIcon,
  CheckCircleIcon,
  ClockIcon,
  ColumnsIcon,
  EnvelopeSimpleIcon,
  FlowArrowIcon,
  GearIcon,
  GearSixIcon,
  GitBranchIcon,
  GithubLogoIcon,
  GoogleDriveLogoIcon,
  HandshakeIcon,
  HourglassIcon,
  InfoIcon,
  LightningIcon,
  MicrophoneIcon,
  NewspaperIcon,
  NotePencilIcon,
  NotionLogoIcon,
  PaperclipIcon,
  PaperPlaneTiltIcon,
  ReceiptIcon,
  SidebarSimpleIcon,
  SlackLogoIcon,
  StarIcon,
  TagIcon,
  TimerIcon,
  TrayIcon,
  UserPlusIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import type { AgentTurn, Suggestion } from "./components/agent.tsx";
import type { CommandSection } from "./components/command-palette.tsx";
import type { FlowNodeData } from "./components/flow-chain.tsx";
import type { IconComponent } from "./components/icon.tsx";
import type { NavItem, NavWorkspace } from "./components/nav-sidebar.tsx";
import type { RailItem } from "./components/rail.tsx";

/** The wall clock the fixtures are written against: Wednesday 16 Sep 2026, 10:00. */
export const NOW = new Date("2026-09-16T10:00:00");

/* ------------------------------ Workspace ------------------------------ */

export const account: Account = {
  id: "acct-genai",
  provider: "gmail",
  address: "tejas@genai-labs.io",
  displayName: "Tejas",
  capabilities: {
    push: true,
    labels: true,
    snooze: true,
    mute: true,
    calendar: true,
    meetingLink: "meet",
  },
};

export const workspace: Workspace = { id: "ws-genai", accountId: account.id };

export const navWorkspace: NavWorkspace = {
  name: "GenAI Labs",
  initials: "GL",
  status: "Synced 12 seconds ago",
};

export const accounts = ["tejas@genai-labs.io", "tejas@hey.com", "hello@monday.email"];

/* ------------------------------ People ------------------------------ */

export const people = {
  aoife: { name: "Aoife Brennan", email: "aoife@northlight.dev" },
  kenji: { name: "Kenji Watanabe", email: "kenji.w@meridianfund.co" },
  mateus: { name: "Mateus Ferreira", email: "mateus@ferreira.design" },
  ngozi: { name: "Ngozi Adeyemi", email: "ngozi.adeyemi@gmail.com" },
  sofia: { name: "Sofia Lindqvist", email: "sofia@lindqvist.se" },
  tomasz: { name: "Tomasz Kowalczyk", email: "t.kowalczyk@proton.me" },
  ravi: { name: "Ravi Shankar", email: "ravi@genai-labs.io" },
  priya: { name: "Priya Raghunathan", email: "priya@genai-labs.io" },
  hetzner: { name: "Hetzner Cloud", email: "billing@hetzner.com" },
  github: { name: "GitHub", email: "noreply@github.com" },
  stripe: { name: "Stripe", email: "receipts@stripe.com" },
  linear: { name: "Linear", email: "updates@linear.app" },
  bytes: { name: "Bytes Newsletter", email: "bytes@ui.dev" },
  me: { name: "Tejas", email: "tejas@genai-labs.io" },
} satisfies Record<string, Person>;

const p = people;

/* ------------------------------ Tags ------------------------------ */

const tag = (id: string, name: string): Tag => ({ id, workspaceId: workspace.id, name });

export const tags: Tag[] = [
  tag("candidate", "Candidate"),
  tag("needs-reply", "Needs reply"),
  tag("investor", "Investor"),
  tag("design", "Design"),
  tag("press", "Press"),
  tag("community", "Community"),
  tag("invoice", "Invoice"),
  tag("review", "Review"),
  tag("receipt", "Receipt"),
  tag("newsletter", "Newsletter"),
];

export function tagsOf(thread: Thread): Tag[] {
  return thread.tags.flatMap((id) => tags.filter((t) => t.id === id));
}

/* ------------------------------ Sections ------------------------------ */

const section = (id: string, name: string, order: number, sentence: string): SectionRule => ({
  id,
  workspaceId: workspace.id,
  name,
  order,
  rule: { sentence, predicate: {}, prompt: sentence },
  hidden: false,
});

export const sections: SectionRule[] = [
  section(
    "needs-reply",
    "Needs your reply",
    0,
    "Threads waiting on a reply from me, sorted by urgency",
  ),
  section("waiting", "Waiting on you", 1, "Threads where someone is waiting on something from me"),
  section("fyi", "For your information", 2, "Notices and updates that need no reply"),
  section("newsletters", "Newsletters", 3, "Newsletters and digests, auto-archived after 7 days"),
];

/* ------------------------------ Groups ------------------------------ */

const group = (
  id: string,
  parentId: string | null,
  name: string,
  sentence: string,
  predicate: Group["rule"]["predicate"] = {},
): Group => ({
  id,
  workspaceId: workspace.id,
  parentId,
  name,
  rule: { sentence, predicate, prompt: sentence },
  threshold: null,
  briefPolicy: null,
});

export const groups: Group[] = [
  group(
    "hiring",
    null,
    "Hiring",
    "Emails from people applying to a role, replying to a job post, or sent by a recruiter. Looks for CVs, portfolio links and role names from careers.genai-labs.io.",
    { domains: ["careers.genai-labs.io"] },
  ),
  group("candidates", "hiring", "Candidates", "First contact and take-home submissions"),
  group("interviews", "hiring", "Interviews", "Scheduling threads and calendar replies"),
  group("rejected", "hiring", "Rejected", "Threads where we declined, auto-archived after 30 days"),
  group(
    "finance",
    null,
    "Finance",
    "Invoices, receipts and payment notices. Anything with an amount and a vendor, or from billing@, receipts@, Stripe or Hetzner.",
    { senders: ["billing@hetzner.com", "receipts@stripe.com"] },
  ),
  group("invoices", "finance", "Invoices", "Money we owe"),
  group("receipts", "finance", "Receipts", "Money already paid"),
  group(
    "investors",
    null,
    "Investors",
    "Anyone at Meridian Fund, Kestrel Ventures or Ada Capital, plus threads mentioning term sheets, SAFE notes or cap tables.",
    { domains: ["meridianfund.co"] },
  ),
  group(
    "community",
    null,
    "Community",
    "GitHub notifications for monday-email/*, Discord digests, and people writing in about self-hosting or contributing.",
    { senders: ["noreply@github.com"] },
  ),
  group("press", null, "Press", "Journalists, podcast hosts and interview requests."),
];

/** Confidence per top-level Group, for the Routing page. */
export const groupConfidence: Record<string, number> = {
  hiring: 0.94,
  finance: 0.98,
  investors: 0.91,
  community: 0.89,
};

export const groupIcons: Record<string, IconComponent> = {
  hiring: UsersThreeIcon,
  finance: ReceiptIcon,
  investors: HandshakeIcon,
  community: GithubLogoIcon,
  press: MicrophoneIcon,
  candidates: UserPlusIcon,
  interviews: CalendarIcon,
  rejected: ArchiveIcon,
  invoices: ReceiptIcon,
  receipts: CheckCircleIcon,
};

export const groupIcon = (g: Group): IconComponent | undefined => groupIcons[g.id];

/* ------------------------------ Threads and Messages ------------------------------ */

interface ThreadSeed {
  id: string;
  from: Person;
  to: Person[];
  at: string;
  unread: boolean;
  subject: string;
  snippet: string;
  tags: string[];
  attachments: boolean;
  section: string | null;
  group: string | null;
  subgroup: string | null;
  starred?: boolean;
}

const thread = (s: ThreadSeed, messageCount: number): Thread => ({
  id: s.id,
  workspaceId: workspace.id,
  subject: s.subject,
  participants: [s.from, ...s.to],
  lastActivity: s.at,
  messageCount,
  unread: s.unread,
  starred: s.starred ?? false,
  archived: false,
  snoozedUntil: null,
  section: s.section,
  group: s.group,
  subgroup: s.subgroup,
  tags: s.tags,
  labels: [],
  hasAttachments: s.attachments,
  snippet: s.snippet,
});

interface MessageSeed {
  id: string;
  threadId: string;
  from: Person;
  to: Person[];
  date: string;
  body: string;
  attachments?: Array<{ id: string; name: string; size: number; mediaType: string }>;
}

const message = (s: MessageSeed): Message => ({
  id: s.id,
  threadId: s.threadId,
  from: s.from,
  to: s.to,
  cc: [],
  date: s.date,
  bodyText: s.body,
  attachments: s.attachments ?? [],
});

const KB = 1024;

export const messages: Message[] = [
  message({
    id: "m1a",
    threadId: "e1",
    from: p.aoife,
    to: [p.me],
    date: "2026-09-14T14:02:00",
    body: "Thanks for sending the brief. I will have it back by Wednesday.",
  }),
  message({
    id: "m1b",
    threadId: "e1",
    from: p.me,
    to: [p.aoife],
    date: "2026-09-14T15:10:00",
    body: "No rush, take the time you need. Looking forward to it.",
  }),
  message({
    id: "m1c",
    threadId: "e1",
    from: p.aoife,
    to: [p.me],
    date: "2026-09-16T09:41:00",
    body: [
      "Hi Tejas,",
      "I have finished the take-home. The repo is public at github.com/aoifeb/mail-sync-rs and I attached a short write-up covering the sync model, back-pressure handling, and what I would change with more time.",
      "The most interesting call was choosing a pull-based cursor per mailbox over a single global cursor. Happy to walk you through it on a call this week, I am free Wednesday or Thursday after 14:00 CET.",
      "Best,\nAoife",
    ].join("\n\n"),
    attachments: [
      { id: "a1", name: "take-home-writeup.pdf", size: 214 * KB, mediaType: "application/pdf" },
      { id: "a2", name: "sync-model.png", size: 88 * KB, mediaType: "image/png" },
    ],
  }),
  message({
    id: "m2a",
    threadId: "e2",
    from: p.kenji,
    to: [p.me, p.ravi],
    date: "2026-09-16T08:15:00",
    body: [
      "Tejas, Ravi,",
      "Attached v3 of the term sheet with our two changes marked. The pro-rata clause is now capped at 1x and we moved to a board observer seat, which is standard for us at this stage.",
      "Everything else matches what we agreed on the call. If we can close on this by Friday we keep the original date.",
      "Kenji",
    ].join("\n\n"),
    attachments: [
      {
        id: "a3",
        name: "term-sheet-v3-redline.docx",
        size: 96 * KB,
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    ],
  }),
  message({
    id: "m3a",
    threadId: "e3",
    from: p.ngozi,
    to: [p.me],
    date: "2026-09-15T17:20:00",
    body: [
      "Hello,",
      "I saw the Design Engineer opening on your site. I have spent the last three years at a fintech building the design system and internal tooling around it, including a Figma plugin that generates tokens for our web and mobile apps.",
      "Portfolio and CV attached. I would love to talk about what you are building.",
      "Ngozi",
    ].join("\n\n"),
    attachments: [
      { id: "a4", name: "ngozi-adeyemi-cv.pdf", size: 180 * KB, mediaType: "application/pdf" },
    ],
  }),
  message({
    id: "m3b",
    threadId: "e3",
    from: p.ngozi,
    to: [p.me],
    date: "2026-09-15T17:25:00",
    body: "Forgot to add: the Figma plugin is open source at github.com/ngoziadeyemi/tokenforge.",
  }),
  message({
    id: "m4a",
    threadId: "e4",
    from: p.mateus,
    to: [p.me],
    date: "2026-09-15T11:05:00",
    body: [
      "Hey Tejas,",
      "Round 2 is up in Figma. I went with 1.5px strokes throughout and squared off the terminals as we discussed. The 12 new glyphs for the workflow nodes are on the second page.",
      "Let me know what you think and I will start on the filled variants.",
      "Mateus",
    ].join("\n\n"),
  }),
  message({
    id: "m5a",
    threadId: "e5",
    from: p.sofia,
    to: [p.me],
    date: "2026-09-15T09:30:00",
    body: [
      "Hi Tejas,",
      "We are recording a short series on people rebuilding old software categories, and an email client with an agent in it is a good fit. Would you be up for a 45 minute recording sometime in October? Remote is fine.",
      "Sofia",
    ].join("\n\n"),
  }),
  message({
    id: "m6a",
    threadId: "e6",
    from: p.tomasz,
    to: [p.me],
    date: "2026-09-14T21:14:00",
    body: [
      "Hey,",
      "I have been running monday on NixOS with my stylix palette and wrote a small home-manager module that writes monday.toml from it, so the client follows my rice automatically. Happy to upstream it if you want, it is about 80 lines.",
      "Tomasz",
    ].join("\n\n"),
  }),
  message({
    id: "m7a",
    threadId: "e7",
    from: p.hetzner,
    to: [p.me],
    date: "2026-09-14T06:00:00",
    body: "Your invoice for September 2026 for project monday-sync is available in your account. Amount: 41.60 EUR. It will be charged to your card on file within the next days.",
    attachments: [
      { id: "a5", name: "R0012345678.pdf", size: 44 * KB, mediaType: "application/pdf" },
    ],
  }),
  message({
    id: "m8a",
    threadId: "e8",
    from: p.github,
    to: [p.me],
    date: "2026-09-13T22:40:00",
    body: [
      "priya-r requested your review on pull request #142: Gmail push notifications via Pub/Sub.",
      "14 files changed, +612 / -88. All checks have passed.",
    ].join("\n\n"),
  }),
  message({
    id: "m9a",
    threadId: "e9",
    from: p.stripe,
    to: [p.me],
    date: "2026-09-13T03:12:00",
    body: "Receipt from Anthropic. Amount paid: 48.00 USD. Thanks for your business.",
    attachments: [
      { id: "a6", name: "receipt-2026-08.pdf", size: 31 * KB, mediaType: "application/pdf" },
    ],
  }),
  message({
    id: "m10a",
    threadId: "e10",
    from: p.bytes,
    to: [p.me],
    date: "2026-09-12T14:00:00",
    body: "This week: Tauri 2.x, native webviews, and why everyone is shipping desktop again.",
  }),
  message({
    id: "m11a",
    threadId: "e11",
    from: p.linear,
    to: [p.me],
    date: "2026-09-12T08:00:00",
    body: "Your team closed 12 issues this week. 3 are waiting on your review.",
  }),
];

export function messagesOf(threadId: string): Message[] {
  return messages.filter((m) => m.threadId === threadId);
}

const seeds: ThreadSeed[] = [
  {
    id: "e1",
    from: p.aoife,
    to: [p.me],
    at: "2026-09-16T09:41:00",
    unread: true,
    subject: "Re: Senior Rust engineer role, take-home submitted",
    snippet:
      "Attached the repo link and a short write-up. Happy to walk through the design decisions on a call this week.",
    tags: ["candidate", "needs-reply"],
    attachments: true,
    section: "needs-reply",
    group: "hiring",
    subgroup: "candidates",
  },
  {
    id: "e2",
    from: p.kenji,
    to: [p.me, p.ravi],
    at: "2026-09-16T08:15:00",
    unread: true,
    subject: "Term sheet redline, v3",
    snippet:
      "Two changes from our side: the pro-rata clause and the board observer seat. Everything else matches what we discussed.",
    tags: ["investor", "needs-reply"],
    attachments: true,
    section: "needs-reply",
    group: "investors",
    subgroup: null,
    starred: true,
  },
  {
    id: "e3",
    from: p.ngozi,
    to: [p.me],
    at: "2026-09-15T17:25:00",
    unread: false,
    subject: "Application: Design Engineer",
    snippet:
      "I saw the opening on your site. Portfolio and CV attached, I have been building design tooling at a fintech for three years.",
    tags: ["candidate"],
    attachments: true,
    section: "needs-reply",
    group: "hiring",
    subgroup: "candidates",
  },
  {
    id: "e4",
    from: p.mateus,
    to: [p.me],
    at: "2026-09-15T11:05:00",
    unread: false,
    subject: "Icon set round 2",
    snippet:
      "Pushed the second round to Figma. Went with 1.5px strokes throughout and squared off the terminals like you asked.",
    tags: ["design"],
    attachments: false,
    section: "waiting",
    group: null,
    subgroup: null,
  },
  {
    id: "e5",
    from: p.sofia,
    to: [p.me],
    at: "2026-09-15T09:30:00",
    unread: false,
    subject: "Podcast invite: building email clients in 2026",
    snippet:
      "We are recording a series on people rebuilding old software categories. Would you be up for 45 minutes in October?",
    tags: ["press"],
    attachments: false,
    section: "waiting",
    group: "press",
    subgroup: null,
  },
  {
    id: "e6",
    from: p.tomasz,
    to: [p.me],
    at: "2026-09-14T21:14:00",
    unread: false,
    subject: "NixOS module for monday",
    snippet:
      "I wrote a home-manager module that generates monday.toml from the stylix palette. Want it upstream?",
    tags: ["community"],
    attachments: false,
    section: "fyi",
    group: "community",
    subgroup: null,
  },
  {
    id: "e7",
    from: p.hetzner,
    to: [p.me],
    at: "2026-09-14T06:00:00",
    unread: false,
    subject: "Invoice 2026-09 for project monday-sync",
    snippet:
      "Your invoice for September is available. Amount: 41.60 EUR. It will be charged to your card on file.",
    tags: ["invoice"],
    attachments: true,
    section: "fyi",
    group: "finance",
    subgroup: "invoices",
  },
  {
    id: "e8",
    from: p.github,
    to: [p.me],
    at: "2026-09-13T22:40:00",
    unread: false,
    subject: "[monday-email/sync] PR #142: Gmail push notifications via Pub/Sub",
    snippet: "priya-r requested your review on this pull request.",
    tags: ["review"],
    attachments: false,
    section: "fyi",
    group: "community",
    subgroup: null,
  },
  {
    id: "e9",
    from: p.stripe,
    to: [p.me],
    at: "2026-09-13T03:12:00",
    unread: false,
    subject: "Your receipt from Anthropic, 48.00 USD",
    snippet: "Receipt for API usage in August.",
    tags: ["receipt"],
    attachments: true,
    section: "fyi",
    group: "finance",
    subgroup: "receipts",
  },
  {
    id: "e10",
    from: p.bytes,
    to: [p.me],
    at: "2026-09-12T14:00:00",
    unread: false,
    subject: "Bytes #412: the return of the desktop app",
    snippet: "Tauri 2.x, native webviews, and why everyone is shipping desktop again.",
    tags: ["newsletter"],
    attachments: false,
    section: "newsletters",
    group: null,
    subgroup: null,
  },
  {
    id: "e11",
    from: p.linear,
    to: [p.me],
    at: "2026-09-12T08:00:00",
    unread: false,
    subject: "Weekly digest: 12 issues completed",
    snippet: "Your team closed 12 issues this week. 3 are waiting on your review.",
    tags: ["newsletter"],
    attachments: false,
    section: "newsletters",
    group: null,
    subgroup: null,
  },
];

export const threads: Thread[] = seeds.map((s) => thread(s, messagesOf(s.id).length));

/* ------------------------------ Needs a decision ------------------------------ */

/**
 * The two Threads the mock's Routing page holds in Needs a decision. Archived,
 * so they stay out of the stream and its screenshots; the Cache keeps them for
 * the queue's subject and sender.
 */
export const decisionThreads: Thread[] = [
  {
    ...thread(
      {
        id: "d1",
        from: { name: "Ola Nordmann", email: "ola@nordmann.no" },
        to: [p.me],
        at: "2026-09-15T16:20:00",
        unread: true,
        subject: "Quick question about your open roles",
        snippet: "Saw the Rust role and the community call. Which one should I write to?",
        tags: [],
        attachments: false,
        section: null,
        group: null,
        subgroup: null,
      },
      1,
    ),
    archived: true,
  },
  {
    ...thread(
      {
        id: "d2",
        from: { name: "Deel", email: "no-reply@deel.com" },
        to: [p.me],
        at: "2026-09-15T08:05:00",
        unread: false,
        subject: "Contractor payment scheduled",
        snippet: "A payment of 2,400.00 USD to Mateus Ferreira is scheduled for Friday.",
        tags: [],
        attachments: false,
        section: null,
        group: null,
        subgroup: null,
      },
      1,
    ),
    archived: true,
  },
];

/** Needs a decision as the mock shows it: candidates best first. */
export const decisions: Array<{ threadId: string; candidates: DecisionCandidate[] }> = [
  {
    threadId: "d1",
    candidates: [
      { groupId: "hiring", confidence: 0.61 },
      { groupId: "community", confidence: 0.54 },
    ],
  },
  { threadId: "d2", candidates: [{ groupId: "finance", confidence: 0.66 }] },
];

export function threadById(id: string): Thread | undefined {
  return threads.find((t) => t.id === id);
}

/** Threads in a Section, in list order. */
export function threadsIn(sectionId: string): Thread[] {
  return threads.filter((t) => t.section === sectionId);
}

/* ------------------------------ Briefs ------------------------------ */

/** Fixture markup: **bold** and _italic_ become RichText runs. */
function rich(text: string): RichText {
  const runs: RichText = [];
  const re = /\*\*(.+?)\*\*|_(.+?)_/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) runs.push(text.slice(last, m.index));
    if (m[1] !== undefined) runs.push({ b: m[1] });
    else if (m[2] !== undefined) runs.push({ i: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push(text.slice(last));
  return runs;
}

const brief = (threadId: string, bullets: string[], actions: Brief["actions"]): Brief => ({
  threadId,
  bullets: bullets.map(rich),
  actions,
  computedAt: "2026-09-16T09:42:00",
  stale: false,
});

export const briefs: Brief[] = [
  brief(
    "e1",
    [
      "**Aoife submitted the take-home** for the Senior Rust role. Repo plus a 2-page write-up.",
      "She proposes a **call this week**, available Wed or Thu after 14:00 CET.",
      "Routed to **Hiring › Candidates**. Workflow _Candidate intake_ already posted the summary to Notion.",
    ],
    [
      {
        kind: "reply",
        label: "Reply with Thursday 15:00",
        proposedLine: "Thursday 15:00 CET works for me.",
      },
      { kind: "forward", label: "Forward to Priya", to: p.priya },
      {
        kind: "calendar",
        label: "Add to interview calendar",
        eventTitle: "Aoife Brennan, take-home",
        start: "2026-09-17T15:00:00",
      },
    ],
  ),
  brief(
    "e2",
    [
      "**Two redlines**: pro-rata rights capped at 1x, and a board observer seat instead of a full seat.",
      "Kenji wants a **reply by Friday** to keep the closing date.",
      "Ravi is cc'd and has not replied yet.",
    ],
    [
      {
        kind: "reply",
        label: "Draft acceptance of pro-rata cap",
        proposedLine: "Draft acceptance of pro-rata cap",
      },
      { kind: "forward", label: "Ask Ravi for a read", to: p.ravi },
      { kind: "snooze", label: "Snooze until Thursday", until: "2026-09-17T09:00:00" },
    ],
  ),
  brief(
    "e3",
    [
      "Ngozi applied for **Design Engineer**. Three years at a fintech building internal design tooling.",
      "Portfolio links to a component library and a Figma plugin.",
      "No reply from us yet, **2 days old**.",
    ],
    [
      {
        kind: "reply",
        label: "Send screening questions",
        proposedLine: "Send screening questions",
      },
      {
        kind: "calendar",
        label: "Schedule intro call",
        eventTitle: "Intro call with Ngozi",
        start: "2026-09-18T11:00:00",
      },
      { kind: "reply", label: "Decline politely", proposedLine: "Decline politely" },
    ],
  ),
  brief(
    "e4",
    [
      "Round 2 of the icon set is in Figma with **1.5px strokes** and squared terminals.",
      "Mateus is waiting on **your review** of the 12 new glyphs.",
      "Invoice for round 1 is still unpaid (see Finance › Invoices).",
    ],
    [
      { kind: "open-link", url: "https://figma.com", label: "Open Figma file" },
      {
        kind: "reply",
        label: "Reply: looks good, ship it",
        proposedLine: "Reply: looks good, ship it",
      },
      {
        kind: "reply",
        label: "Ask for outlined variants",
        proposedLine: "Ask for outlined variants",
      },
    ],
  ),
  brief(
    "e5",
    [
      "Invite to a 45 min podcast recording in October.",
      "Series is about rebuilding old software categories.",
      "No date proposed yet.",
    ],
    [
      {
        kind: "reply",
        label: "Accept and propose dates",
        proposedLine: "Accept and propose dates",
      },
      {
        kind: "reply",
        label: "Ask for the audience size",
        proposedLine: "Ask for the audience size",
      },
      { kind: "archive", label: "Archive" },
    ],
  ),
  brief(
    "e6",
    [
      "Tomasz built a home-manager module that generates monday.toml from a Stylix palette.",
      "Asks whether to open a PR upstream.",
      "Good candidate for the docs.",
    ],
    [
      { kind: "reply", label: "Reply: yes, open a PR", proposedLine: "Reply: yes, open a PR" },
      { kind: "reply", label: "Ask for a screenshot", proposedLine: "Ask for a screenshot" },
    ],
  ),
  brief(
    "e7",
    [
      "September invoice for the sync server: 41.60 EUR.",
      "Auto-charged, nothing to do.",
      "Workflow Invoices to Drive saved the PDF.",
    ],
    [
      { kind: "open-link", url: "attachment:a5", label: "Open PDF" },
      {
        kind: "forward",
        label: "Forward to accounting",
        to: { name: "Accounting", email: "accounting@genai-labs.io" },
      },
    ],
  ),
  brief(
    "e8",
    [
      "Priya opened PR #142 adding Gmail Pub/Sub push notifications to the sync server.",
      "Requested your review, 14 files changed.",
      "CI is green.",
    ],
    [
      {
        kind: "open-link",
        url: "https://github.com/monday-email/sync/pull/142",
        label: "Open on GitHub",
      },
    ],
  ),
  brief(
    "e9",
    ["Anthropic API receipt for August: 48.00 USD.", "Filed under Finance › Receipts."],
    [{ kind: "open-link", url: "attachment:a6", label: "Open PDF" }],
  ),
  brief(
    "e10",
    [
      "Issue on the desktop app comeback, mentions Tauri 2.x.",
      "3 min read according to the agent.",
    ],
    [{ kind: "archive", label: "Archive" }],
  ),
  brief(
    "e11",
    ["12 issues closed, 3 waiting on you."],
    [{ kind: "open-link", url: "https://linear.app", label: "Open Linear" }],
  ),
];

export function briefOf(threadId: string): Brief | undefined {
  return briefs.find((b) => b.threadId === threadId);
}

/** The Agent's draft openers per Thread, offered under the reply box. */
export const replySuggestions: Record<string, string[]> = {
  e1: [
    "Confirm Thursday 15:00 CET",
    "Ask for a 30 min slot Wednesday",
    "Thank and say we will review first",
  ],
  e2: [
    "Accept both changes",
    "Accept pro-rata, push back on observer seat",
    "Ask for a call before Friday",
  ],
  e3: ["Invite to a 30 min intro call", "Send the screening questions", "Thank and decline"],
  e4: ["Approve and ask for filled variants", "Request two changes", "Schedule a review call"],
  e5: ["Accept, propose two October dates", "Ask for more details", "Decline"],
  e6: ["Yes please, open a PR", "Ask to see the module first"],
};

/* ------------------------------ Navigation ------------------------------ */

export const folders: NavItem[] = [
  { key: "inbox", label: "Inbox", icon: TrayIcon, count: 14 },
  { key: "starred", label: "Starred", icon: StarIcon, count: 3 },
  { key: "snoozed", label: "Snoozed", icon: ClockIcon, count: 5 },
  { key: "drafts", label: "Drafts", icon: NotePencilIcon, count: 2 },
  { key: "sent", label: "Sent", icon: PaperPlaneTiltIcon },
  { key: "archive", label: "Archive", icon: ArchiveIcon },
];

export const calendarNav: NavItem = { key: "calendar", label: "Calendar", icon: CalendarBlankIcon };

export const automationNav: NavItem[] = [
  { key: "workflows", label: "Workflows", icon: FlowArrowIcon },
  { key: "routing", label: "Routing", icon: GitBranchIcon },
];

/** Unread counts per Group, as the sidebar shows them. */
export const counts: Record<string, number> = {
  hiring: 6,
  candidates: 4,
  interviews: 2,
  finance: 2,
  invoices: 1,
  receipts: 1,
  investors: 1,
  community: 3,
};

export const railItems: RailItem[] = [
  { key: "inbox", icon: TrayIcon, title: "Inbox" },
  { key: "hiring", icon: UsersThreeIcon, title: "Hiring" },
  { key: "finance", icon: ReceiptIcon, title: "Finance" },
  { key: "investors", icon: HandshakeIcon, title: "Investors" },
];

export const railTail: RailItem[] = [
  { key: "calendar", icon: CalendarBlankIcon, title: "Calendar" },
  { key: "workflows", icon: FlowArrowIcon, title: "Workflows" },
  { key: "routing", icon: GitBranchIcon, title: "Routing" },
  { key: "settings", icon: GearSixIcon, title: "Settings" },
];

export const sectionIcons: Record<string, IconComponent> = {
  "needs-reply": ArrowBendUpLeftIcon,
  waiting: HourglassIcon,
  fyi: InfoIcon,
  newsletters: NewspaperIcon,
};

/* ------------------------------ Workflows ------------------------------ */

export interface WorkflowFixture {
  id: string;
  name: string;
  enabled: boolean;
  placement: Placement;
  description: string;
  flow: FlowNodeData[];
  lastRun: string;
  today: number;
}

export const workflows: WorkflowFixture[] = [
  {
    id: "w1",
    name: "Candidate intake",
    enabled: true,
    placement: "server",
    description:
      "When a candidate emails about any open role, extract name, role and links, post a summary to the Hiring Notion database, label the thread and ping #hiring on Slack if the role is Rust.",
    flow: [
      {
        kind: "trig",
        icon: EnvelopeSimpleIcon,
        label: "Email arrives",
        detail: "matches Hiring › Candidates",
      },
      { kind: "act", icon: BrainIcon, label: "Extract", detail: "name, role, links" },
      { kind: "act", icon: NotionLogoIcon, label: "Notion", detail: "add row to Hiring" },
      { kind: "cond", icon: GitBranchIcon, label: "If role is Rust" },
      { kind: "act", icon: SlackLogoIcon, label: "Slack", detail: "#hiring" },
    ],
    lastRun: "9 min ago",
    today: 3,
  },
  {
    id: "w2",
    name: "Invoices to Drive",
    enabled: true,
    placement: "server",
    description:
      "Save every invoice or receipt PDF into Google Drive under Finance/2026, rename it to vendor-date-amount, and reply to accounting on the first of each month with the list.",
    flow: [
      { kind: "trig", icon: PaperclipIcon, label: "Attachment", detail: "PDF in Finance" },
      { kind: "act", icon: BrainIcon, label: "Read", detail: "vendor, date, amount" },
      { kind: "act", icon: GoogleDriveLogoIcon, label: "Drive", detail: "Finance/2026" },
      { kind: "trig", icon: CalendarBlankIcon, label: "1st of month" },
      { kind: "act", icon: PaperPlaneTiltIcon, label: "Send", detail: "monthly list" },
    ],
    lastRun: "Mon 06:01",
    today: 0,
  },
  {
    id: "w3",
    name: "Investor follow-up nudge",
    enabled: true,
    placement: "local",
    description:
      "If an email in Investors has no reply from me after 2 working days, draft a follow-up in my voice and leave it in Drafts, then remind me at 9am.",
    flow: [
      { kind: "trig", icon: TimerIcon, label: "No reply", detail: "2 working days" },
      { kind: "cond", icon: GitBranchIcon, label: "If in Investors" },
      { kind: "act", icon: NotePencilIcon, label: "Draft", detail: "in my voice" },
      { kind: "act", icon: BellIcon, label: "Remind", detail: "09:00" },
    ],
    lastRun: "Fri 09:00",
    today: 0,
  },
  {
    id: "w4",
    name: "Newsletter digest",
    enabled: false,
    placement: "local",
    description:
      "Every Friday at 16:00 summarize the week's newsletters into one email to myself, then archive the originals.",
    flow: [
      { kind: "trig", icon: CalendarCheckIcon, label: "Fridays 16:00" },
      { kind: "act", icon: BrainIcon, label: "Summarize", detail: "Newsletters group" },
      { kind: "act", icon: PaperPlaneTiltIcon, label: "Send", detail: "to me" },
      { kind: "act", icon: ArchiveIcon, label: "Archive", detail: "originals" },
    ],
    lastRun: "Sep 5",
    today: 0,
  },
];

const run = (
  id: string,
  workflowId: string,
  startedAt: string,
  status: Run["status"],
  name: string,
  detail: string,
): Run => ({
  id,
  workflowId,
  workflowVersion: 1,
  startedAt,
  status,
  failedStep: status === "failed" ? 0 : null,
  log: [{ index: 0, name, status: status === "failed" ? "failed" : "done", detail, at: startedAt }],
});

export const runs: Run[] = [
  run(
    "r1",
    "w1",
    "2026-09-16T09:51:00",
    "done",
    "Aoife Brennan, Senior Rust engineer",
    "Notion row created, Slack posted to #hiring",
  ),
  run(
    "r2",
    "w1",
    "2026-09-15T17:21:00",
    "done",
    "Ngozi Adeyemi, Design Engineer",
    "Notion row created",
  ),
  run(
    "r3",
    "w1",
    "2026-09-13T10:04:00",
    "failed",
    "Unknown sender, no role detected",
    "Skipped: confidence 0.31, asked you to confirm",
  ),
  run(
    "r4",
    "w2",
    "2026-09-14T06:01:00",
    "done",
    "Hetzner, 41.60 EUR",
    "Saved as hetzner-2026-09-41.60.pdf",
  ),
  run(
    "r5",
    "w2",
    "2026-09-13T03:13:00",
    "done",
    "Anthropic, 48.00 USD",
    "Saved as anthropic-2026-08-48.00.pdf",
  ),
  run(
    "r6",
    "w3",
    "2026-09-11T09:00:00",
    "done",
    "Meridian Fund intro",
    "Draft left in Drafts, reminder fired",
  ),
  run(
    "r7",
    "w4",
    "2026-09-05T16:00:00",
    "done",
    "7 newsletters",
    "Digest sent, originals archived",
  ),
];

export function runsOf(workflowId: string): Run[] {
  return runs.filter((r) => r.workflowId === workflowId);
}

/* ------------------------------ The Agent ------------------------------ */

const call = (
  id: string,
  tool: string,
  tier: ToolCall["tier"],
  inputSummary: string,
  status: ToolCall["status"],
  result?: string,
): ToolCall => ({
  id,
  sessionId: "s1",
  runId: null,
  tool,
  tier,
  inputSummary,
  status,
  approvedBy: status === "done" && tier === "always-ask" ? "user" : null,
  undoable: tier === "reversible" && status === "done",
  ...(result === undefined ? {} : { result }),
});

/** Older Threads the search turns up that are not in the inbox list. */
export const searchResults: Thread[] = [
  ...threads.filter((t) => t.id === "e1"),
  thread(
    {
      id: "e1-prev",
      from: p.aoife,
      to: [p.me],
      at: "2026-09-14T14:02:00",
      unread: false,
      subject: "Re: Senior Rust engineer role",
      snippet: "Thanks for sending the brief. I will have it back",
      tags: ["candidate"],
      attachments: false,
      section: null,
      group: "hiring",
      subgroup: "candidates",
    },
    2,
  ),
  thread(
    {
      id: "e1-first",
      from: p.me,
      to: [p.aoife],
      at: "2026-09-08T10:12:00",
      unread: false,
      subject: "Senior Rust engineer role",
      snippet: "Hi Aoife, thanks for applying. Here is the take-home brief",
      tags: ["candidate"],
      attachments: true,
      section: null,
      group: "hiring",
      subgroup: "candidates",
    },
    1,
  ),
];

export const agentThread: AgentTurn[] = [
  {
    id: "t1",
    role: "user",
    text: "find everything from aoife about the take-home and set up a call thursday 3pm",
  },
  {
    id: "t2",
    role: "agent",
    parts: [
      { kind: "text", text: "Found 3 messages from Aoife Brennan about the take-home." },
      {
        kind: "tool",
        title: "Searched mail",
        call: call(
          "c1",
          "search_mail",
          "read-only",
          'from:aoife "take-home" · 1,204 messages scanned',
          "done",
          "3 results",
        ),
      },
      { kind: "results", threads: searchResults },
      {
        kind: "tool",
        title: "Created calendar event",
        call: call(
          "c2",
          "create_event",
          "reversible",
          "Thu Sep 18, 15:00 to 15:45 CET · Aoife Brennan, you",
          "done",
          "Done",
        ),
      },
      {
        kind: "tool",
        title: "Send reply to Aoife",
        call: call(
          "c3",
          "send_reply",
          "always-ask",
          "Confirms Thursday 15:00 CET, includes the meeting link",
          "waiting",
        ),
        preview:
          "Hi Aoife, thanks for the write-up, the cursor-per-mailbox choice is exactly what I hoped to see. Thursday 15:00 CET works, here is the link: meet.genai-labs.io/aoife",
        actions: ["Send", "Edit", "Cancel"],
      },
    ],
  },
];

export const agentThreadShort: AgentTurn[] = [
  { id: "s1", role: "user", text: "switch to gruvbox dark and make the font a bit bigger" },
  {
    id: "s2",
    role: "agent",
    parts: [
      {
        kind: "tool",
        title: "Changed appearance",
        call: call(
          "c4",
          "change_appearance",
          "reversible",
          "palette: gruvbox · theme: dark · font size: 13 → 14",
          "done",
          "Applied",
        ),
      },
      {
        kind: "text",
        text: "Done. I also wrote the change to ~/.config/monday/monday.toml so it survives restarts. Say undo to go back.",
      },
    ],
  },
];

export const agentThreadLayout: AgentTurn[] = [
  {
    id: "l1",
    role: "user",
    text: "hide the sidebar, sit on the right, and give invoice threads a forward-to-accounting button",
  },
  {
    id: "l2",
    role: "agent",
    parts: [
      {
        kind: "tool",
        title: "Changed layout",
        call: call(
          "c5",
          "change_layout",
          "reversible",
          "nav: hidden · agent: right · saved to your settings, synced to all devices",
          "done",
          "Applied",
        ),
        actions: ["Undo"],
      },
      {
        kind: "tool",
        title: "Added action to Finance › Invoices",
        call: call(
          "c6",
          "add_action",
          "reversible",
          "Reader toolbar: Forward to accounting → accounting@genai-labs.io",
          "done",
          "Applied",
        ),
      },
      {
        kind: "tool",
        title: "Saved as view",
        call: call(
          "c7",
          "save_view",
          "reversible",
          "Focus · ⌘3 · your previous layout is still ⌘1",
          "done",
          "Saved",
        ),
      },
      {
        kind: "text",
        text: "Done. I can also change what the stream sections are, what a row shows, the reader toolbar, shortcuts, or add a panel from the catalog. Say undo at any point.",
      },
    ],
  },
];

export const suggestions: Suggestion[] = [
  { label: "Reply to the 3 threads waiting on me" },
  { label: "Archive newsletters older than a week" },
  { label: "Hide the sidebar", layout: { nav: "hidden" } },
  { label: "Put the agent on the right", layout: { agent: "right" } },
];

export const suggestionIcons: Record<string, IconComponent> = {
  "Reply to the 3 threads waiting on me": LightningIcon,
  "Archive newsletters older than a week": BroomIcon,
  "Hide the sidebar": SidebarSimpleIcon,
  "Put the agent on the right": ColumnsIcon,
};

export const commands: CommandSection[] = [
  {
    label: "Ask the agent",
    items: [
      { key: "ask-reply", label: "Reply to the 3 threads waiting on me", ai: true },
      { key: "ask-missed", label: "Summarize what I missed since yesterday", ai: true },
      { key: "ask-newsletters", label: "Archive newsletters older than a week", ai: true },
    ],
  },
  {
    label: "Actions",
    items: [
      { key: "compose", label: "New message", icon: NotePencilIcon, kbd: "C" },
      { key: "archive", label: "Archive", icon: ArchiveIcon, kbd: "E" },
      { key: "snooze", label: "Snooze", icon: ClockIcon, kbd: "H" },
      { key: "label", label: "Label", icon: TagIcon, kbd: "L" },
      { key: "workflow-from-thread", label: "New workflow from this thread", icon: FlowArrowIcon },
    ],
  },
  {
    label: "Go to",
    items: [
      { key: "go-inbox", label: "Inbox", icon: TrayIcon, kbd: "G I" },
      { key: "go-candidates", label: "Hiring › Candidates", icon: UsersThreeIcon, kbd: "G H" },
      { key: "go-settings", label: "Settings", icon: GearIcon, kbd: "⌘ ," },
    ],
  },
];

/* ------------------------------ Compose ------------------------------ */

export const draft: Draft = {
  id: "d1",
  workspaceId: workspace.id,
  threadId: "e2",
  to: [p.kenji],
  cc: [],
  bcc: [],
  subject: "Re: Term sheet redline, v3",
  bodyText: [
    "Kenji,",
    "Thanks for turning v3 around quickly. The 1x pro-rata cap is fine with us.",
  ].join("\n\n"),
  bodyHtml: "",
  attachmentBlobIds: [],
  attachments: [],
  kind: "new",
  inReplyToMessageId: null,
  status: "open",
  updatedAt: "2026-09-16T09:58:00",
  updatedBy: "user",
};

export const draftGhost =
  "On the observer seat, we would prefer to keep the full board seat as discussed on the call, but are open to revisiting it at the Series A. Happy to jump on a short call before Friday if that helps close.";

export const draftNote =
  "Ravi has not replied to Kenji yet. Cc him and mention he will confirm the board point?";

/* ------------------------------ Routing page ------------------------------ */

export interface RoutedSample {
  who: string;
  subject: string;
  to: string;
}

export const recentlyRouted: RoutedSample[] = [
  {
    who: "Aoife Brennan",
    subject: "Re: Senior Rust engineer role, take-home submitted",
    to: "Candidates",
  },
  { who: "Ngozi Adeyemi", subject: "Application: Design Engineer", to: "Candidates" },
  { who: "Hetzner Cloud", subject: "Invoice 2026-09 for project monday-sync", to: "Invoices" },
  { who: "Stripe", subject: "Your receipt from Anthropic, 48.00 USD", to: "Receipts" },
  { who: "Kenji Watanabe", subject: "Term sheet redline, v3", to: "Investors" },
  { who: "Tomasz Kowalczyk", subject: "NixOS module for monday", to: "Community" },
  { who: "GitHub", subject: "[monday-email/sync] PR #142", to: "Community" },
];

export interface DecisionSample {
  who: string;
  subject: string;
  options: string[];
}

export const needsDecision: DecisionSample[] = [
  {
    who: "Ola Nordmann",
    subject: "Quick question about your open roles",
    options: ["Hiring", "Community"],
  },
  { who: "Deel", subject: "Contractor payment scheduled", options: ["Finance"] },
];
