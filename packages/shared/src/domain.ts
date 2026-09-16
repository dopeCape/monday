// Domain types. The glossary in CONTEXT.md made executable.
// Runtime-neutral: no Bun, no DOM, no Node imports.

export type Id = string;
export type IsoDate = string;

/* ------------------------------ Accounts and mail ------------------------------ */

export type Provider = "gmail" | "graph" | "jmap" | "imap";

export interface Account {
  id: Id;
  provider: Provider;
  address: string;
  displayName: string;
  /** Capabilities discovered at connect; drive native versus emulated actions. */
  capabilities: AccountCapabilities;
}

export interface AccountCapabilities {
  push: boolean;
  labels: boolean;
  snooze: boolean;
  mute: boolean;
  calendar: boolean;
  meetingLink: "meet" | "teams" | "custom" | null;
}

/** One Account is exactly one Workspace. */
export interface Workspace {
  id: Id;
  accountId: Id;
}

export interface Person {
  name: string;
  email: string;
}

export type Section = Id;
export type GroupId = Id;

export interface Thread {
  id: Id;
  workspaceId: Id;
  subject: string;
  participants: Person[];
  lastActivity: IsoDate;
  messageCount: number;
  unread: boolean;
  starred: boolean;
  archived: boolean;
  snoozedUntil: IsoDate | null;
  section: Section | null;
  group: GroupId | null;
  subgroup: GroupId | null;
  tags: Id[];
  labels: Id[];
  hasAttachments: boolean;
  snippet: string;
}

export interface Message {
  id: Id;
  threadId: Id;
  from: Person;
  to: Person[];
  cc: Person[];
  date: IsoDate;
  /** Body is only present when it is in the Cache. */
  bodyText?: string;
  bodyHtml?: string;
  attachments: Attachment[];
}

export interface Attachment {
  id: Id;
  name: string;
  size: number;
  mediaType: string;
  /** Extracted text, present when read_attachment has run. */
  text?: string;
}

export interface Draft {
  id: Id;
  workspaceId: Id;
  threadId: Id | null;
  to: Person[];
  cc: Person[];
  bcc: Person[];
  subject: string;
  bodyHtml: string;
  bodyText: string;
  attachmentBlobIds: Id[];
  updatedAt: IsoDate;
}

/** A marker owned by the Provider, synced both ways. */
export interface Label {
  id: Id;
  name: string;
  providerId: string;
}

/** A marker owned by monday, never pushed to the Provider. */
export interface Tag {
  id: Id;
  workspaceId: Id;
  name: string;
}

/* ------------------------------ Encrypted content ------------------------------ */

/**
 * What an encrypted object is. Everything body-derived goes under the envelope
 * (research 5, "What is plaintext in Postgres"); the kind is bound into the
 * ciphertext so a brief cannot be passed off as a body.
 */
export type ContentKind =
  | "body"
  | "snippet"
  | "subject"
  | "attachment"
  | "attachment-text"
  | "brief"
  | "tag-rationale"
  | "summary"
  | "embedding"
  | "credential";

/**
 * What the Mailstore persists for one encrypted object and hands back to read
 * it: the object's data key wrapped under the Workspace key, and the ciphertext
 * envelopes. Small kinds have one envelope; attachments are chunked, one
 * envelope per chunk, in order. Nothing in a ContentRef is plaintext.
 */
export interface ContentRef {
  workspaceId: Id;
  kind: ContentKind;
  /** The per-object data key, itself an envelope under the Workspace key. */
  key: Uint8Array;
  /** AEAD envelopes: version(1) | iv(12) | tag(16) | ciphertext. */
  chunks: Uint8Array[];
  /** Plaintext length in bytes. */
  size: number;
}

/* ------------------------------ Attention and routing ------------------------------ */

/** The sentence plus what monday derives from it. Used for Groups, Sections and the brief policy. */
export interface Rule {
  sentence: string;
  predicate: Predicate;
  /** Short model prompt, with Examples supplied separately. */
  prompt: string;
}

export interface Predicate {
  senders?: string[];
  domains?: string[];
  subjectPatterns?: string[];
  listIds?: string[];
  hasAttachment?: boolean;
  headers?: Record<string, string>;
}

export interface Group {
  id: GroupId;
  workspaceId: Id;
  parentId: GroupId | null;
  name: string;
  rule: Rule;
  /** Per-Group override of the route threshold; null means use the Setting. */
  threshold: number | null;
}

