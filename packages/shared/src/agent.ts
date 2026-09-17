// The Agent host's wire and seam types (ADR 0002, docs/spec/agent-composer.md):
// tool tiers and previews, the ToolHost seam the tool server acts through,
// the events a Session streams, and the Activity log rows. Runtime-neutral so
// the Server's tool server and a Device's ToolHost share one vocabulary.

import type { Draft, Id, IsoDate, Person, Runtime, Thread, Tier, ToolCall } from "./domain.ts";
import type { Actor, DraftContent, Intent, IntentArgs } from "./sync.ts";

/* ------------------------------ Tiers ------------------------------ */

/**
 * The approval class a tool declares. `read` runs silently, `reversible` runs
 * and records Undo, `leaves_mailbox` and `destructive` ask first. A Setting
 * may promote a tool to always-ask; nothing can demote one.
 */
export type ToolTier = "read" | "reversible" | "leaves_mailbox" | "destructive";

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
  | { kind: "send"; sendId: Id };

/** One Tool call in the Activity log with everything the composer card shows. */
export interface ActivityRecord extends ToolCall {
  workspaceId: Id;
  actor: "agent" | "user" | "automation";
  callId: string | null;
  input: Record<string, unknown> | null;
  preview: ToolPreview | null;
  decision: ApprovalDecision | "auto" | null;
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
  | { kind: "done"; id: Id; waiting: string | null };

/** What the Device tells the Server with each turn: things only it knows. */
export interface TurnContext {
  /** Setting keys the Device's Config file pins. */
  pinned?: string[] | undefined;
  /** The Thread the reader shows, for "About this thread". */
  threadId?: Id | null | undefined;
}
