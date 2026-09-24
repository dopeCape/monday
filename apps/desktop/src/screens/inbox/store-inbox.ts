// The Inbox seam (actions.ts) over the Store (ADR 0009). Threads come from
// one live query over the Cache and are handed to the screen as a stable
// external store; every action is a Store intent, applied locally before the
// Server hears of it, and every undo is the inverse intent under a new token.
// The reader side keeps two live queries per watched Thread (its Messages and
// its Brief) and fills bodies through the content routes on open, within the
// Cache rules (a body fetched once stays; an opened Thread is read again only
// when a Message has none). The Brief comes from the Cache, where the feed
// and the Store's warming put it before open; an open that finds none, or a
// stale one, asks the Server under the brief policy (docs/spec/inbox.md, Briefs).
// Sections are decided here, on the client, from the Section rules in
// Settings over Thread state, Group and the Thread's Judgments from the Cache
// (CONTEXT.md "Section rule"; slice 25): fast, local, and never waiting on
// the Server. A Section the Server assigned (the section Task) is kept as is.
// A rule with a judge statement (slice 26, ADR 0012) needs the Judge's answer
// per Thread beyond the arrival Judgments: the Thread falls through to the
// next rule until the answer is here, the missing answers are asked for in
// one batched request through the content transport, and the stream is
// re-sectioned when they land. The same answers say where a judged custom
// action shows.
// The seam never holds the whole Cache: a large Account has tens of thousands
// of Threads, and every warmed Workspace stays open. Each list (the Inbox, a
// Mail folder, a Group lens) holds the newest rows of its own bounded query,
// the inbox.memory_window Setting's worth, and reads the next page when the
// list nears its end (more()); a Thread outside every list (a search result,
// a link, the agent's) is read by id and kept while it is open or watched.
// The totals the nav shows come from one aggregate over the whole Cache.

import type {
  AiLevel,
  Brief,
  CustomActionSetting,
  Group,
  Message,
  SectionJudged,
  SectionRuleSetting,
  Tag,
  Thread,
  ThreadJudgments,
} from "@monday/shared";
import { sectionOf, sectionsToJudge } from "@monday/shared";
import {
  ALL_THREADS_SQL,
  BRIEF_OF_THREAD_SQL,
  GROUPS_SQL,
  INBOX_COUNTS_SQL,
  type LiveQuery,
  MESSAGES_OF_THREAD_SQL,
  rowToBrief,
  rowToCachedThread,
  rowToGroup,
  rowToMessage,
  rowToTag,
  type Store,
  type StoreIntent,
  TAGS_SQL,
  type ThreadListOrder,
  tablesRead,
  threadPageSql,
  threadsByIdsSql,
} from "../../store/index.ts";
import type { ContentTransport } from "../../store/transport.ts";
import type { BodyUnavailable, Inbox, InboxCounts, UndoToken } from "./actions.ts";
import { type FolderKey, type ThreadList, type ThreadListKey, threadList } from "./folders.ts";

/**
 * What an undo puts back: the inverse intents, in the order the action ran.
 * A Thread the action found already in its target state has no inverse, so
 * undoing "mark read" on a mixed batch leaves the Threads that were read alone.
 */
type Reversal = Array<StoreIntent>;

export interface StoreInbox extends Inbox {
  /** Re-evaluates the Section rules over the cached rows, after the Settings change. */
  resection(): void;
  /** The judged answers held for a Thread, by Section or custom action id; empty when none yet. */
  judged(threadId: string): SectionJudged;
  /** A Mail folder's Threads (Starred, Snoozed, Sent, Archive), from its own bounded query. */
  folder(key: FolderKey): readonly Thread[];
  group(groupId: string): readonly Thread[];
  more(list: ThreadListKey): void;
  watchList(list: ThreadListKey, listener: () => void): () => void;
  counts(): InboxCounts;
  resolve(id: string): Promise<Thread | undefined>;
  /** How many Thread rows the seam holds in memory, over every list and every Thread read by id. */
  held(): number;
  close(): void;
}

/** The Section rules as the Store evaluates them: the Settings, read when rows arrive, and the owner. */
export interface SectionSource {
  rules: () => readonly SectionRuleSetting[];
  order: () => readonly string[];
  /** The mailbox owner's address, for "lastFrom". */
  owner: string;
  /** Group id to name, so a rule may name a Group either way. */
  groupNames?: (() => Readonly<Record<string, string>>) | undefined;
  /** The sections.judge_threshold Setting, read when rows arrive. */
  judgeThreshold?: (() => number) | undefined;
  /** The custom actions (actions.custom), so judged ones are asked for with the Sections. */
  actions?: (() => readonly CustomActionSetting[]) | undefined;
  /** How many Threads one request judges (sections.judge_batch). */
  judgeBatch?: (() => number) | undefined;
}

export interface StoreInboxOptions {
  /** The content routes; absent when the Store has no Server (tests): bodies then stay as cached. */
  content?: ContentTransport | undefined;
  /** The reader.load_remote_images Setting, read at fetch time. */
  remoteImages?: (() => boolean) | undefined;
  /** The Section rules; absent leaves every Thread's Section as the Cache has it. */
  sections?: SectionSource | undefined;
  /** The AI level, read at open time: at `off` no Brief is asked for (CONTEXT.md "AI level"). */
  level?: (() => AiLevel) | undefined;
  /** The owner's address, for the Sent folder; defaults to the Section rules' owner. */
  owner?: string | undefined;
  /** The inbox.memory_window Setting: the rows each list holds at first and reads per page. */
  memoryWindow?: (() => number) | undefined;
  /** The inbox.memory_lookups Setting: Threads read by id kept once nothing shows them. */
  memoryLookups?: (() => number) | undefined;
  log?: ((message: string) => void) | undefined;
}

