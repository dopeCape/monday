// The Agent host's wire and seam types (ADR 0002, docs/spec/agent-composer.md):
// tool tiers and previews, the ToolHost seam the tool server acts through,
// the events a Session streams, and the Activity log rows. Runtime-neutral so
// the Server's tool server and a Device's ToolHost share one vocabulary.

import type {
  Draft,
  Id,
  IsoDate,
  LocalCli,
  MeetingLinkKind,
  Person,
  RsvpResponse,
  Runtime,
  Thread,
  Tier,
  ToolCall,
} from "./domain.ts";
import type { GroupInput } from "./routing/index.ts";
import type { Actor, DraftContent, Intent, IntentArgs } from "./sync.ts";

/* ------------------------------ Tiers ------------------------------ */

/**
 * The approval class a tool declares. `read` runs silently, `reversible` runs
 * and records Undo, `leaves_mailbox` and `destructive` ask first. A Setting
 * may promote a tool to always-ask; nothing can demote one.
 */
export type ToolTier = "read" | "reversible" | "leaves_mailbox" | "destructive";

/**
 * The tools the Agent has and the tier each declares (docs/spec/agent-composer.md).
 * The Server's catalog is the implementation and a test pins it to this list;
 * the Settings screens render the Permissions tier list from here, so a
 * reversible tool can be promoted to always-ask without asking the Server.
 */
export const TOOL_TIERS: Readonly<Record<string, ToolTier>> = {
  search_threads: "read",
  read_thread: "read",
  list_groups_and_sections: "read",
  archive_threads: "reversible",
  snooze_threads: "reversible",
  tag_threads: "reversible",
  move_threads: "reversible",
  draft_message: "reversible",
  // The composer (docs/spec/agent-composer.md): the Agent reads, edits and
  // opens Drafts; sending stays send_draft, which always asks.
  list_drafts: "read",
  read_draft: "read",
  update_draft: "reversible",
  open_draft: "read",
  change_setting: "reversible",
  change_layout: "reversible",
  trash_threads: "destructive",
  send_draft: "leaves_mailbox",
  forward_thread: "leaves_mailbox",
  undo: "read",
  // The integrations, MCP servers and the Workflow tools (slice 16).
  post_to_slack: "leaves_mailbox",
  post_to_discord: "leaves_mailbox",
  add_notion_row: "leaves_mailbox",
  save_to_drive: "leaves_mailbox",
  call_webhook: "leaves_mailbox",
  call_mcp_tool: "leaves_mailbox",
  list_workflows: "read",
  create_workflow: "reversible",
  update_workflow: "reversible",
  enable_workflow: "reversible",
  dry_run_workflow: "read",
  list_workflow_runs: "read",
  approve_workflow_step: "leaves_mailbox",
  run_workflow: "reversible",
  // External MCP (slice 19): a key the Agent makes when asked; revoking it is the undo.
  create_external_key: "reversible",
  // Onboarding (slice 20, docs/spec/onboarding.md).
  onboarding_context: "read",
  propose_groups: "reversible",
  propose_workflows: "read",
  adopt_workflow: "reversible",
  propose_views: "reversible",
  set_keymap: "reversible",
  // The Voice profile (CONTEXT.md): built from sent mail on request; Undo restores the old one.
  build_voice_profile: "reversible",
  // The calendar tools (slice 18): an invite goes out, so scheduling and answering ask first.
  list_events: "read",
  schedule_event: "leaves_mailbox",
  rsvp: "leaves_mailbox",
  update_event: "leaves_mailbox",
  delete_event: "destructive",
  // Organizing mail by talking (slice 26, docs/spec/agent-composer.md): Sections,
  // Groups and custom actions from a sentence, every one reversible; Undo puts
  // the previous Setting or Group back. Routing existing mail previews above
  // the threshold.
  create_section: "reversible",
  update_section: "reversible",
  delete_section: "reversible",
  create_action: "reversible",
  update_action: "reversible",
  delete_action: "reversible",
  create_group: "reversible",
  update_group: "reversible",
  organize_existing: "reversible",
  // Tuning the judgments behind routing and Sections from the user's feedback
  // (ADR 0012): explaining and listing read what is stored, a test re-asks the
  // judge on recent Threads without changing anything, and an update or an
  // Example is reversible; Undo puts the previous text, threshold or Example back.
  explain_placement: "read",
  list_judgments: "read",
  test_judgment: "read",
  update_judgment: "reversible",
  add_example: "reversible",
};

