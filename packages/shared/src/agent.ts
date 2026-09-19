// The Agent host's wire and seam types (ADR 0002, docs/spec/agent-composer.md):
// tool tiers and previews, the ToolHost seam the tool server acts through,
// the events a Session streams, and the Activity log rows. Runtime-neutral so
// the Server's tool server and a Device's ToolHost share one vocabulary.

import type {
  Draft,
  Id,
  IsoDate,
  LocalCli,
  Person,
  Runtime,
  Thread,
  Tier,
  ToolCall,
} from "./domain.ts";
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
  | { kind: "text"; text: string };

/** How many Threads a preview lists in full before it says "and N more". */
export const PREVIEW_LIST_MAX = 25;

export type ApprovalDecision = "approved" | "declined";

/* ------------------------------ Activity log ------------------------------ */

/** What an Activity row remembers to reverse a tool call. */
export type UndoRecord =
  | { kind: "intents"; intents: (IntentArgs & { threadId: Id })[] }
  | { kind: "settings"; entries: Array<{ key: string; previous: unknown }> }
  | { kind: "draft"; draftId: Id }
  | { kind: "send"; sendId: Id }
  /** A Workflow made, edited or switched: null previous means it was created and Undo deletes it. */
  | {
      kind: "workflow";
      workflowId: Id;
      previous: { version: number; enabled: boolean } | null;
    };

/** One Tool call in the Activity log with everything the composer card shows. */
export interface ActivityRecord extends ToolCall {
  workspaceId: Id;
  actor: "agent" | "user" | "automation";
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
  | { kind: "user"; id: Id; text: string }
  | { kind: "delta"; id: Id; text: string }
  | { kind: "text"; id: Id; text: string }
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