export interface SectionRule {
  id: Section;
  workspaceId: Id;
  name: string;
  order: number;
  rule: Rule;
  hidden: boolean;
}

/** A confirmed or corrected Thread kept as evidence for a rule. */
export interface Example {
  threadId: Id;
  target: GroupId | Section;
  positive: boolean;
}

export type Confidence = number;

/** Light inline markup for model-written text: runs of plain, bold or italic. */
export type RichRun = string | { b: string } | { i: string };
export type RichText = RichRun[];

export interface Brief {
  threadId: Id;
  /** At most three; the first says what happened, the second what is asked, the third context. */
  bullets: RichText[];
  actions: BriefAction[];
  computedAt: IsoDate;
  stale: boolean;
}

/** An action chip: the label is the Agent's wording; the payload is what runs. */
export type BriefAction = { label: string } & (
  | { kind: "reply"; proposedLine: string }
  | { kind: "forward"; to: Person }
  | { kind: "calendar"; eventTitle: string; start: IsoDate }
  | { kind: "snooze"; until: IsoDate }
  | { kind: "archive" }
  | { kind: "open-link"; url: string }
);

/* ------------------------------ The agent ------------------------------ */

export type Runtime =
  | { kind: "local"; cli: "claude-code" | "codex" | "opencode" }
  | { kind: "hosted"; provider: HostedProvider; model: string };

export type HostedProvider = "anthropic" | "gemini" | "openai" | "kimi" | "openrouter";

export type Role = "main" | "fast";

export type Task =
  | "composer"
  | "agentic-step"
  | "brief"
  | "classify"
  | "route"
  | "section"
  | "tag"
  | "draft-in-voice"
  | "summarize";

export type Tier = "always-ask" | "reversible" | "read-only";

export interface Session {
  id: Id;
  workspaceId: Id;
  runtime: Runtime;
  startedAt: IsoDate;
  lastActivity: IsoDate;
  developerMode: boolean;
}

export interface ToolCall {
  id: Id;
  sessionId: Id | null;
  runId: Id | null;
  tool: string;
  tier: Tier;
  inputSummary: string;
  status: "running" | "done" | "failed" | "waiting";
  approvedBy: "user" | "standing" | null;
  result?: string;
  undoable: boolean;
}

export interface ActivityEntry extends ToolCall {
  workspaceId: Id;
  actor: "agent" | "user" | { credential: Id };
  at: IsoDate;
}

/* ------------------------------ Automation ------------------------------ */

export type Placement = "server" | "local";

export interface Run {
  id: Id;
  workflowId: Id;
  workflowVersion: number;
  startedAt: IsoDate;
  status: "running" | "paused" | "done" | "failed";
  failedStep: number | null;
  log: RunStep[];
}

export interface RunStep {
  index: number;
  name: string;
  status: "done" | "failed" | "waiting" | "skipped";
  detail: string;
  at: IsoDate;
}

/* ------------------------------ Server and layout ------------------------------ */

export type DeploymentMode = "sidecar" | "container" | "vercel" | "netlify";

export interface Capabilities {
  protocol: number;
  mode: DeploymentMode;
  realtime: "websocket" | "sse" | "polling";
  holdsConnections: boolean;
  publicUrl: boolean;
  localRuntimes: boolean;
  /** Whether the root key is in the Server's memory. Locked servers serve headers only. */
  unlocked: boolean;
}

export type NavKnob = "full" | "rail" | "hidden";
export type AgentKnob = "bottom" | "left" | "right";
export type ListKnob = "stream" | "split";

export interface Layout {
  nav: NavKnob;
  agent: AgentKnob;
  list: ListKnob;
}

export const PRESETS: Record<"stream" | "columns" | "agent-left", Layout> = {
  stream: { nav: "full", agent: "bottom", list: "stream" },
  columns: { nav: "full", agent: "bottom", list: "split" },
  "agent-left": { nav: "rail", agent: "left", list: "split" },
};

export interface View {
  id: Id;
  name: string;
  shortcut: string | null;
  layout: Layout;
}

export type Density = "compact" | "comfortable" | "spacious";
export type ThemeMode = "system" | "light" | "dark";

export interface Device {
  id: Id;
  name: string;
  lastSeen: IsoDate;
}

/* ------------------------------ Calendar ------------------------------ */

export interface CalendarEvent {
  id: Id;
  calendarId: Id;
  title: string;
  start: IsoDate;
  end: IsoDate;
  attendees: Person[];
  link: string | null;
  status: "confirmed" | "tentative" | "cancelled";
  createdByAgent: boolean;
}