/** The glossary Tier a tool tier renders as. */
export function tierOf(tier: ToolTier): Tier {
  switch (tier) {
    case "read":
      return "read-only";
    case "reversible":
      return "reversible";
    default:
      return "always-ask";
  }
}

/* ------------------------------ Previews ------------------------------ */

/** One Thread as an approval card lists it. */
export interface PreviewThread {
  id: Id;
  subject: string;
  from: string;
  lastActivity: IsoDate;
}

/** What a tool is about to do, shown on the card before it runs. */
export type ToolPreview =
  | { kind: "threads"; action: string; count: number; threads: PreviewThread[] }
  | { kind: "send"; to: Person[]; cc: Person[]; subject: string; text: string }
  | { kind: "setting"; key: string; from: unknown; to: unknown }
  | { kind: "event"; event: EventPreview }
  | { kind: "groups"; groups: GroupProposalPreview[]; considered: number }
  | { kind: "text"; text: string };

/** One Group onboarding proposes, as its card shows it before anything is created. */
export interface GroupProposalPreview {
  name: string;
  /** The plain-language Routing rule. */
  sentence: string;
  /** Existing Threads that would move into it on approval. */
  moves: number;
}

/** An Event as the scheduling card shows it before it exists (slice 18). */
export interface EventPreview {
  /** "schedule", "update", "cancel" or "rsvp": the verb the card leads with. */
  action: "schedule" | "update" | "cancel" | "rsvp";
  title: string;
  start: IsoDate;
  end: IsoDate;
  allDay: boolean;
  timeZone: string | null;
  attendees: Person[];
  /** The link kind that will be minted, or the URL when it is already known. */
  link: MeetingLinkKind | string | null;
  /** Who mails the invitations: the Provider (Google, Graph, a scheduling CalDAV server), monday (iMIP), or nobody (no attendees). */
  invitesBy: "provider" | "monday" | "none";
  /** Titles of own Events that overlap the slot. */
  conflicts: string[];
  /** The answer, on an "rsvp". */
  response?: RsvpResponse | undefined;
}

/** How many Threads a preview lists in full before it says "and N more". */
export const PREVIEW_LIST_MAX = 25;

export type ApprovalDecision = "approved" | "declined";

/* ------------------------------ Activity log ------------------------------ */

/** What an Activity row remembers to reverse a tool call. */
export type UndoRecord =
  | { kind: "intents"; intents: (IntentArgs & { threadId: Id })[] }
  | { kind: "settings"; entries: Array<{ key: string; previous: unknown }> }
  | { kind: "draft"; draftId: Id }
  /** A Draft the Agent edited (update_draft): Undo puts the previous content back. */
  | { kind: "draft_content"; draftId: Id; previous: DraftContent }
  | { kind: "send"; sendId: Id }
  /** A Workflow made, edited or switched: null previous means it was created and Undo deletes it. */
  | {
      kind: "workflow";
      workflowId: Id;
      previous: { version: number; enabled: boolean } | null;
    }
  /** An external key the Agent created (slice 19): Undo revokes it. */
  | { kind: "external_key"; credentialId: Id }
  /** Onboarding's approved Group proposal: the Groups it created and the moves to put back. */
  | { kind: "groups"; groupIds: Id[]; intents: (IntentArgs & { threadId: Id })[] }
  /** An Event the scheduling tool made: Undo cancels it (the Provider mails the cancellation). */
  | { kind: "event"; eventId: Id }
  /** The Voice profile before a rebuild: Undo puts it back. */
  | {
      kind: "voice";
      workspaceId: Id;
      previous: { description: string; excerpts: string[]; enabled: boolean };
    }
  /** A Group the organization tools made or changed (slice 26): null previous means it was created and Undo deletes it. */
  | { kind: "group"; groupId: Id; previous: GroupInput | null }
  /**
   * Existing mail organized into a new Group or Section (slice 26): the moves
   * to put back, and the Section whose cached judgments Undo forgets.
   */
  | { kind: "organize"; intents: (IntentArgs & { threadId: Id })[]; sectionId: string | null }
  /**
   * An Example the Agent recorded for a Group (add_example): Undo removes it,
   * or puts back the Example the Thread already was for that Group.
   */
  | { kind: "example"; threadId: Id; groupId: Id; previous: { positive: boolean } | null };

