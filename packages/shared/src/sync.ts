// The wire between the Store and the Server: write intents the Outbox replays,
// the Changes feed the client reads from a cursor, and the last-writer-wins rule
// both sides apply (ADR 0005, ADR 0009). Runtime-neutral.

import type {
  DraftAttachment,
  DraftKind,
  DraftStatus,
  Group,
  Id,
  IsoDate,
  Person,
  ScheduledSendStatus,
  SendError,
  Thread,
} from "./domain.ts";
import type { DecisionCandidate } from "./routing/index.ts";

/* ------------------------------ Intents ------------------------------ */

/** Who made a write. The user always beats automation (ADR 0005). */
export type Actor = "user" | "automation";

/**
 * The columns an intent touches, compared as one unit. Each group keeps its own
 * last write (`at`, `by`) so an offline archive and a server-side move never
 * contend with each other.
 */
export type FieldGroup =
  | "archived"
  | "starred"
  | "unread"
  | "snoozed"
  | "placement"
  | "deleted"
  | "tags";

export type IntentKind =
  | "archive"
  | "unarchive"
  | "star"
  | "unstar"
  | "read"
  | "unread"
  | "snooze"
  | "unsnooze"
  | "move"
  | "delete"
  | "undelete"
  | "tags";

export const INTENT_KINDS: readonly IntentKind[] = [
  "archive",
  "unarchive",
  "star",
  "unstar",
  "read",
  "unread",
  "snooze",
  "unsnooze",
  "move",
  "delete",
  "undelete",
  "tags",
];

export const FIELD_GROUP_OF: Record<IntentKind, FieldGroup> = {
  archive: "archived",
  unarchive: "archived",
  star: "starred",
  unstar: "starred",
  read: "unread",
  unread: "unread",
  snooze: "snoozed",
  unsnooze: "snoozed",
  move: "placement",
  delete: "deleted",
  undelete: "deleted",
  tags: "tags",
};

/** What every intent carries besides its arguments. */
export interface IntentStamp {
  /** When the user or automation acted, by the actor's clock. */
  at: IsoDate;
  actor: Actor;
}

export type IntentArgs =
  | { kind: "archive" }
  | { kind: "unarchive" }
  | { kind: "star" }
  | { kind: "unstar" }
  | { kind: "read" }
  | { kind: "unread" }
  | { kind: "snooze"; until: IsoDate }
  | { kind: "unsnooze" }
  | { kind: "move"; group: Id | null; subgroup: Id | null }
  | { kind: "delete" }
  | { kind: "undelete" }
  | { kind: "tags"; tags: Id[] };

/** One write intent against one Thread. */
export type Intent = IntentArgs & IntentStamp & { threadId: Id };

export interface IntentResult {
  applied: boolean;
  /** Why a losing intent was not applied. */
  reason?: string;
}

/* ------------------------------ Draft and send intents (ADR 0010) ------------------------------ */

/** What the compose surface saves: everything on a Draft the user can edit. */
export interface DraftContent {
  threadId: Id | null;
  kind: DraftKind;
  inReplyToMessageId: Id | null;
  to: Person[];
  cc: Person[];
  bcc: Person[];
  subject: string;
  bodyHtml: string;
  bodyText: string;
  attachments: DraftAttachment[];
}

/**
 * The Outbox intents that target a Draft rather than a Thread. "send.schedule"
 * is "schedule a send Job", never "send": an offline Send enters the undo
 * window when it reaches the Server. The client mints the send id so a replay
 * is idempotent and the countdown can start before the Server answers.
 */
export type DraftIntentArgs =
  | { kind: "draft.save"; content: DraftContent }
  | { kind: "draft.delete" }
  | { kind: "send.schedule"; sendId: Id; delaySeconds?: number; runAt?: IsoDate }
  | { kind: "send.cancel"; sendId: Id };

export type DraftIntentKind = DraftIntentArgs["kind"];

export const DRAFT_INTENT_KINDS: readonly DraftIntentKind[] = [
  "draft.save",
  "draft.delete",
  "send.schedule",
  "send.cancel",
];

export type DraftIntent = DraftIntentArgs & IntentStamp & { draftId: Id };

export function isDraftIntentKind(kind: string): kind is DraftIntentKind {
  return (DRAFT_INTENT_KINDS as readonly string[]).includes(kind);
}

/** What the Server answers a send.schedule with, so the countdown follows the Server clock. */
export interface ScheduleResult extends IntentResult {
  sendId?: Id;
  runAt?: IsoDate;
}

/* ------------------------------ Last-writer-wins ------------------------------ */

