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
  /** List mail: a List-Id, List-Unsubscribe or Precedence bulk header on any Message. Absent means unknown. */
  bulk?: boolean;
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
  /** Content-ID of an inline part (a cid: image), without angle brackets. */
  contentId?: string | null;
  inline?: boolean;
}

/** How a Draft came to be; decides the headers and the quoted history (ADR 0010). */
export type DraftKind = "new" | "reply" | "forward";

/** A compose upload: an encrypted blob the Draft references by id. */
export interface DraftAttachment {
  blobId: Id;
  name: string;
  size: number;
  mediaType: string;
}

export interface Draft {
  id: Id;
  workspaceId: Id;
  threadId: Id | null;
  kind: DraftKind;
  /** The Message a reply or forward answers, for In-Reply-To and References. */
  inReplyToMessageId: Id | null;
  to: Person[];
  cc: Person[];
  bcc: Person[];
  subject: string;
  bodyHtml: string;
  bodyText: string;
  attachmentBlobIds: Id[];
  /** Name, size and media type per blob, so the compose surface can list them. */
  attachments: DraftAttachment[];
  /** "open" while editable, "scheduled" once a send Job holds it, "sent" after delivery. */
  status: DraftStatus;
  updatedAt: IsoDate;
  /** The Device or actor that saved it last. */
  updatedBy: string;
}

export type DraftStatus = "open" | "scheduled" | "sent";

export type ScheduledSendStatus = "scheduled" | "cancelled" | "sent" | "failed";

/** Why a send Job failed, typed so the client can word it (strings.send.*). */
export type SendError =
  | { code: "too_large"; size: number; limit: number }
  | { code: "no_recipients" }
  | { code: "failed"; message: string };

/** One press of Send: a send Job with a run time and an undo window (ADR 0010). */
export interface ScheduledSend {
  id: Id;
  workspaceId: Id;
  draftId: Id;
  runAt: IsoDate;
  status: ScheduledSendStatus;
  cancelledAt: IsoDate | null;
  sentAt: IsoDate | null;
  jobId: Id | null;
  error: SendError | null;
  createdAt: IsoDate;
}

/** A per-Workspace description of how the user writes, built from sent mail on opt-in. */
export interface VoiceProfile {
  workspaceId: Id;
  description: string;
  excerpts: string[];
  builtAt: IsoDate | null;
  enabled: boolean;
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
  | "rule"
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

/** Which Threads in a Group get a Brief in the background (docs/spec/inbox.md, "Brief policy"). */
export type BriefPolicy = "always" | "on_open" | "never";

export interface Group {
  id: GroupId;
  workspaceId: Id;
  parentId: GroupId | null;
  name: string;
  rule: Rule;
  /** Per-Group override of the route threshold; null means use the Setting. */
  threshold: number | null;
  /** Per-Group brief policy; null means use the Setting (slice 13 consumes it). */
  briefPolicy: BriefPolicy | null;
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

/** Who decides the brief policy: the rule over Thread state and headers, or the model with the user's prompt. */
export type BriefPolicyMode = "rule" | "model";

/** What asked for a Brief: the sync engine on arrival, the reader on open, or the user by hand. */
export type BriefTrigger = "sync" | "open" | "user";

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

/** The command-line agents a Local runtime can be (CONTEXT.md, Local runtime). */
export type LocalCli = "claude-code" | "codex" | "opencode";

export type Runtime =
  | {
      kind: "local";
      cli: LocalCli;
      /** The model the CLI reported once it started; unknown before that. */
      model?: string | undefined;
    }
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

/* ------------------------------ Hosted runtime and Meter (ADR 0007) ------------------------------ */

/** The models a Hosted provider's two Roles resolve to. */
export interface Roles {
  main: string;
  fast: string;
}

/** Token counts one model call reported. Cached tokens are the part of the input served from a cache. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/** One row of the Meter: one model call. Cost is an estimate in USD micro-units (1e-6 dollars). */
export interface MeterEntry {
  id: Id;
  workspaceId: Id;
  task: Task;
  provider: HostedProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costMicros: number;
  durationMs: number;
  jobId: Id | null;
  createdAt: IsoDate;
}

/** The Meter for one Task on one provider over a month. */
export interface MeterLine {
  task: Task;
  provider: HostedProvider;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costMicros: number;
}

export interface MeterMonth {
  workspaceId: Id;
  /** "YYYY-MM" in UTC. */
  month: string;
  lines: MeterLine[];
  costMicros: number;
}

/** The Hosted runtime as the Server sees it: the chosen provider, its Roles, and which providers hold a shared key. */
export interface HostedState {
  provider: HostedProvider;
  roles: Record<HostedProvider, Roles>;
  /** Providers whose key the user shared with the Server ("Let the server use this key"). */
  sharedKeys: HostedProvider[];
}

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
  /** Set once the call was undone; the card then shows Undone instead of Undo. */
  undoneAt?: IsoDate | null;
  /** The user declined the approval; nothing ran. */
  declined?: boolean;
  /** A Local runtime's own built-in tool, used in Developer mode; the card carries the warning glyph. */
  builtin?: boolean;
  /** The external credential that made the call (docs/spec/external-mcp.md); the card names it. */
  actorName?: string | null;
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
  /** The Hosted runtime: provider, Roles and which providers hold a shared key (ADR 0007). */
  hosted: HostedState;
  /** Which Servers are alive around this database right now: this one plus fresh heartbeats. */
  topology: "sidecar" | "cloud" | "both";
  /** What the live Servers can do together (deployment.ts). */
  features: {
    realtime: "websocket" | "sse" | "polling";
    holdsConnections: boolean;
    pushWebhooks: boolean;
    scheduledSendsWhileClosed: boolean;
    backgroundJobs: boolean;
    localRuntimes: boolean;
  };
  /** Every Server with a fresh heartbeat, this one included. */
  servers: Array<{ id: string; mode: DeploymentMode; lastSeen: IsoDate }>;
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