/** One Tool call in the Activity log with everything the composer card shows. */
export interface ActivityRecord extends ToolCall {
  workspaceId: Id;
  /** "external" is a call through the external MCP server (docs/spec/external-mcp.md). */
  actor: "agent" | "user" | "automation" | "external";
  /** The credential's name when the actor is external: the caller the card names. */
  actorName?: string | null;
  callId: string | null;
  input: Record<string, unknown> | null;
  preview: ToolPreview | null;
  /** "standing" is a Standing approval on a Workflow Step (CONTEXT.md). */
  decision: ApprovalDecision | "auto" | "standing" | null;
  /** The Activity row that undid this one, once it has been undone. */
  undoneAt: IsoDate | null;
  at: IsoDate;
}

/* ------------------------------ ToolHost seam ------------------------------ */

export interface ThreadFilter {
  /** Free text over subject and participants. */
  query?: string | undefined;
  section?: string | undefined;
  group?: string | undefined;
  /** Only Threads whose last activity is before this moment. */
  olderThan?: IsoDate | undefined;
  unread?: boolean | undefined;
  includeArchived?: boolean | undefined;
  limit: number;
}

export interface ThreadSummary {
  id: Id;
  subject: string;
  from: string;
  participants: Person[];
  lastActivity: IsoDate;
  unread: boolean;
  archived: boolean;
  snoozedUntil: IsoDate | null;
  section: string | null;
  group: string | null;
  subgroup: string | null;
  /** Tag ids. */
  tags: string[];
}

export interface ThreadReading {
  id: Id;
  subject: string;
  messages: Array<{
    id: Id;
    from: Person;
    to: Person[];
    date: IsoDate;
    /** Null while the body is not readable (locked Server, not yet fetched). */
    text: string | null;
  }>;
}

export interface SettingRead {
  value: unknown;
  /** The key is set in the Config file on the Device; the file wins (ADR 0001). */
  pinned: boolean;
}

/**
 * What the tools act through. The Server implementation works on Postgres and
 * the Jobs table through the same paths the routes use; the Device
 * implementation works through the Store, the Outbox and the Shell, so an
 * action made while online is undoable from the same toast as a manual one.
 */
export interface ToolHost {
  readonly workspaceId: Id;
  listThreads(filter: ThreadFilter): Promise<ThreadSummary[]>;
  /** Summaries for exactly these ids; unknown ids are left out. */
  threadsById(ids: readonly Id[]): Promise<ThreadSummary[]>;
  readThread(threadId: Id): Promise<ThreadReading | null>;
  listGroups(): Promise<Array<{ id: Id; name: string }>>;
  listSections(): Promise<Array<{ id: string; name: string }>>;
  /** Names to ids, creating what is missing. */
  tagIds(names: readonly string[]): Promise<Id[]>;
  /**
   * Applies write intents in order, stamped by the host's clock. The Agent's
   * own writes are `automation` so a later manual action beats them under
   * last-writer-wins; an Undo replays as `user` so it beats everything.
   */
  applyIntents(
    intents: readonly (IntentArgs & { threadId: Id })[],
    options?: { actor?: Actor | undefined },
  ): Promise<{ applied: number }>;
  createDraft(content: DraftContent): Promise<Draft>;
  deleteDraft(draftId: Id): Promise<void>;
  readDraft(draftId: Id): Promise<Draft | null>;
  /** Replaces a Draft's content (the Agent's update_draft and its Undo); absent on hosts that cannot. */
  updateDraft?(draftId: Id, content: DraftContent): Promise<Draft>;
  /** Open Drafts, newest first; absent on hosts that cannot list them. */
  listDrafts?(): Promise<Draft[]>;
  scheduleSend(draftId: Id): Promise<{ sendId: Id; runAt: IsoDate }>;
  cancelSend(sendId: Id): Promise<{ applied: boolean }>;
  readSetting(key: string): Promise<SettingRead>;
  writeSetting(key: string, value: unknown): Promise<void>;
  /** An attachment's bytes, for the Drive integration; absent on hosts that hold no bodies. */
  readAttachment?(
    attachmentId: Id,
  ): Promise<{ name: string; mediaType: string; bytes: Uint8Array } | null>;
}

