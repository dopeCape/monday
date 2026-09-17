// Search wire shapes (ADR 0011). The client index is local; these are the two
// Server routes the search path may call outside the keystroke loop: the bulk
// body pull that fills the Cache ("search older mail" and the pre-warm Job)
// and the headers-only index the Agent uses while the laptop is closed.
// Runtime-neutral: no Bun, no DOM, no Node imports.

import type { Id, IsoDate, Person } from "./domain.ts";

/** One decrypted body for the Cache, from GET /messages/bodies. */
export interface MessageBodyRow {
  id: Id;
  threadId: Id;
  date: IsoDate;
  text: string;
  html: string | null;
  snippet: string;
}

/**
 * A page of bodies, newest first. `cursor` is the date to pass as `before`
 * next time; null when the range is exhausted. `total` counts every Message
 * in the requested range, so a client can show progress.
 */
export interface MessageBodiesPage {
  bodies: MessageBodyRow[];
  cursor: IsoDate | null;
  total: number;
}

/** One hit from the Server's headers-only index, GET /search/headers. */
export interface HeaderHit {
  threadId: Id;
  /** The lowercased subject prefix the index holds, never the decrypted subject. */
  subjectSearch: string;
  participants: Person[];
  lastActivity: IsoDate;
  rank: number;
}

export interface HeaderSearchPage {
  hits: HeaderHit[];
}
