// Search wire shapes (ADR 0011, ADR 0015). The client index is local; these
// are the Server routes the search path may call outside the keystroke loop:
// the bulk body pull that fills the Cache (the pre-warm Job), the
// headers-only index the Agent uses while the laptop is closed, and the full
// search over the whole mailbox that runs only when asked ("Search older
// mail", or the Agent's search with `full`).
// Runtime-neutral: no Bun, no DOM, no Node imports.

import type { Id, IsoDate, Person, Thread } from "./domain.ts";

/** One decrypted body for the Cache, from GET /messages/bodies. */
export interface MessageBodyRow {
  id: Id;
  threadId: Id;
  date: IsoDate;
  text: string;
  /** What the reader renders: the Server's sanitised display HTML, never the raw part. */
  html: string | null;
  snippet: string;
  /**
   * "fetched" for a real body. Anything else is the empty stand-in for a
   * Message whose body the Server has not fetched from the Provider yet: the
   * Cache skips it and asks again later. Absent from older Servers.
   */
  bodyState?: "pending" | "fetched" | "deferred";
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

/* ------------------------------ Full search ------------------------------ */

/** POST /search/full: the query as typed, parsed on the Server with the shared parser. */
export interface FullSearchRequest {
  workspace: Id;
  q: string;
  /** Only Threads last active before this moment (on top of the query's own dates). */
  before?: IsoDate | undefined;
  /** The most hits before the stream stops with a cursor; the search.full.limit Setting when absent. */
  limit?: number | undefined;
  /** Where a previous stream stopped: "Search further" resumes below it. */
  cursor?: string | undefined;
  /** The client's clock, so relative dates (older_than:7d) mean what the user saw. */
  now?: IsoDate | undefined;
}

/** One matching Thread: its header with the decrypted subject, and a passage around the match. */
export interface FullSearchHit {
  type: "hit";
  thread: Thread;
  snippet: string;
}

/** How far the scan is: Threads examined out of the Threads the SQL filters left. */
export interface FullSearchProgress {
  type: "progress";
  scanned: number;
  total: number;
  /**
   * Resumes below the last Thread examined, so a client that stopped the
   * stream can search further from here; null at the start of a fresh scan
   * and at the end.
   */
  cursor: string | null;
}

/**
 * The end of one stream. `cursor` is null when the mailbox is exhausted and
 * otherwise resumes the scan below the last Thread examined (`reason`
 * "limit": the hit limit was reached).
 */
export interface FullSearchDone {
  type: "done";
  scanned: number;
  total: number;
  hits: number;
  cursor: string | null;
  reason: "exhausted" | "limit";
  /** Envelopes opened for this stream: subjects and bodies. */
  decrypted: number;
  elapsedMs: number;
}

export interface FullSearchError {
  type: "error";
  message: string;
  /** "locked" when the Server holds no root key. */
  code?: "locked" | undefined;
}

/** One NDJSON line of POST /search/full. */
export type FullSearchEvent = FullSearchHit | FullSearchProgress | FullSearchDone | FullSearchError;
