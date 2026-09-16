// The wire between the Store and the Server: write intents the Outbox replays,
// the Changes feed the client reads from a cursor, and the last-writer-wins rule
// both sides apply (ADR 0005, ADR 0009). Runtime-neutral.

import type { Id, IsoDate, Person, Thread } from "./domain.ts";

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
  | { kind: "tags"; tags: Id[] };

/** One write intent against one Thread. */
export type Intent = IntentArgs & IntentStamp & { threadId: Id };

export interface IntentResult {
  applied: boolean;
  /** Why a losing intent was not applied. */
  reason?: string;
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

export type ChangeKind = "thread" | "message" | "label" | "tag" | "thread_labels" | "thread_tags";

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

export type ChangePayload =
  | { kind: "thread"; payload: ThreadChange }
  | { kind: "message"; payload: MessageChange }
  | { kind: "label"; payload: LabelChange }
  | { kind: "tag"; payload: TagChange }
  | { kind: "thread_labels"; payload: ThreadLinksChange }
  | { kind: "thread_tags"; payload: ThreadLinksChange };

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