export interface FieldWrite {
  at: IsoDate;
  by: Actor;
}

/** Per field group, the last write that landed on a row. */
export type FieldWrites = Partial<Record<FieldGroup, FieldWrite>>;

export type Resolution = { wins: true } | { wins: false; reason: string };

/**
 * Per-field last-writer-wins: a newer intent replaces an older write, except
 * that a user intent always beats a row last written by automation, whatever
 * the clocks say (ADR 0005). Equal timestamps let the intent through so a
 * replayed intent is idempotent.
 */
export function resolveWrite(intent: IntentStamp, last: FieldWrite | null | undefined): Resolution {
  if (!last) return { wins: true };
  if (intent.actor === "user" && last.by === "automation") return { wins: true };
  if (Date.parse(intent.at) >= Date.parse(last.at)) return { wins: true };
  return {
    wins: false,
    reason: `${intent.actor} write at ${intent.at} is older than ${last.by} write at ${last.at}`,
  };
}

/* ------------------------------ Changes feed ------------------------------ */

export type ChangeKind =
  | "thread"
  | "message"
  | "label"
  | "tag"
  | "thread_labels"
  | "thread_tags"
  | "draft"
  | "send"
  | "brief"
  | "group"
  | "decision";

/** Thread headers as the feed carries them: no subject, no snippet (those are content). */
export interface ThreadChange extends Thread {
  deleted: boolean;
}

/** Message headers; the body stays behind /messages/:id/body. */
export interface MessageChange {
  id: Id;
  threadId: Id;
  from: Person;
  to: Person[];
  cc: Person[];
  date: IsoDate;
  hasAttachments: boolean;
}

export interface LabelChange {
  id: Id;
  name: string;
  providerId: string;
}

export interface TagChange {
  id: Id;
  name: string;
}

export interface ThreadLinksChange {
  threadId: Id;
  ids: Id[];
}

/** Draft headers; subject and body stay behind GET /drafts/:id. */
export interface DraftChange {
  id: Id;
  threadId: Id | null;
  kind: DraftKind;
  inReplyToMessageId: Id | null;
  to: Person[];
  cc: Person[];
  bcc: Person[];
  attachments: DraftAttachment[];
  status: DraftStatus;
  updatedAt: IsoDate;
  updatedBy: string;
  deleted: boolean;
}

export interface SendChange {
  id: Id;
  draftId: Id;
  runAt: IsoDate;
  status: ScheduledSendStatus;
  cancelledAt: IsoDate | null;
  sentAt: IsoDate | null;
  jobId: Id | null;
  error: SendError | null;
  createdAt: IsoDate;
}

/**
 * A Brief's headers; bullets and actions are content and stay behind
 * GET /threads/:id/brief. `messageCount` is the Thread version the Brief was
 * computed for; `stale` says a newer Message has arrived since.
 */
export interface BriefChange {
  threadId: Id;
  computedAt: IsoDate;
  stale: boolean;
  messageCount: number;
  /** The Brief was removed: the policy says never, or the Thread is gone. */
  deleted: boolean;
}

/**
 * A Group as the feed carries it: name, parent, sentence, Predicate, threshold
 * and brief policy. The model prompt is content and stays behind GET /groups.
 */
export interface GroupChange extends Omit<Group, "rule"> {
  sentence: string;
  predicate: Group["rule"]["predicate"];
  deleted: boolean;
}

/** A Thread entering or leaving Needs a decision; `candidates` is empty when it left. */
export interface DecisionChange {
  threadId: Id;
  candidates: DecisionCandidate[];
  at: IsoDate;
}

export type ChangePayload =
  | { kind: "thread"; payload: ThreadChange }
  | { kind: "message"; payload: MessageChange }
  | { kind: "label"; payload: LabelChange }
  | { kind: "tag"; payload: TagChange }
  | { kind: "thread_labels"; payload: ThreadLinksChange }
  | { kind: "thread_tags"; payload: ThreadLinksChange }
  | { kind: "draft"; payload: DraftChange }
  | { kind: "send"; payload: SendChange }
  | { kind: "brief"; payload: BriefChange }
  | { kind: "group"; payload: GroupChange }
  | { kind: "decision"; payload: DecisionChange };

export type Change = ChangePayload & {
  seq: number;
  workspaceId: Id;
  entityId: Id;
  at: IsoDate;
};

export interface ChangesPage {
  changes: Change[];
  /** The seq to pass as `since` next time. Equals `since` when nothing is new. */
  cursor: number;
}

/** What the wake transport sends; the client then fetches from its cursor. */
export interface WakeMessage {
  seq: number;
}