interface Watched {
  live: LiveQuery<Record<string, unknown>>;
  briefLive: LiveQuery<Record<string, unknown>>;
  listeners: Set<() => void>;
  messages: readonly Message[];
  brief: Brief | undefined;
  unavailable: BodyUnavailable | null;
}

/** What a failed content read means to the reader: the status the API client carries. */
function classify(error: unknown): BodyUnavailable {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 0) return "offline";
  if (status === 423) return "locked";
  return "failed";
}

const EMPTY: readonly Message[] = [];

/** Opens the seam and resolves once the first rows are in, so the screen never renders empty. */
export async function createStoreInbox(
  store: Store,
  options: StoreInboxOptions = {},
): Promise<StoreInbox> {
  const byId = new Map<string, Thread>();
  const listeners = new Set<() => void>();
  const undos = new Map<UndoToken, Reversal>();
  const watched = new Map<string, Watched>();
  /** Threads kept warm for the reader's next move, with how to let each go. */
  const warmHolds = new Map<string, () => void>();
  const opening = new Map<string, Promise<void>>();
  const log = options.log ?? (() => {});
  let tokenSeq = 0;
  let stream: readonly Thread[] = [];

  const watch = (threadId: string): Watched => {
    let w = watched.get(threadId);
    if (w) return w;
    const live = store.live<Record<string, unknown>>(MESSAGES_OF_THREAD_SQL, [threadId], {
      threadId,
    });
    const briefLive = store.live<Record<string, unknown>>(BRIEF_OF_THREAD_SQL, [threadId], {
      threadId,
    });
    const entry: Watched = {
      live,
      briefLive,
      listeners: new Set(),
      messages: EMPTY,
      brief: undefined,
      unavailable: null,
    };
    live.subscribe((rows) => {
      entry.messages = rows.map(rowToMessage);
      for (const l of [...entry.listeners]) l();
    });
    briefLive.subscribe((rows) => {
      const row = rows[0];
      entry.brief = row ? (rowToBrief(row) ?? undefined) : undefined;
      for (const l of [...entry.listeners]) l();
    });
    watched.set(threadId, entry);
    w = entry;
    return w;
  };

  /** The Cache's Brief row for a Thread as the policy sees it: none, stale, or fresh. */
  const briefState = async (threadId: string): Promise<"none" | "stale" | "fresh"> => {
    const rows = await store.query<{ stale: number; content_stale: number }>(
      "select stale, content_stale from briefs where thread_id = ?",
      [threadId],
    );
    const row = rows[0];
    if (!row) return "none";
    // Content on its way from the feed counts as fresh: no second ask.
    return row.stale && !row.content_stale ? "stale" : "fresh";
  };

  /** Asks the Server for a Brief; the answer arrives through the feed. Never throws. */
  const askBrief = async (threadId: string, trigger: "open" | "user") => {
    if (options.level?.() === "off") return;
    const content = options.content;
    if (!content) return;
    try {
      await content.requestBrief(store.workspaceId, threadId, trigger);
    } catch (error) {
      log(`brief ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** Tells the reader why bodies are missing, or that they no longer are. */
  const setUnavailable = (threadId: string, why: BodyUnavailable | null) => {
    const w = watched.get(threadId);
    if (!w || w.unavailable === why) return;
    w.unavailable = why;
    for (const l of [...w.listeners]) l();
  };

  /** Threads with a body the Server has not fetched yet: asked again after each pull. */
  const waiting = new Set<string>();
  const refetching = new Set<string>();

  /**
   * Asks for each body and caches the ones the Server has. A body it has not
   * fetched yet (bodyState pending or deferred: the Provider refused or the
   * pass has not come round) is the empty stand-in a header-only sync keeps,
   * never cached, so the reader keeps its Loading line and the Thread waits
   * for the next pull instead of holding an empty body for good.
   */
  const fetchBodies = async (threadId: string, ids: readonly string[]) => {
    const content = options.content;
    if (!content) return;
    let why: BodyUnavailable | null = null;
    let pending = false;
    for (const id of ids) {
      try {
        const body = await content.body(id, { images: options.remoteImages?.() ?? false });
        if (body.bodyState !== undefined && body.bodyState !== "fetched") {
          pending = true;
          continue;
        }
        await store.cacheBody(id, { text: body.text, html: body.display.html });
      } catch (error) {
        why ??= classify(error);
        log(`body ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (pending) waiting.add(threadId);
    else waiting.delete(threadId);
    setUnavailable(threadId, why);
  };

  /** The Messages of a Thread the Cache holds no body for. */
  const missingBodies = async (threadId: string): Promise<string[]> => {
    const rows = await store.query<{ id: string }>(
      "select id from messages where thread_id = ? and body_text is null",
      [threadId],
    );
    return rows.map((r) => r.id);
  };

  // A pull brings the Server's news, a body the sync just fetched among it:
  // an open Thread still waiting asks again for what it lacks.
  const stopStatus = store.onStatus((status) => {
    if (status === "syncing") return;
    for (const threadId of waiting) {
      if (!watched.has(threadId) || refetching.has(threadId)) continue;
      refetching.add(threadId);
      void missingBodies(threadId)
        .then(async (ids) => {
          if (ids.length > 0) await fetchBodies(threadId, ids);
          else waiting.delete(threadId);
        })
        .catch((error) => log(`refetch ${threadId}: ${error}`))
        .finally(() => refetching.delete(threadId));
    }
  });

  /** Headers and attachments from the Server, then every body the Cache lacks. */
  const fetchThread = async (threadId: string) => {
    const content = options.content;
    if (!content) return;
    let headers: Awaited<ReturnType<typeof content.messages>>;
    try {
      headers = await content.messages(threadId);
    } catch (error) {
      setUnavailable(threadId, classify(error));
      throw error;
    }
    await store.cacheMessages(headers);
    // An empty text with no html is what earlier builds cached for a Message
    // the Server had not fetched yet (and what the pre-warm used to mark a
    // gap with). It is not a body: cleared, so the reader shows Loading and
    // the Server is asked again.
    const cached = await store.query<{
      id: string;
      body_text: string | null;
      body_html: string | null;
    }>("select id, body_text, body_html from messages where thread_id = ?", [threadId]);
    const empty = cached.filter((r) => r.body_text === "" && !r.body_html).map((r) => r.id);
    if (empty.length > 0) {
      await store.write([
        {
          sql: `update messages set body_text = null, body_html = null, body_at = null where id in (${empty.map(() => "?").join(", ")})`,
          params: empty,
        },
      ]);
    }
    const have = new Set(
      cached.filter((r) => r.body_text !== null && !empty.includes(r.id)).map((r) => r.id),
    );
    // A pending body is asked for too: the Server fetches it on demand.
    await fetchBodies(
      threadId,
      headers.map((m) => m.id).filter((id) => !have.has(id)),
    );
  };

  /** The judged answers per Thread, filled through the transport; the Server keeps them too. */
  const judgedById = new Map<string, Record<string, number>>();
  /** Threads whose judged rules have no answer yet, waiting for the next request. */
  const toJudge = new Set<string>();
  /** Threads asked for and not answered, so a Thread is never asked twice in flight. */
  const asking = new Set<string>();
  /** Threads the Server had no answer for (the Judge was away): not asked again until the rules change. */
  const unanswered = new Set<string>();
  let judgeTimer: ReturnType<typeof setTimeout> | null = null;
  const EMPTY_JUDGED: SectionJudged = Object.freeze({});

  /** The facts a rule reads: the row, the arrival Judgments the Cache holds (slice 25), the judged answers (slice 26). */
  const factsFor = (entry: ReturnType<typeof rowToCachedThread>, rules: SectionSource) => ({
    lastSender: entry.lastSender,
    owner: rules.owner,
    ...(rules.groupNames ? { groupNames: rules.groupNames() } : {}),
    judgments: entry.judgments,
    judged: judgedById.get(entry.thread.id),
    ...(rules.judgeThreshold ? { judgeThreshold: rules.judgeThreshold() } : {}),
  });

  /** Whether any custom action with a judge statement lacks an answer for a Thread. */
  const actionsToJudge = (threadId: string): boolean => {
    const actions = options.sections?.actions?.() ?? [];
    const have = judgedById.get(threadId);
    return actions.some((a) => a.on.judge?.trim() && have?.[a.id] === undefined);
  };

  /** The Section a row lands in: the Server's when it set one, else the rules over the row, its Judgments and the judged answers. */
  const sectioned = (entry: ReturnType<typeof rowToCachedThread>): Thread => {
    const rules = options.sections;
    if (!rules) return entry.thread;
    const facts = factsFor(entry, rules);
    const ruleList = rules.rules();
    const order = rules.order();
    const queue = () => {
      if (!unanswered.has(entry.thread.id)) toJudge.add(entry.thread.id);
    };
    // A Thread the Server sectioned keeps its Section; its judged actions are still asked for.
    if (entry.thread.section !== null) {
      if (actionsToJudge(entry.thread.id)) queue();
      return entry.thread;
    }
    if (
      sectionsToJudge(entry.thread, facts, ruleList, order).length > 0 ||
      actionsToJudge(entry.thread.id)
    ) {
      queue();
    }
    const section = sectionOf(entry.thread, facts, ruleList, order);
    return section === null ? entry.thread : { ...entry.thread, section };
  };

  /** Asks the Server for the judged answers still missing, one batch at a time. Never throws. */
  const askJudgments = async () => {
    judgeTimer = null;
    const content = options.content;
    if (!content?.sectionJudgments || options.level?.() === "off") {
      toJudge.clear();
      return;
    }
    const batch = options.sections?.judgeBatch?.() ?? 25;
    const ids = [...toJudge].filter((id) => !asking.has(id)).slice(0, batch);
    for (const id of ids) {
      toJudge.delete(id);
      asking.add(id);
    }
    if (ids.length === 0) return;
    try {
      const answers = await content.sectionJudgments(store.workspaceId, ids);
      const answered = new Set<string>();
      for (const a of answers) {
        judgedById.set(a.threadId, { ...(judgedById.get(a.threadId) ?? {}), ...a.rules });
        answered.add(a.threadId);
      }
      // What did not come back (the Judge was away) is not asked again until the rules change.
      for (const id of ids) if (!answered.has(id)) unanswered.add(id);
      for (const id of answered) projectedById.delete(id);
      project();
    } catch (error) {
      log(`judge sections: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      for (const id of ids) asking.delete(id);
      // The rows may have queued more while the request ran.
      for (const id of ids) toJudge.delete(id);
      if (toJudge.size > 0) scheduleJudgments();
    }
  };
  const scheduleJudgments = () => {
    if (judgeTimer !== null || toJudge.size === 0) return;
    judgeTimer = setTimeout(() => void askJudgments(), 0);
  };

  // Groups and Tags as the Cache holds them (the feed keeps both current); read below.
  let groups: readonly Group[] = [];
  let tags: readonly Tag[] = [];

  /**
   * Each row's projection, kept while the row object is the same and the
   * rules have not changed (generation), so a write that touched ten Threads
   * sections ten, not every row held. Only rows some list (or a lookup) holds
   * have one.
   */
  type RawRow = Record<string, unknown>;
  const projectedById = new Map<
    string,
    { row: RawRow; generation: number; thread: Thread; judgments: ThreadJudgments | null }
  >();
  let generation = 0;
  /** The Threads in the trash, which the domain type does not carry. */
  const deletedIds = new Set<string>();
  /** The Judgments per Thread held, as the Cache holds them. */
  const judgmentsById = new Map<string, ThreadJudgments>();
  const owner = options.owner ?? options.sections?.owner ?? "";

  /**
   * One list held in part: the first rows of its query, in its order. The
   * rows are always a prefix of the whole list, so the next page is read
   * after the last one held and a re-read row is placed by comparing it with
   * the last row the write did not touch.
   */
  interface Held {
    key: ThreadListKey;
    list: ThreadList;
    compare: (a: RawRow, b: RawRow) => number;
    rows: RawRow[];
    byId: Map<string, RawRow>;
    /** How many rows the list is asked to hold: the window, plus a window per more(). */
    want: number;
    /** Whether the rows are the whole list. */
    complete: boolean;
    loaded: boolean;
    threads: readonly Thread[];
    /** The screens showing it; the last one to leave lets it go (the Inbox is always held). */
    watchers: number;
  }
  const lists = new Map<ThreadListKey, Held>();
  const windowSize = () => Math.max(1, Math.floor(options.memoryWindow?.() ?? 1500));
  /** How far under its window a list may fall (Threads archived away) before it reads more. */
  const slack = () => Math.floor(windowSize() / 4);
  /** Threads read by id outside every list (a search result, a link), with the ones asked for since the last pass. */
  const extras = new Map<string, RawRow>();
  const touched = new Set<string>();
  /** Ids asked for that the Cache does not hold: not asked again until a write names them. */
  const absent = new Set<string>();
  const lookups = new Set<string>();
  const needFill = new Set<Held>();
  const EMPTY_THREADS: readonly Thread[] = Object.freeze([]);

  const valueOrder = (x: unknown, y: unknown): number => {
    if (x === y) return 0;
    if (x === null || x === undefined) return -1;
    if (y === null || y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") return x - y;
    const a = String(x);
    const b = String(y);
    return a < b ? -1 : a > b ? 1 : 0;
  };
  const comparer =
    (order: readonly ThreadListOrder[]) =>
    (a: RawRow, b: RawRow): number => {
      for (const o of order) {
        const c = valueOrder(a[o.column], b[o.column]);
        if (c !== 0) return o.desc ? -c : c;
      }
      return 0;
    };
  const sameRow = (a: RawRow, b: RawRow) => {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => a[k] === b[k]);
  };
  const inAnyList = (id: string) => {
    for (const h of lists.values()) if (h.byId.has(id)) return true;
    return false;
  };
  /** The row object already held for the same content, so every list shares one projection. */
  const canon = (r: RawRow): RawRow => {
    const held = projectedById.get(String(r.id))?.row;
    return held && sameRow(held, r) ? held : r;
  };

  const project = () => {
    byId.clear();
    deletedIds.clear();
    judgmentsById.clear();
    const live = new Set<string>();
    const one = (r: RawRow): Thread => {
      const id = String(r.id);
      live.add(id);
      const held = projectedById.get(id);
      let thread: Thread;
      let judgments: ThreadJudgments | null;
      if (held && held.row === r && held.generation === generation) {
        thread = held.thread;
        judgments = held.judgments;
      } else {
        const entry = rowToCachedThread(r, store.workspaceId);
        thread = sectioned(entry);
        judgments = entry.judgments;
        projectedById.set(id, { row: r, generation, thread, judgments });
      }
      byId.set(id, thread);
      if (r.deleted === 1 || r.deleted === true) deletedIds.add(id);
      if (judgments) judgmentsById.set(id, judgments);
      return thread;
    };
    for (const h of lists.values()) {
      if (!h.loaded) continue;
      const next = h.rows.map(one);
      const same = next.length === h.threads.length && next.every((t, i) => t === h.threads[i]);
      if (!same) h.threads = next;
    }
    // A Thread read by id is let go once a list holds it, or once nothing
    // shows it and more are kept than the Setting allows.
    for (const id of [...extras.keys()]) if (inAnyList(id)) extras.delete(id);
    const cap = Math.max(0, Math.floor(options.memoryLookups?.() ?? 200));
    for (const id of [...extras.keys()]) {
      if (extras.size <= cap) break;
      if (touched.has(id) || watched.has(id) || warmHolds.has(id)) continue;
      extras.delete(id);
    }
    touched.clear();
    for (const r of extras.values()) one(r);
    for (const id of [...projectedById.keys()]) if (!live.has(id)) projectedById.delete(id);
    stream = lists.get("inbox")?.threads ?? EMPTY_THREADS;
    for (const l of [...listeners]) l();
    scheduleJudgments();
  };

  const readPage = (h: Held, after: RawRow | null, limit: number) => {
    const { sql, params } = threadPageSql(h.list.query, after, limit);
    return store.query<RawRow>(sql, params);
  };
  const readById = async (ids: readonly string[]): Promise<Map<string, RawRow>> => {
    const fresh = new Map<string, RawRow>();
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const rows = await store.query<RawRow>(threadsByIdsSql(chunk.length), chunk);
      for (const r of rows) fresh.set(String(r.id), r);
    }
    return fresh;
  };
  const setRows = (h: Held, rows: RawRow[]) => {
    h.rows = rows;
    h.byId = new Map(rows.map((r) => [String(r.id), r]));
  };

  /** Reads a list's first page, or the rows it lacks up to what it is asked to hold. */
  const fill = async (h: Held): Promise<boolean> => {
    if (lists.get(h.key) !== h) return false;
    if (!h.loaded) {
      const rows = (await readPage(h, null, h.want)).map(canon);
      setRows(h, rows);
      h.complete = rows.length < h.want;
      h.loaded = true;
      return true;
    }
    if (h.complete || h.rows.length >= h.want) return false;
    const need = h.want - h.rows.length;
    const page = await readPage(h, h.rows.at(-1) ?? null, need);
    if (page.length < need) h.complete = true;
    let added = false;
    for (const r of page) {
      const id = String(r.id);
      if (h.byId.has(id)) continue;
      const row = canon(r);
      h.rows.push(row);
      h.byId.set(id, row);
      added = true;
    }
    return added;
  };

  /** Re-reads every list from its start (a write that could touch any Thread). */
  const reloadAll = async (): Promise<boolean> => {
    for (const h of [...lists.values()]) {
      if (!h.loaded) continue;
      const limit = Math.max(h.want, h.rows.length);
      const rows = (await readPage(h, null, limit)).map((r) => {
        const before = h.byId.get(String(r.id));
        return before && sameRow(before, r) ? before : canon(r);
      });
      setRows(h, rows);
      h.complete = rows.length < limit;
    }
    if (extras.size > 0) await applyRows([...extras.keys()], await readById([...extras.keys()]));
    return true;
  };

  /**
   * Puts the re-read rows of the named Threads in place in every list and
   * among the lookups. A row enters a list when the list's filter keeps it
   * and it sorts before the last row the write left alone (or the list holds
   * everything); it leaves when it no longer does. Returns whether anything
   * held changed.
   */
  const applyRows = (ids: readonly string[], fresh: ReadonlyMap<string, RawRow>): boolean => {
    let changed = false;
    const named = new Set(ids);
    for (const h of lists.values()) {
      if (!h.loaded) continue;
      let boundary: RawRow | undefined;
      for (let i = h.rows.length - 1; i >= 0; i--) {
        const r = h.rows[i] as RawRow;
        if (!named.has(String(r.id))) {
          boundary = r;
          break;
        }
      }
      const keep: RawRow[] = [];
      let moved = false;
      for (const id of named) {
        const before = h.byId.get(id);
        const after = fresh.get(id);
        const belongs =
          after !== undefined &&
          h.list.keepsRow(after) &&
          (h.complete || (boundary !== undefined && h.compare(after, boundary) < 0));
        if (!belongs) {
          if (before) moved = true;
          continue;
        }
        const row = before && sameRow(before, after) ? before : canon(after);
        if (row !== before) moved = true;
        keep.push(row);
      }
      if (!moved) continue;
      changed = true;
      const rows = h.rows.filter((r) => !named.has(String(r.id)));
      for (const r of keep) {
        let lo = 0;
        let hi = rows.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (h.compare(rows[mid] as RawRow, r) <= 0) lo = mid + 1;
          else hi = mid;
        }
        rows.splice(lo, 0, r);
      }
      // New mail grows a list past its window; the oldest rows beyond it are let go.
      if (rows.length > h.want + slack()) {
        rows.length = h.want;
        h.complete = false;
      }
      setRows(h, rows);
      if (!h.complete && h.rows.length < h.want - slack()) needFill.add(h);
    }
    for (const id of named) {
      const before = extras.get(id);
      if (!before) continue;
      const after = fresh.get(id);
      if (!after) {
        extras.delete(id);
        changed = true;
      } else if (!sameRow(before, after)) {
        extras.set(id, after);
        changed = true;
      }
    }
    return changed;
  };

  /** Reads Threads asked for by id; the ones no list holds are kept as lookups. */
  const lookUp = async (ids: readonly string[]): Promise<boolean> => {
    const fresh = await readById(ids);
    let found = false;
    for (const id of ids) {
      const r = fresh.get(id);
      if (!r) {
        absent.add(id);
        continue;
      }
      touched.add(id);
      if (inAnyList(id) || extras.has(id)) continue;
      extras.set(id, canon(r));
      found = true;
    }
    return found;
  };

  /** The Inbox totals over the whole Cache, from one aggregate read. */
  type CountRow = {
    k: string;
    group_id: string | null;
    subgroup_id: string | null;
    starred: number;
    n: number;
  };
  let countRows: CountRow[] = [];
  const EMPTY_COUNTS: InboxCounts = Object.freeze({ inbox: 0, snoozed: 0, unread: {} });
  let counts: InboxCounts = EMPTY_COUNTS;
  /** The unread keys a Thread counts toward, as the nav names them; a Sub-group rolls up into its parent. */
  const unreadKeys = (
    group: string | null,
    subgroup: string | null,
    starred: boolean,
    parentOf: ReadonlyMap<string, string | null>,
  ): string[] => {
    const keys = ["inbox"];
    if (starred) keys.push("starred");
    if (group) {
      keys.push(group);
      const parent = parentOf.get(group);
      if (parent) keys.push(parent);
    }
    if (subgroup && subgroup !== group) keys.push(subgroup);
    return keys;
  };
  const parents = () => new Map(groups.map((g) => [g.id, g.parentId]));
  const deriveCounts = (): InboxCounts => {
    const parentOf = parents();
    const unread: Record<string, number> = {};
    let inbox = 0;
    let snoozed = 0;
    for (const r of countRows) {
      const n = Number(r.n ?? 0);
      if (r.k === "inbox") inbox = n;
      else if (r.k === "snoozed") snoozed = n;
      else {
        for (const key of unreadKeys(r.group_id, r.subgroup_id, Boolean(r.starred), parentOf)) {
          unread[key] = (unread[key] ?? 0) + n;
        }
      }
    }
    return { inbox, snoozed, unread };
  };
  let countsStale = true;
  const readCounts = async (): Promise<boolean> => {
    countRows = await store.query<CountRow>(INBOX_COUNTS_SQL);
    const next = deriveCounts();
    if (JSON.stringify(next) === JSON.stringify(counts)) return false;
    counts = next;
    return true;
  };

  // The lists: each read in pages, then only the Threads each write names are
  // read again and put in place. Re-reading on every sync page and every body
  // that lands is what made a large Account lag; holding every row is what
  // made it heavy.
  const listTables = tablesRead(ALL_THREADS_SQL);
  let pendingIds = new Set<string>();
  let pendingAll = false;
  let reading: Promise<void> | null = null;
  let listClosed = false;
  const readSome = async (ids: string[]) => applyRows(ids, await readById(ids));
  const busy = () =>
    pendingAll || pendingIds.size > 0 || needFill.size > 0 || lookups.size > 0 || countsStale;
  /** Runs the queued reads one after another; resolves once none is left. */
  const drain = (): Promise<void> => {
    if (listClosed) return Promise.resolve();
    if (reading) return reading;
    if (!busy()) return Promise.resolve();
    reading = (async () => {
      // A turn first, so `reading` is set before the loop can finish and clear it.
      await Promise.resolve();
      try {
        while (busy() && !listClosed) {
          let changed = false;
          const all = pendingAll;
          const ids = [...pendingIds];
          pendingAll = false;
          pendingIds = new Set();
          if (all || ids.length > 2000) changed = (await reloadAll()) || changed;
          else if (ids.length > 0) changed = (await readSome(ids)) || changed;
          for (const h of [...needFill]) {
            needFill.delete(h);
            if (await fill(h)) changed = true;
          }
          if (lookups.size > 0) {
            const ask = [...lookups];
            lookups.clear();
            if (await lookUp(ask)) changed = true;
          }
          let countsChanged = false;
          if (countsStale) {
            countsStale = false;
            countsChanged = await readCounts();
          }
          if (changed) project();
          else if (countsChanged) for (const l of [...listeners]) l();
        }
      } catch (error) {
        log(`thread list: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        reading = null;
      }
    })();
    return reading;
  };
  let drainQueued = false;
  const drainSoon = () => {
    if (drainQueued) return;
    drainQueued = true;
    queueMicrotask(() => {
      drainQueued = false;
      void drain();
    });
  };
  const stopWrites = store.onWrite((tables, threadIds) => {
    if (![...tables].some((t) => listTables.has(t))) return;
    if (tables.has("threads")) countsStale = true;
    if (threadIds === undefined) {
      pendingAll = true;
      absent.clear();
    } else {
      for (const id of threadIds) {
        pendingIds.add(id);
        absent.delete(id);
      }
    }
    void drain();
  });

  /** The list for a key, made (and its first page asked for) on first use. */
  const ensureList = (key: ThreadListKey): Held => {
    let h = lists.get(key);
    if (h) return h;
    const list = threadList(key, owner);
    h = {
      key,
      list,
      compare: comparer(list.query.order),
      rows: [],
      byId: new Map(),
      want: windowSize(),
      complete: false,
      loaded: false,
      threads: EMPTY_THREADS,
      watchers: 0,
    };
    lists.set(key, h);
    needFill.add(h);
    if (!listClosed) drainSoon();
    return h;
  };

  // The Inbox's first window and the totals, together: the screen renders once both are in.
  const inboxList = ensureList("inbox");
  needFill.delete(inboxList);
  countsStale = false;
  const [, firstCounts] = await Promise.all([
    fill(inboxList),
    store.query<CountRow>(INBOX_COUNTS_SQL),
  ]);
  countRows = firstCounts;
  counts = deriveCounts();
  project();

  const groupsLive = store.live<Record<string, unknown>>(GROUPS_SQL);
  const tagsLive = store.live<Record<string, unknown>>(TAGS_SQL);
  await Promise.all([
    new Promise<void>((resolve) => {
      groupsLive.subscribe((rows) => {
        groups = rows.map((r) => rowToGroup(r, store.workspaceId));
        // A rule may name a Group by name: a renamed Group sections again.
        generation += 1;
        counts = deriveCounts();
        project();
        resolve();
      });
    }),
    new Promise<void>((resolve) => {
      tagsLive.subscribe((rows) => {
        tags = rows.map((r) => rowToTag(r, store.workspaceId));
        for (const l of [...listeners]) l();
        resolve();
      });
    }),
  ]);

  /**
   * The row as the intent leaves it, shown at once: the Cache write and the
   * query that reads it back take a round trip or two, and the key press must
   * not wait for them. The live query confirms (or corrects) it moments later.
   */
  const patched = (t: Thread, kind: StoreIntent["kind"]): Thread | null => {
    switch (kind) {
      case "read":
        return t.unread ? { ...t, unread: false } : t;
      case "unread":
        return t.unread ? t : { ...t, unread: true };
      case "star":
        return t.starred ? t : { ...t, starred: true };
      case "unstar":
        return t.starred ? { ...t, starred: false } : t;
      case "archive":
        return t.archived ? t : { ...t, archived: true };
      case "unarchive":
        return t.archived ? { ...t, archived: false } : t;
      default:
        return null;
    }
  };
  /** The totals as the changed Threads leave them, until the aggregate reads them again. */
  const countsAfter = (changed: ReadonlyMap<string, Thread>): InboxCounts => {
    const parentOf = parents();
    const unread = { ...counts.unread };
    let inbox = counts.inbox;
    const inInbox = (t: Thread) => !t.archived && t.snoozedUntil === null;
    const tally = (t: Thread, sign: 1 | -1) => {
      if (!inInbox(t)) return;
      inbox += sign;
      if (!t.unread) return;
      for (const key of unreadKeys(t.group, t.subgroup, t.starred, parentOf)) {
        unread[key] = Math.max(0, (unread[key] ?? 0) + sign);
      }
    };
    for (const [id, next] of changed) {
      const before = byId.get(id);
      if (!before || deletedIds.has(id)) continue;
      tally(before, -1);
      tally(next, 1);
    }
    return { inbox: Math.max(0, inbox), snoozed: counts.snoozed, unread };
  };
  const showNow = (changed: ReadonlyMap<string, Thread>) => {
    if (changed.size === 0) return;
    counts = countsAfter(changed);
    for (const [id, t] of changed) byId.set(id, t);
    for (const h of lists.values()) {
      if (!h.threads.some((t) => changed.has(t.id))) continue;
      h.threads = h.threads.flatMap((t) => {
        const next = changed.get(t.id);
        if (!next) return [t];
        return h.list.keepsThread(next) ? [next] : [];
      });
    }
    stream = lists.get("inbox")?.threads ?? EMPTY_THREADS;
    for (const l of [...listeners]) l();
  };

  /** A Thread by id, read from the Cache when no list holds it. */
  const resolveThread = async (id: string): Promise<Thread | undefined> => {
    const held = byId.get(id);
    if (held) {
      if (extras.has(id)) touched.add(id);
      return held;
    }
    absent.delete(id);
    lookups.add(id);
    await drain();
    return byId.get(id);
  };

  /** Runs `make` for every known id and files the inverses under a new token. */
  const act = async (
    ids: readonly string[],
    make: (thread: Thread) => { intent: StoreIntent; reverse: StoreIntent | null },
  ): Promise<UndoToken> => {
    // A Thread no list holds (a search result, the agent's) is read first.
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      for (const id of missing) {
        absent.delete(id);
        lookups.add(id);
      }
      await drain();
    }
    const reversal: Reversal = [];
    const planned: StoreIntent[] = [];
    const changed = new Map<string, Thread>();
    for (const id of ids) {
      const thread = byId.get(id);
      if (!thread) continue;
      const { intent, reverse } = make(thread);
      planned.push(intent);
      const next = patched(thread, intent.kind);
      if (next && next !== thread) changed.set(id, next);
      if (reverse) reversal.push(reverse);
    }
    showNow(changed);
    for (const intent of planned) await store.intent(intent);
    const token = `u${++tokenSeq}`;
    undos.set(token, reversal);
    return token;
  };

  type Flag =
    | "archive"
    | "unarchive"
    | "star"
    | "unstar"
    | "read"
    | "unread"
    | "delete"
    | "undelete";
  /** Whether a Thread already sits where a flag intent would put it. */
  const already = (kind: Flag, t: Thread, deleted: boolean): boolean => {
    switch (kind) {
      case "archive":
        return t.archived;
      case "unarchive":
        return !t.archived;
      case "star":
        return t.starred;
      case "unstar":
        return !t.starred;
      case "read":
        return !t.unread;
      case "unread":
        return t.unread;
      case "delete":
        return deleted;
      case "undelete":
        return !deleted;
    }
  };
  const flip = (kind: Flag, reverse: Flag) => (t: Thread) => ({
    intent: { kind, threadId: t.id },
    reverse: already(kind, t, deletedIds.has(t.id)) ? null : { kind: reverse, threadId: t.id },
  });

  return {
    threads: () => stream,
    thread(id) {
      const held = byId.get(id);
      if (held) {
        if (extras.has(id)) touched.add(id);
        return held;
      }
      // Not held: read in the background; the subscribers hear when it lands.
      if (!listClosed && !absent.has(id) && !lookups.has(id)) {
        lookups.add(id);
        drainSoon();
      }
      return undefined;
    },
    resolve: resolveThread,
    folder: (key) => ensureList(key).threads,
    group: (groupId) => ensureList(`group:${groupId}`).threads,
    more(key) {
      const h = lists.get(key);
      if (!h?.loaded || h.complete || needFill.has(h)) return;
      h.want = Math.max(h.want, h.rows.length) + windowSize();
      needFill.add(h);
      void drain();
    },
    watchList(key, listener) {
      const h = ensureList(key);
      h.watchers += 1;
      const own = () => listener();
      listeners.add(own);
      return () => {
        listeners.delete(own);
        h.watchers -= 1;
        if (h.watchers > 0 || key === "inbox") return;
        // Let go once no screen shows it, after a turn: a re-render subscribes again at once.
        setTimeout(() => {
          if (h.watchers > 0 || lists.get(key) !== h || listClosed) return;
          lists.delete(key);
          needFill.delete(h);
          project();
        }, 0);
      };
    },
    counts: () => counts,
    held() {
      const ids = new Set<string>(extras.keys());
      for (const h of lists.values()) for (const id of h.byId.keys()) ids.add(id);
      return ids.size;
    },
    groups: () => groups,
    tags: () => tags,
    messages: (threadId) => watch(threadId).messages,
    watchMessages(threadId, listener) {
      const w = watch(threadId);
      w.listeners.add(listener);
      return () => {
        w.listeners.delete(listener);
        if (w.listeners.size === 0) {
          w.live.close();
          w.briefLive.close();
          watched.delete(threadId);
          waiting.delete(threadId);
        }
      };
    },
    brief: (threadId) => watch(threadId).brief,
    judgments: (threadId) => judgmentsById.get(threadId),
    unavailable: (threadId) => watch(threadId).unavailable,
    prefetch(threadIds) {
      const keep = new Set(threadIds);
      for (const id of threadIds) {
        if (warmHolds.has(id) || !byId.has(id)) continue;
        const w = watch(id);
        const hold = () => {};
        w.listeners.add(hold);
        warmHolds.set(id, () => {
          w.listeners.delete(hold);
          if (w.listeners.size === 0) {
            w.live.close();
            w.briefLive.close();
            watched.delete(id);
            waiting.delete(id);
          }
        });
        // Bodies into the Cache ahead of the reader; no Brief asked for until it opens.
        if (!opening.has(id)) void fetchThread(id).catch(() => {});
      }
      for (const [id, release] of [...warmHolds]) {
        if (keep.has(id)) continue;
        release();
        warmHolds.delete(id);
      }
    },
    async openThread(threadId) {
      let pending = opening.get(threadId);
      if (!pending) {
        pending = fetchThread(threadId)
          .catch((error) =>
            log(`open ${threadId}: ${error instanceof Error ? error.message : String(error)}`),
          )
          // Bodies first, so the Server briefs the Thread the reader sees.
          .then(async () => {
            if ((await briefState(threadId)) !== "fresh") await askBrief(threadId, "open");
          })
          .finally(() => opening.delete(threadId));
        opening.set(threadId, pending);
      }
      await pending;
    },
    requestBrief: (threadId) => askBrief(threadId, "user"),
    async attachmentBytes(attachmentId) {
      if (!options.content) throw new Error("no content transport");
      return options.content.attachment(attachmentId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    archive: (ids) => act(ids, flip("archive", "unarchive")),
    unarchive: (ids) => act(ids, flip("unarchive", "archive")),
    snooze: (ids, until) =>
      act(ids, (t) => ({
        intent: { kind: "snooze", threadId: t.id, until: until.toISOString() },
        reverse: { kind: "unsnooze", threadId: t.id },
      })),
    star: (ids) => act(ids, flip("star", "unstar")),
    unstar: (ids) => act(ids, flip("unstar", "star")),
    markRead: (ids) => act(ids, flip("read", "unread")),
    markUnread: (ids) => act(ids, flip("unread", "read")),
    moveToGroup: (ids, groupId) =>
      act(ids, (t) => ({
        intent: { kind: "move", threadId: t.id, group: groupId, subgroup: null },
        reverse: { kind: "move", threadId: t.id, group: t.group, subgroup: t.subgroup },
      })),
    delete: (ids) => act(ids, flip("delete", "undelete")),
    setTags: (ids, tagIds) =>
      act(ids, (t) => ({
        intent: { kind: "tags", threadId: t.id, tags: [...tagIds] },
        reverse: { kind: "tags", threadId: t.id, tags: [...t.tags] },
      })),
    async undo(token) {
      const reversal = undos.get(token);
      if (!reversal) return;
      undos.delete(token);
      for (const intent of reversal) await store.intent(intent);
    },
    resection() {
      // Reworded rules may need new answers; the Server re-asks only for a changed statement.
      unanswered.clear();
      generation += 1;
      project();
    },
    judged: (threadId) => judgedById.get(threadId) ?? EMPTY_JUDGED,
    close() {
      if (judgeTimer !== null) clearTimeout(judgeTimer);
      judgeTimer = null;
      stopStatus();
      waiting.clear();
      listClosed = true;
      stopWrites();
      lists.clear();
      extras.clear();
      needFill.clear();
      lookups.clear();
      projectedById.clear();
      groupsLive.close();
      tagsLive.close();
      listeners.clear();
      for (const w of watched.values()) {
        w.live.close();
        w.briefLive.close();
      }
      watched.clear();
    },
  };
}