export type { Intent, Runtime, Thread };

/* ------------------------------ Sessions and events ------------------------------ */

export interface SessionSummary {
  id: Id;
  workspaceId: Id;
  runtime: Runtime;
  /** The first user turn, for the history list. */
  title: string;
  startedAt: IsoDate;
  lastActivity: IsoDate;
}

/**
 * What a Session streams while a turn runs and what its transcript replays.
 * `delta` is streamed only; every other kind is persisted in order.
 */
export type AgentEvent =
  /**
   * `at` on user and text events: when the turn was sent or the answer began.
   * A loaded transcript carries it from the Server; a live one is stamped by
   * the Device as it arrives. The composer shows it on hover.
   */
  | { kind: "user"; id: Id; text: string; at?: IsoDate | undefined }
  | { kind: "delta"; id: Id; text: string; at?: IsoDate | undefined }
  | { kind: "text"; id: Id; text: string; at?: IsoDate | undefined }
  | { kind: "tool"; call: ToolCall; preview: ToolPreview | null; threads?: PreviewThread[] }
  | { kind: "error"; id: Id; message: string; code?: string | undefined }
  | { kind: "done"; id: Id; waiting: string | null }
  /** The Session moved to another Runtime; the thread shows it as a line. */
  | { kind: "runtime"; id: Id; runtime: Runtime };

/** What the Device tells the Server with each turn: things only it knows. */
export interface TurnContext {
  /** Setting keys the Device's Config file pins. */
  pinned?: string[] | undefined;
  /** The Thread the reader shows, for "About this thread". */
  threadId?: Id | null | undefined;
  /**
   * The Draft open in the composer (a window or the inline reply), so "make
   * this shorter" in the agent bar acts on it through the compose tools.
   */
  draftId?: Id | null | undefined;
  /** The Session's Developer mode switch (CONTEXT.md); only a Local runtime reads it. */
  developerMode?: boolean | undefined;
  /** This Session is the onboarding conversation (docs/spec/onboarding.md): the onboarding prompt is appended. */
  onboarding?: boolean | undefined;
}

/* ------------------------------ AgentSession seam ------------------------------ */

/** What a turn ends with: the Activity row that waits for approval, or nothing. */
export interface TurnOutcome {
  waiting: string | null;
}

/** Everything a runtime needs before its first turn on a Session. */
export interface SessionStartContext extends TurnContext {
  workspaceId: Id;
  sessionId: Id;
  /** The Workspace's address, for the system prompt. */
  address: string;
  /** How many times the Session changed Runtime; a new epoch hands the transcript over. */
  epoch: number;
  /** The transcript so far, handed to a runtime that did not produce it. */
  transcript: readonly AgentEvent[];
  /** The Local runtime keeps its own shell, file and web tools (CONTEXT.md, Developer mode). */
  developerMode: boolean;
  /** Whether the Agent may fetch web pages. */
  webFetch: boolean;
}

/** Which Runtime is answering, and with which model when known. */
export interface RuntimeInfo {
  runtime: Runtime;
  model: string | null;
}

/**
 * One Session on one Runtime (ADR 0002, ADR 0007): the Hosted loop on the
 * Server and the three Local adapters on a Device implement it alike, so the
 * composer and the Activity log see identical turns. `send` and `resume`
 * stream events until the model stops or a tool asks; `resume` answers the
 * waiting call and runs on. `start` is idempotent and carries the turn
 * context; a new epoch replays the transcript to the runtime as context.
 */
export interface AgentSession {
  start(context: SessionStartContext): Promise<void>;
  send(text: string, onEvent: (event: AgentEvent) => void): Promise<TurnOutcome>;
  resume(
    activityId: Id,
    decision: ApprovalDecision,
    onEvent: (event: AgentEvent) => void,
  ): Promise<TurnOutcome>;
  cancel(): Promise<void>;
  runtime(): RuntimeInfo;
}

