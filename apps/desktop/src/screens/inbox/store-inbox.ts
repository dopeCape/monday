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
  tablesRead,
  threadsByIdsSql,
} from "../../store/index.ts";
import type { ContentTransport } from "../../store/transport.ts";
import type { BodyUnavailable, Inbox, UndoToken } from "./actions.ts";
import { type FolderEntry, type FolderKey, folderThreads } from "./folders.ts";

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
  /** A Mail folder's Threads (Starred, Snoozed, Sent, Archive), from the same rows as the stream. */
  folder(key: FolderKey): readonly Thread[];
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
      project(lastRows);
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

  let lastRows: Record<string, unknown>[] = [];
  /**
   * Each row's projection, kept while the row object is the same and the
   * rules have not changed (generation), so a write that touched ten Threads
   * sections ten, not the whole Cache.
   */
  type Projected = { thread: Thread; deleted: boolean; lastSender: string | null };
  const projectedById = new Map<
    string,
    {
      row: Record<string, unknown>;
      generation: number;
      projected: Projected;
      judgments: ThreadJudgments | null;
    }
  >();
  let generation = 0;
  /** The Threads in the trash, which the domain type does not carry. */
  const deletedIds = new Set<string>();
  /** The Judgments per Thread, as the Cache holds them. */
  const judgmentsById = new Map<string, ThreadJudgments>();
  /** Every row as the folders read it, and each folder's list, computed on first read after a change. */
  let folderEntries: readonly FolderEntry[] = [];
  const folders = new Map<FolderKey, readonly Thread[]>();
  const owner = options.owner ?? options.sections?.owner ?? "";
  const project = (rows: Record<string, unknown>[]) => {
    lastRows = rows;
    byId.clear();
    deletedIds.clear();
    judgmentsById.clear();
    folders.clear();
    const all = rows.map((r) => {
      const id = String(r.id);
      const held = projectedById.get(id);
      if (held && held.row === r && held.generation === generation) {
        if (held.judgments) judgmentsById.set(id, held.judgments);
        return held.projected;
      }
      const entry = rowToCachedThread(r, store.workspaceId);
      if (entry.judgments) judgmentsById.set(entry.thread.id, entry.judgments);
      const projected = {
        thread: sectioned(entry),
        deleted: entry.deleted,
        lastSender: entry.lastSender,
      };
      projectedById.set(id, { row: r, generation, projected, judgments: entry.judgments });
      return projected;
    });
    folderEntries = all;
    for (const { thread, deleted } of all) {
      byId.set(thread.id, thread);
      if (deleted) deletedIds.add(thread.id);
    }
    stream = all
      .filter(({ thread, deleted }) => !deleted && !thread.archived && thread.snoozedUntil === null)
      .map(({ thread }) => thread);
    for (const l of [...listeners]) l();
    scheduleJudgments();
  };

  // The Thread list: read whole once, then only the Threads each write names
  // are read again and put in place. Re-reading the whole Cache on every sync
  // page and every body that lands is what made a large Account lag.
  const listTables = tablesRead(ALL_THREADS_SQL);
  const rowIndex = new Map<string, Record<string, unknown>>();
  const newer = (a: Record<string, unknown>, b: Record<string, unknown>) => {
    const la = String(a.last_activity ?? "");
    const lb = String(b.last_activity ?? "");
    if (la !== lb) return la > lb ? -1 : 1;
    return Number(b.rid ?? 0) - Number(a.rid ?? 0);
  };
  const sameRow = (a: Record<string, unknown>, b: Record<string, unknown>) => {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => a[k] === b[k]);
  };
  let pendingIds = new Set<string>();
  let pendingAll = false;
  let reading: Promise<void> | null = null;
  let listClosed = false;
  const readAll = async () => {
    const rows = await store.query<Record<string, unknown>>(ALL_THREADS_SQL);
    rowIndex.clear();
    for (const r of rows) rowIndex.set(String(r.id), r);
    project(rows);
  };
  const readSome = async (ids: string[]) => {
    const fresh = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const rows = await store.query<Record<string, unknown>>(threadsByIdsSql(chunk.length), chunk);
      for (const r of rows) fresh.set(String(r.id), r);
    }
    const changed = ids.filter((id) => {
      const before = rowIndex.get(id);
      const after = fresh.get(id);
      return before === undefined || after === undefined
        ? before !== after
        : !sameRow(before, after);
    });
    if (changed.length === 0) return;
    const gone = new Set(changed);
    const rows = lastRows.filter((r) => !gone.has(String(r.id)));
    for (const id of changed) {
      const r = fresh.get(id);
      if (r) rowIndex.set(id, r);
      else rowIndex.delete(id);
    }
    for (const id of changed) {
      const r = fresh.get(id);
      if (!r) continue;
      let lo = 0;
      let hi = rows.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (newer(rows[mid] as Record<string, unknown>, r) <= 0) lo = mid + 1;
        else hi = mid;
      }
      rows.splice(lo, 0, r);
    }
    project(rows);
  };
  const drain = () => {
    if (reading || listClosed) return;
    reading = (async () => {
      try {
        while ((pendingAll || pendingIds.size > 0) && !listClosed) {
          const all = pendingAll;
          const ids = [...pendingIds];
          pendingAll = false;
          pendingIds = new Set();
          if (all || ids.length > 2000) await readAll();
          else await readSome(ids);
        }
      } catch (error) {
        log(`thread list: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        reading = null;
      }
    })();
  };
  const stopWrites = store.onWrite((tables, threadIds) => {
    if (![...tables].some((t) => listTables.has(t))) return;
    if (threadIds === undefined) pendingAll = true;
    else for (const id of threadIds) pendingIds.add(id);
    drain();
  });
  await readAll();

  // Groups and Tags as the Cache holds them (the feed keeps both current).
  let groups: readonly Group[] = [];
  let tags: readonly Tag[] = [];
  const groupsLive = store.live<Record<string, unknown>>(GROUPS_SQL);
  const tagsLive = store.live<Record<string, unknown>>(TAGS_SQL);
  await Promise.all([
    new Promise<void>((resolve) => {
      groupsLive.subscribe((rows) => {
        groups = rows.map((r) => rowToGroup(r, store.workspaceId));
        // A rule may name a Group by name: a renamed Group sections again.
        generation += 1;
        if (lastRows.length > 0) project(lastRows);
        for (const l of [...listeners]) l();
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
  const showNow = (changed: ReadonlyMap<string, Thread>) => {
    if (changed.size === 0) return;
    for (const [id, t] of changed) byId.set(id, t);
    folderEntries = folderEntries.map((e) => {
      const next = changed.get(e.thread.id);
      return next ? { ...e, thread: next } : e;
    });
    folders.clear();
    stream = folderEntries
      .filter(({ thread, deleted }) => !deleted && !thread.archived && thread.snoozedUntil === null)
      .map(({ thread }) => thread);
    for (const l of [...listeners]) l();
  };

  /** Runs `make` for every known id and files the inverses under a new token. */
  const act = async (
    ids: readonly string[],
    make: (thread: Thread) => { intent: StoreIntent; reverse: StoreIntent | null },
  ): Promise<UndoToken> => {
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
    thread: (id) => byId.get(id),
    folder(key) {
      let list = folders.get(key);
      if (!list) {
        list = folderThreads(key, folderEntries, owner);
        folders.set(key, list);
      }
      return list;
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
      project(lastRows);
    },
    judged: (threadId) => judgedById.get(threadId) ?? EMPTY_JUDGED,
    close() {
      if (judgeTimer !== null) clearTimeout(judgeTimer);
      judgeTimer = null;
      stopStatus();
      waiting.clear();
      listClosed = true;
      stopWrites();
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