/* ------------------------------ Local runtime detection ------------------------------ */

/** What a Device found out about one command-line agent. */
export interface RuntimeStatus {
  cli: LocalCli;
  /** The binary the Device would spawn: the Setting's path override or the name on PATH. */
  command: string;
  installed: boolean;
  version: string | null;
  /** Null when the CLI does not expose a login state. */
  loggedIn: boolean | null;
  /** Why the runtime cannot start, in the user's language, when it cannot. */
  reason: string | null;
}

/**
 * The transcript so far as plain text, for a runtime that did not produce it
 * (a Runtime switch mid-Session). Tool calls already made are listed, never
 * repeated (docs/spec/agent-composer.md, Sessions).
 */
export function transcriptAsContext(events: readonly AgentEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    switch (event.kind) {
      case "user":
        lines.push(`User: ${event.text}`);
        break;
      case "text":
        if (event.text) lines.push(`Assistant: ${event.text}`);
        break;
      case "tool": {
        const outcome =
          event.call.status === "done"
            ? event.call.declined
              ? "declined by the user"
              : (event.call.result ?? "done")
            : event.call.status;
        lines.push(`Tool ${event.call.tool} (${event.call.inputSummary}): ${outcome}`);
        break;
      }
      default:
        break;
    }
  }
  return lines.join("\n");
}

/** A user turn with the handed-over transcript in front of it, for the first turn of a new epoch. */
export function withHandover(text: string, transcript: readonly AgentEvent[]): string {
  const context = transcriptAsContext(transcript);
  if (!context) return text;
  return `The conversation so far, from another runtime. Tool calls listed here already happened; do not repeat them.\n\n${context}\n\nThe user continues:\n${text}`;
}

/* ------------------------------ External MCP (slice 19) ------------------------------ */

/** What an external credential may reach: read-only tools, or every tool with its approvals. */
export type ExternalScope = "read" | "act";

/**
 * A credential of the external MCP server (docs/spec/external-mcp.md): a Key
 * made in Settings or by the Agent, or an OAuth token the owner consented
 * to. Separate from Device tokens (ADR 0006). The secret is never listed.
 */
export interface ExternalCredential {
  id: Id;
  kind: "key" | "oauth";
  name: string;
  scope: ExternalScope;
  /** The Workspaces it may reach; null means all of them. */
  workspaceIds: Id[] | null;
  createdAt: IsoDate;
  expiresAt: IsoDate;
  lastUsedAt: IsoDate | null;
  revokedAt: IsoDate | null;
  /** The OAuth client this credential belongs to, for the interactive kind. */
  clientId: string | null;
  /** The key's visible prefix, so the list and a leaked key can be matched. */
  prefix: string | null;
}

/** What the owner decides when a new key is made. */
export interface ExternalKeyInput {
  name: string;
  scope: ExternalScope;
  workspaceIds: Id[] | null;
  /** Days until it expires; the Setting external.key_expiry_days when absent. Never "never". */
  expiresInDays?: number | undefined;
}

/** A key just made: the row and the secret, shown once. */
export interface ExternalKeyCreated {
  credential: ExternalCredential;
  secret: string;
}

/** An external call parked on an approval, as the caller polls it and the owner's client lists it. */
export interface ExternalPending {
  activityId: Id;
  workspaceId: Id;
  credentialId: Id;
  credentialName: string;
  tool: string;
  inputSummary: string;
  status: "waiting" | "running" | "done" | "failed";
  /** The result text once the call finished. */
  text: string | null;
  /** The Session the owner's card lives in. */
  sessionId: Id | null;
  at: IsoDate;
}

/** An OAuth consent waiting for the owner (docs/spec/external-mcp.md, Interactive). */
export interface ExternalConsent {
  id: Id;
  clientId: string;
  clientName: string;
  scope: ExternalScope;
  workspaceIds: Id[] | null;
  /** The pairing code shown on the consent page, typed in a monday client to approve. */
  code: string;
  expiresAt: IsoDate;
}
