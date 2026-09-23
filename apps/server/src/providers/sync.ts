// The sync engine: Provider events in, Mailstore writes out. Owns the
// sync_state and sync_messages tables (its mirror of what the Provider holds)
// and four Job steps: provider.sync (a bounded slice of work, newest first,
// headers before bodies), provider.watch (holds the push connection in this
// process; needs-process), provider.reconcile (the periodic full pass,
// because notifications are lossy) and provider.change (one inbox action
// pushed to the Provider). Threading is the Provider's when it has Threads,
// else threading.ts over the mirror.
//
// The other direction: a winning intent (an archive, a read, a star, a
// snooze, a delete) reaches the engine through the Mailstore's intent
// observer. The engine applies its effect to the mirror at once, so the next
// pass computes the Thread the way the user left it, and enqueues a
// provider.change Job that carries it to the Provider with retries; the
// reconcile pass corrects the mirror if the Provider never took it.

import type { Intent, Person, Provider as ProviderKind } from "@monday/shared";
import { settingsSchema } from "@monday/shared";
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  accounts,
  labels,
  messages,
  settings,
  syncMessages,
  syncState,
  workspaces,
} from "../db/schema.ts";
import type { Jobs } from "../jobs/index.ts";
import type { Mailstore } from "../mailstore/index.ts";
import type { CredentialStore } from "./credentials.ts";
import type { ProviderRegistry } from "./index.ts";
import { snippetOf } from "./mime.ts";
import { normalizeSubject, participantsOf, resolveThread, type ThreadLookup } from "./threading.ts";
import type {
  Change,
  Flags,
  Mailbox,
  MailboxRole,
  MessageSummary,
  ProviderError,
  RawMessage,
  Session,
  SyncEvent,
  Watch,
} from "./types.ts";
import { isMirrorMessageId } from "./types.ts";

export const SYNC_STEP = "provider.sync";
export const WATCH_STEP = "provider.watch";
export const RECONCILE_STEP = "provider.reconcile";
export const CHANGE_STEP = "provider.change";

/** Mailboxes the engine keeps out: duplicates of everything (Gmail All Mail), views, spam. */
const SKIPPED_ROLES = new Set(["all", "junk", "flagged", "important", "subscribed"]);
const ROLE_ORDER = ["inbox", "archive", "sent", "drafts", "trash"];

/** How long the watcher waits after a burst of push events before it enqueues one sync. */
export const WATCH_DEBOUNCE_MS = 1_500;
/** How often the watch step renews its lease while the connection is held. */
export const WATCH_RENEW_MS = 30_000;
/** Bodies fetched per sync step before yielding the budget back. */
const BODIES_PER_PASS = 50;

export interface SyncSettings {
  bodyWindowDays: number;
  reconcileMinutes: number;
  hotFolders: number;
  batchSize: number;
  /** Bodies fetched at once (sync.body_concurrency). */
  bodyConcurrency: number;
}

export function defaultSyncSettings(): SyncSettings {
  return {
    bodyWindowDays: settingsSchema["sync.body_window_days"].default,
    reconcileMinutes: settingsSchema["sync.reconcile_minutes"].default,
    hotFolders: settingsSchema["sync.hot_folders"].default,
    batchSize: settingsSchema["sync.batch_size"].default,
    bodyConcurrency: settingsSchema["sync.body_concurrency"].default,
  };
}

/** Reads the global sync Settings from the table, schema defaults for the rest. */
export async function readSyncSettings(db: Db): Promise<SyncSettings> {
  const out = defaultSyncSettings();
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(and(eq(settings.scope, "global"), isNull(settings.deviceId)));
  const num = (key: string, current: number) => {
    const row = rows.find((r) => r.key === key);
    return typeof row?.value === "number" ? row.value : current;
  };
  out.bodyWindowDays = num("sync.body_window_days", out.bodyWindowDays);
  out.reconcileMinutes = num("sync.reconcile_minutes", out.reconcileMinutes);
  out.hotFolders = num("sync.hot_folders", out.hotFolders);
  out.batchSize = num("sync.batch_size", out.batchSize);
  out.bodyConcurrency = num("sync.body_concurrency", out.bodyConcurrency);
  return out;
}

export interface SyncReport {
  accountId: string;
  added: number;
  changed: number;
  removed: number;
  bodies: number;
  /** True when the budget ran out before every mailbox and body was done. */
  more: boolean;
}

export interface SyncAccountOptions {
  /** Epoch milliseconds; the pass stops between units of work once passed. */
  deadline?: number;
  /** Only these mailboxes; default every syncable one. */
  mailboxIds?: string[];
  /** Skip the body pass. */
  headersOnly?: boolean;
}

export type EngineChangeTarget = { threadId: string } | { messageIds: string[] };

/** A Message the Provider holds in its Drafts folder that no Server Draft mirrors. */
export interface ProviderDraft {
  accountId: string;
  workspaceId: string;
  providerId: string;
  summary: MessageSummary;
  raw: RawMessage;
}

export type DraftImporter = (draft: ProviderDraft) => Promise<void>;

/**
 * Told once per pass about each Thread whose Messages or bodies changed and
 * whose newest body the Server now holds, so background work over content
 * (the brief policy, routing) starts from a Thread it can read. The engine
 * never runs that work inline: an observer enqueues a Job and returns.
 */
export type ThreadObserver = (workspaceId: string, threadId: string) => Promise<void>;
/** A Thread the engine just created from a new Message. Routing hooks here (slice 12). */
export interface ThreadArrival {
  accountId: string;
  workspaceId: string;
  threadId: string;
  lastActivity: string;
}

export type ArrivalHook = (arrival: ThreadArrival) => Promise<void>;

/**
 * Told about each body as it lands, with the parsed Message (slice 18: the
 * calendar module reads text/calendar parts into Invites). Runs inline after
 * the body is stored; a failure is logged and never stops the pass.
 */
export type BodyObserver = (
  account: { id: string; workspaceId: string; address: string },
  messageId: string,
  threadId: string,
  raw: RawMessage,
) => Promise<void>;

export interface SyncEngine {
  syncAccount(accountId: string, options?: SyncAccountOptions): Promise<SyncReport>;
  /** The cached Session for an Account, connecting when needed (push Jobs use adapter extras). */
  session(accountId: string): Promise<Session>;
  /** Enqueues one sync for an Account, debounced like a push event. Webhooks call this. */
  wake(accountId: string, mailboxIds?: string[]): Promise<void>;
  /** Fetches one Message's body and attachments on demand (older than the window, or opened early). */
  fetchBody(messageId: string): Promise<void>;
  /** Runs `fn` with the Account's Session (cached, reconnected on auth or network failure). */
  withSession<T>(accountId: string, fn: (session: Session) => Promise<T>): Promise<T>;
  /**
   * Whether the Account's open Session is pacing for Provider quota right now
   * (Gmail after a rate-limit refusal). False with no open Session.
   */
  pacing(accountId: string): Promise<boolean>;
  /**
   * Registers who turns Provider drafts into Server Drafts. The engine calls it
   * once per Draft it finds in the Drafts mailbox that `knownProviderIds` did
   * not list; the Drafts module owns the rest (ADR 0010).
   */
  setDraftImporter(
    importer: DraftImporter,
    knownProviderIds: (workspaceId: string) => Promise<Set<string>>,
  ): void;
  /** Registers who hears about Threads whose content changed (the Briefs module). One at a time. */
  setThreadObserver(observer: ThreadObserver | null): void;
  /** Registers who sees each body as it lands (the calendar module's Invites). One at a time. */
  setBodyObserver(observer: BodyObserver | null): void;
  /**
   * Registers who hears about a new Thread. The engine calls it once per
   * Thread it creates, after the first Message is stored; the hook enqueues
   * work through the Jobs table, never runs a model inline. A failure is logged.
   */
  setArrivalHook(hook: ArrivalHook): void;
  /** Applies an inbox action at the Provider and mirrors it locally. Ids are Mailstore ids. */
  applyChange(accountId: string, target: EngineChangeTarget, change: Change): Promise<void>;
  /**
   * A winning intent from a Device or the Agent: its effect lands on the
   * mirror now and a provider.change Job carries it to the Provider. The
   * Mailstore's intent observer; a Thread the engine does not mirror (no
   * Provider rows yet) is left alone.
   */
  recordIntent(intent: Intent, workspaceId: string): Promise<void>;
  /** Starts (or confirms) the push watcher for an Account in this process. */
  watch(accountId: string): Promise<{ supported: boolean; running: boolean }>;
  /** Stops a watcher. */
  unwatch(accountId: string): Promise<void>;
  registerSteps(jobs: Jobs): void;
  /** Enqueues the three Jobs an Account needs; idempotent. */
  startAccount(jobs: Jobs, accountId: string): Promise<void>;
  /** Forgets an Account: stops its watcher and drops its Session (the Account is being removed). */
  forget(accountId: string): Promise<void>;
  /** Drops cached Sessions and watchers. */
  close(): Promise<void>;
}

export interface SyncEngineOptions {
  db: Db;
  mailstore: Mailstore;
  providers: ProviderRegistry;
  credentials: CredentialStore;
  settings?: () => Promise<SyncSettings>;
  now?: () => Date;
  log?: (message: string) => void;
  /** Debounce for push bursts; tests shorten it. */
  watchDebounceMs?: number;
}

interface SyncPayload {
  accountId: string;
  mailboxIds?: string[];
}

interface ChangePayload {
  accountId: string;
  threadId: string;
  change: Change;
}

/** What the Provider's mailboxes look like to the intent mapping. */
export interface ProviderShape {
  inboxId: string | null;
  trashId: string | null;
  /** A Message can carry several mailboxes (Gmail labels, JMAP): add and remove instead of move. */
  labels: boolean;
}

/**
 * The Provider action an intent maps to (docs/spec/inbox.md, "Action
 * semantics"), or null when the intent is monday's alone (a move between
 * Groups, Tags). A snooze leaves the Inbox with archive semantics; its wake,
 * an unsnooze, and an undelete bring the Thread back to the Inbox: a label
 * added where a Message carries several, a move where it sits in one folder.
 */
export function providerChangeOf(intent: Intent, shape: ProviderShape): Change | null {
  const { inboxId, trashId } = shape;
  switch (intent.kind) {
    case "archive":
    case "snooze":
      return { kind: "archive" };
    case "unarchive":
    case "unsnooze":
      if (!inboxId) return null;
      return shape.labels
        ? { kind: "label", add: [inboxId], remove: [] }
        : { kind: "move", mailboxId: inboxId };
    case "undelete":
      if (!inboxId) return null;
      return shape.labels
        ? { kind: "label", add: [inboxId], remove: trashId ? [trashId] : [] }
        : { kind: "move", mailboxId: inboxId };
    case "star":
      return { kind: "star", value: true };
    case "unstar":
      return { kind: "star", value: false };
    case "read":
      return { kind: "read", value: true };
    case "unread":
      return { kind: "read", value: false };
    case "delete":
      return { kind: "delete" };
    case "move":
    case "tags":
      return null;
  }
}

interface AccountRow {
  id: string;
  provider: ProviderKind | "fake";
  address: string;
  workspaceId: string;
  /** Whether a Message can carry several mailboxes (the Account's capabilities). */
  labels: boolean;
}

interface Watcher {
  watch: Watch;
  done: Promise<void>;
  supported: boolean;
}

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const { db, mailstore, providers, credentials } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const readSettings = options.settings ?? (() => readSyncSettings(db));
  const debounceMs = options.watchDebounceMs ?? WATCH_DEBOUNCE_MS;
  const sessions = new Map<string, Promise<Session>>();
  const watchers = new Map<string, Watcher>();
  let jobsRef: Jobs | null = null;
  let draftImporter: DraftImporter | null = null;
  let knownDraftIds: ((workspaceId: string) => Promise<Set<string>>) | null = null;
  let threadObserver: ThreadObserver | null = null;
  let bodyObserver: BodyObserver | null = null;
  /** Per Account, the Threads a pass touched, drained into the observer at the end of the pass. */
  const touched = new Map<string, Set<string>>();

  const touch = (accountId: string, threadId: string) => {
    if (!threadObserver) return;
    let set = touched.get(accountId);
    if (!set) {
      set = new Set();
      touched.set(accountId, set);
    }
    set.add(threadId);
  };

  /** Whether the newest live Message of a Thread has its body, so an observer can read the Thread. */
  async function newestBodyFetched(threadId: string): Promise<boolean> {
    const [row] = await db
      .select({ bodyState: syncMessages.bodyState })
      .from(syncMessages)
      .where(and(eq(syncMessages.threadId, threadId), eq(syncMessages.stale, false)))
      .orderBy(desc(syncMessages.date))
      .limit(1);
    return row?.bodyState === "fetched";
  }

  /** Hands the pass's touched Threads to the observer, those whose newest body landed. Never throws. */
  async function notifyTouched(acct: AccountRow): Promise<void> {
    const set = touched.get(acct.id);
    if (!set || !threadObserver) return;
    touched.delete(acct.id);
    for (const threadId of set) {
      try {
        if (await newestBodyFetched(threadId)) await threadObserver(acct.workspaceId, threadId);
      } catch (error) {
        log(`thread observer ${threadId}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
  let arrivalHook: ArrivalHook | null = null;

  /* ------------------------------ Accounts and Sessions ------------------------------ */

  async function accountIdOf(workspaceId: string): Promise<string | null> {
    const row = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { accountId: true },
    });
    return row?.accountId ?? null;
  }

  async function account(accountId: string): Promise<AccountRow> {
    const [row] = await db
      .select({
        id: accounts.id,
        provider: accounts.provider,
        address: accounts.address,
        workspaceId: workspaces.id,
        capabilities: accounts.capabilities,
      })
      .from(accounts)
      .innerJoin(workspaces, eq(workspaces.accountId, accounts.id))
      .where(eq(accounts.id, accountId));
    if (!row) throw new Error(`account ${accountId} not found`);
    return {
      id: row.id,
      provider: row.provider as ProviderKind | "fake",
      address: row.address,
      workspaceId: row.workspaceId,
      labels: row.capabilities.labels,
    };
  }

  function session(acct: AccountRow): Promise<Session> {
    let pending = sessions.get(acct.id);
    if (!pending) {
      pending = (async () => {
        const creds = await credentials.load(acct.id);
        return providers(acct.provider).connect(creds);
      })();
      sessions.set(acct.id, pending);
      pending.catch(() => sessions.delete(acct.id));
    }
    return pending;
  }

  async function dropSession(accountId: string): Promise<void> {
    const pending = sessions.get(accountId);
    sessions.delete(accountId);
    if (pending) await pending.then((s) => s.close()).catch(() => {});
  }

  /** Runs `fn` with the Session; a network or auth failure drops the cached Session. */
  async function withSession<T>(acct: AccountRow, fn: (s: Session) => Promise<T>): Promise<T> {
    const s = await session(acct);
    try {
      return await fn(s);
    } catch (error) {
      const code = (error as ProviderError).code;
      if (code === "network" || code === "auth") await dropSession(acct.id);
      throw error;
    }
  }

  /* ------------------------------ Mailboxes and labels ------------------------------ */

  interface MailboxMap {
    mailboxes: Mailbox[];
    labelIdOf: Map<string, string>;
    inboxId: string | null;
  }

  /** The mailbox map from the labels table alone, for work that must not open a Session. */
  async function mailboxMapFromLabels(workspaceId: string): Promise<MailboxMap> {
    const rows = await db.select().from(labels).where(eq(labels.workspaceId, workspaceId));
    const mailboxes: Mailbox[] = rows.map((r) => ({
      id: r.providerId,
      name: r.name,
      role: (r.role as MailboxRole | null) ?? null,
      parentId: null,
      totalMessages: null,
      unreadMessages: null,
    }));
    return {
      mailboxes,
      labelIdOf: new Map(rows.map((r) => [r.providerId, r.id])),
      inboxId: rows.find((r) => r.role === "inbox")?.providerId ?? null,
    };
  }

  async function syncMailboxList(workspaceId: string, s: Session): Promise<MailboxMap> {
    const mailboxes = await s.listMailboxes();
    const labelIdOf = new Map<string, string>();
    for (const m of mailboxes) {
      const id = await mailstore.upsertLabel(workspaceId, {
        providerId: m.id,
        name: m.name,
        role: m.role,
      });
      labelIdOf.set(m.id, id);
    }
    return {
      mailboxes,
      labelIdOf,
      inboxId: mailboxes.find((m) => m.role === "inbox")?.id ?? null,
    };
  }

  function syncable(mailboxes: Mailbox[]): Mailbox[] {
    return mailboxes
      .filter((m) => !m.role || !SKIPPED_ROLES.has(m.role))
      .sort((a, b) => {
        const ra = a.role ? ROLE_ORDER.indexOf(a.role) : ROLE_ORDER.length;
        const rb = b.role ? ROLE_ORDER.indexOf(b.role) : ROLE_ORDER.length;
        return (ra < 0 ? ROLE_ORDER.length : ra) - (rb < 0 ? ROLE_ORDER.length : rb);
      });
  }

  /* ------------------------------ The mirror ------------------------------ */

  type MirrorRow = typeof syncMessages.$inferSelect;

  async function mirror(workspaceId: string, providerId: string): Promise<MirrorRow | null> {
    const row = await db.query.syncMessages.findFirst({
      where: and(
        eq(syncMessages.workspaceId, workspaceId),
        eq(syncMessages.providerId, providerId),
      ),
    });
    return row ?? null;
  }

  function lookupFor(workspaceId: string): ThreadLookup {
    return {
      async threadOfMessageId(rfcMessageId) {
        const row = await db.query.syncMessages.findFirst({
          where: and(
            eq(syncMessages.workspaceId, workspaceId),
            eq(syncMessages.rfcMessageId, rfcMessageId),
          ),
        });
        return row?.threadKey ?? null;
      },
      async threadOfSubject(normalizedSubject, participants, since) {
        if (participants.length === 0) return null;
        const rows = await db
          .select({ threadKey: syncMessages.threadKey, participants: syncMessages.participants })
          .from(syncMessages)
          .where(
            and(
              eq(syncMessages.workspaceId, workspaceId),
              eq(syncMessages.subjectKey, normalizedSubject),
              gte(syncMessages.date, since),
            ),
          )
          .orderBy(desc(syncMessages.date))
          .limit(50);
        const wanted = new Set(participants);
        for (const row of rows) {
          if (row.participants.some((p) => wanted.has(p))) return row.threadKey;
        }
        return null;
      },
    };
  }

  /** Recomputes the Thread's flags, labels and activity from its mirror rows. */
  async function refreshThread(threadId: string, map: MailboxMap): Promise<void> {
    const rows = await db
      .select()
      .from(syncMessages)
      .where(and(eq(syncMessages.threadId, threadId), eq(syncMessages.stale, false)));
    if (rows.length === 0) return;
    const mailboxIds = new Set<string>();
    let unread = false;
    let starred = false;
    let latest = rows[0]?.date ?? now();
    for (const row of rows) {
      for (const m of row.mailboxIds) mailboxIds.add(m);
      if (!row.seen) unread = true;
      if (row.flagged) starred = true;
      if (row.date > latest) latest = row.date;
    }
    const archived = map.inboxId ? !mailboxIds.has(map.inboxId) : false;
    await mailstore.updateThread(threadId, {
      unread,
      starred,
      archived,
      lastActivity: latest.toISOString(),
    });
    const labelIds = [...mailboxIds]
      .map((m) => map.labelIdOf.get(m))
      .filter((id): id is string => id !== undefined);
    await mailstore.setLabels(threadId, labelIds);
  }

  async function applyAdded(
    acct: AccountRow,
    summary: MessageSummary,
    map: MailboxMap,
  ): Promise<"added" | "changed"> {
    const workspaceId = acct.workspaceId;
    const existing = await mirror(workspaceId, summary.id);
    if (existing) {
      await applyChanged(acct, summary.id, summary.flags, summary.mailboxIds, map, existing);
      return "changed";
    }

    const participants = participantsOf(summary, acct.address);
    const from: Person = summary.from ?? { name: "", email: "" };
    let messageId: string;
    let threadId: string;
    let threadKey: string;
    let arrived = false;

    // The same RFC Message-ID under another Provider id: a copy or a move
    // (IMAP folders), or the Message coming back after a reset. Adopt it.
    const twin = summary.messageId
      ? await db.query.syncMessages.findFirst({
          where: and(
            eq(syncMessages.workspaceId, workspaceId),
            eq(syncMessages.rfcMessageId, summary.messageId),
          ),
        })
      : null;
    if (twin) {
      messageId = twin.messageId;
      threadId = twin.threadId;
      threadKey = twin.threadKey;
    } else {
      const decision = await resolveThread(summary, lookupFor(workspaceId), now(), acct.address);
      threadKey = decision.key;
      // Children that arrived first (newest-first sync) started Threads of
      // their own; this Message is their parent, so those Threads fold in.
      const children = summary.messageId
        ? await db
            .select({ threadId: syncMessages.threadId, threadKey: syncMessages.threadKey })
            .from(syncMessages)
            .where(
              and(
                eq(syncMessages.workspaceId, workspaceId),
                sql`${summary.messageId} = any(${syncMessages.references})`,
              ),
            )
        : [];
      const childThreads = [...new Map(children.map((c) => [c.threadId, c])).values()];
      if (decision.by === "new" && childThreads[0]) threadKey = childThreads[0].threadKey;
      const thread = await mailstore.findThread(workspaceId, threadKey);
      if (thread) {
        threadId = thread.id;
        const known = new Set(thread.participants.map((p) => p.email.toLowerCase()));
        const extra = [summary.from, ...summary.to, ...summary.cc].filter(
          (p): p is Person => p !== null && p.email !== "" && !known.has(p.email.toLowerCase()),
        );
        if (extra.length > 0) {
          await mailstore.updateThread(threadId, {
            participants: [...thread.participants, ...extra],
          });
        }
      } else {
        threadId = await mailstore.upsertThread({
          workspaceId,
          providerThreadId: threadKey,
          subject: summary.subject,
          participants: [summary.from, ...summary.to, ...summary.cc].filter(
            (p): p is Person => p !== null && p.email !== "",
          ),
          lastActivity: summary.date,
          unread: !summary.flags.seen,
          starred: summary.flags.flagged,
        });
        arrived = true;
      }
      for (const child of childThreads) {
        if (child.threadId === threadId) continue;
        await mailstore.mergeThreads(child.threadId, threadId);
        await db
          .update(syncMessages)
          .set({ threadId, threadKey })
          .where(
            and(
              eq(syncMessages.workspaceId, workspaceId),
              eq(syncMessages.threadId, child.threadId),
            ),
          );
      }
      messageId = await mailstore.upsertMessage({
        threadId,
        providerMessageId: summary.id,
        from,
        to: summary.to,
        cc: summary.cc,
        date: summary.date,
        headers: summary.headers,
        bodyText: "",
        bodyHtml: null,
        snippet: summary.preview ?? "",
      });
    }

    await db
      .insert(syncMessages)
      .values({
        workspaceId,
        providerId: summary.id,
        messageId,
        threadId,
        threadKey,
        rfcMessageId: summary.messageId,
        references: [
          ...new Set([summary.inReplyTo, ...summary.references].filter((r): r is string => !!r)),
        ],
        subjectKey: normalizeSubject(summary.subject),
        participants,
        mailboxIds: summary.mailboxIds,
        seen: summary.flags.seen,
        flagged: summary.flags.flagged,
        date: new Date(summary.date),
        bodyState: twin ? twin.bodyState : "pending",
        stale: false,
      })
      .onConflictDoNothing();
    await refreshThread(threadId, map);
    touch(acct.id, threadId);
    if (arrived && arrivalHook) {
      await arrivalHook({
        accountId: acct.id,
        workspaceId,
        threadId,
        lastActivity: summary.date,
      }).catch((error) => log(`arrival hook: ${error instanceof Error ? error.message : error}`));
    }
    return "added";
  }

  async function applyChanged(
    acct: AccountRow,
    providerId: string,
    flags: Flags,
    mailboxIds: string[],
    map: MailboxMap,
    row?: MirrorRow | null,
  ): Promise<boolean> {
    const existing = row ?? (await mirror(acct.workspaceId, providerId));
    if (!existing) return false;
    await db
      .update(syncMessages)
      .set({ seen: flags.seen, flagged: flags.flagged, mailboxIds, stale: false, updatedAt: now() })
      .where(
        and(
          eq(syncMessages.workspaceId, acct.workspaceId),
          eq(syncMessages.providerId, providerId),
        ),
      );
    await refreshThread(existing.threadId, map);
    return true;
  }

  async function applyRemoved(
    acct: AccountRow,
    providerId: string,
    map: MailboxMap,
  ): Promise<boolean> {
    const existing = await mirror(acct.workspaceId, providerId);
    if (!existing) return false;
    await db
      .delete(syncMessages)
      .where(
        and(
          eq(syncMessages.workspaceId, acct.workspaceId),
          eq(syncMessages.providerId, providerId),
        ),
      );
    const [others] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(syncMessages)
      .where(eq(syncMessages.messageId, existing.messageId));
    if ((others?.count ?? 0) === 0) {
      const result = await mailstore.deleteMessage(existing.messageId);
      if (!result.threadDeleted) await refreshThread(existing.threadId, map);
    } else {
      await refreshThread(existing.threadId, map);
    }
    return true;
  }

  /** A reset: everything in the mailbox is suspect until the Provider yields it again. */
  async function markStale(workspaceId: string, mailboxId: string): Promise<void> {
    await db
      .update(syncMessages)
      .set({ stale: true })
      .where(
        and(
          eq(syncMessages.workspaceId, workspaceId),
          sql`${mailboxId} = any(${syncMessages.mailboxIds})`,
        ),
      );
  }

  /** After a reset completes: whatever the Provider did not yield again is gone. */
  async function dropStale(acct: AccountRow, mailboxId: string, map: MailboxMap): Promise<number> {
    const rows = await db
      .select({ providerId: syncMessages.providerId })
      .from(syncMessages)
      .where(
        and(
          eq(syncMessages.workspaceId, acct.workspaceId),
          eq(syncMessages.stale, true),
          sql`${mailboxId} = any(${syncMessages.mailboxIds})`,
        ),
      );
    for (const row of rows) await applyRemoved(acct, row.providerId, map);
    return rows.length;
  }

  /* ------------------------------ Sync passes ------------------------------ */

  async function loadState(acct: AccountRow) {
    const row = await db.query.syncState.findFirst({
      where: eq(syncState.workspaceId, acct.workspaceId),
    });
    return (
      row ?? {
        workspaceId: acct.workspaceId,
        accountId: acct.id,
        tier: null,
        mailboxStates: {} as Record<string, string>,
        pending: [] as string[],
        lastFullSync: null,
        lastReconcile: null,
        lastError: null,
        updatedAt: now(),
      }
    );
  }

  async function saveState(
    acct: AccountRow,
    patch: Partial<typeof syncState.$inferInsert>,
  ): Promise<void> {
    await db
      .insert(syncState)
      .values({ workspaceId: acct.workspaceId, accountId: acct.id, ...patch, updatedAt: now() })
      .onConflictDoUpdate({ target: syncState.workspaceId, set: { ...patch, updatedAt: now() } });
  }

  /**
   * The first sync screen's facts the mirror tables do not hold: the
   * Provider's Inbox total and why the last pass failed. Merged into
   * accounts.sync_state under `firstSync` so push cursors there stay put.
   */
  async function recordFirstSync(acct: AccountRow, patch: Record<string, unknown>): Promise<void> {
    await db
      .update(accounts)
      .set({
        syncState: sql`jsonb_set(coalesce(${accounts.syncState}, '{}'::jsonb), '{firstSync}', coalesce(${accounts.syncState} -> 'firstSync', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)`,
      })
      .where(eq(accounts.id, acct.id));
  }

  async function syncOneMailbox(
    acct: AccountRow,
    s: Session,
    mailbox: Mailbox,
    map: MailboxMap,
    report: SyncReport,
    batch: number,
    deadline: number | undefined,
    /** Runs between pages while the pass is incomplete (the Inbox's newest bodies). */
    afterPage?: () => Promise<void>,
  ): Promise<{ complete: boolean }> {
    const state = await loadState(acct);
    let token: string | null = state.mailboxStates[mailbox.id] ?? null;
    let complete = false;
    // Loop over pages until complete or out of budget.
    for (let guard = 0; guard < 10_000; guard++) {
      let sawState = false;
      for await (const event of s.syncMailbox(mailbox.id, token, { limit: batch })) {
        await applyEvent(acct, mailbox, event, map, report);
        if (event.type === "state") {
          sawState = true;
          token = event.state;
          complete = event.complete;
          if (complete) report.removed += await dropStale(acct, mailbox.id, map);
          const fresh = await loadState(acct);
          const pending = new Set(fresh.pending);
          if (complete) pending.delete(mailbox.id);
          else pending.add(mailbox.id);
          await saveState(acct, {
            mailboxStates: { ...fresh.mailboxStates, [mailbox.id]: token },
            pending: [...pending],
            lastError: null,
          });
        }
      }
      if (!sawState || complete) break;
      if (deadline !== undefined && Date.now() >= deadline) break;
      if (afterPage) await afterPage();
      if (deadline !== undefined && Date.now() >= deadline) break;
    }
    return { complete };
  }

  async function applyEvent(
    acct: AccountRow,
    mailbox: Mailbox,
    event: SyncEvent,
    map: MailboxMap,
    report: SyncReport,
  ): Promise<void> {
    switch (event.type) {
      case "reset":
        await markStale(acct.workspaceId, mailbox.id);
        return;
      case "added": {
        const outcome = await applyAdded(acct, event.message, map);
        if (outcome === "added") report.added += 1;
        else report.changed += 1;
        return;
      }
      case "changed":
        if (await applyChanged(acct, event.id, event.flags, event.mailboxIds, map)) {
          report.changed += 1;
        }
        return;
      case "removed":
        if (await applyRemoved(acct, event.id, map)) report.removed += 1;
        return;
      case "state":
        return;
    }
  }

  async function fetchBodies(
    acct: AccountRow,
    s: Session,
    windowDays: number,
    deadline: number | undefined,
    report: SyncReport,
    onlyMailbox: string | null = null,
  ): Promise<{ more: boolean }> {
    const since = new Date(now().getTime() - windowDays * 86_400_000);
    // Anything older than the window waits for the reader.
    await db
      .update(syncMessages)
      .set({ bodyState: "deferred" })
      .where(
        and(
          eq(syncMessages.workspaceId, acct.workspaceId),
          eq(syncMessages.bodyState, "pending"),
          sql`${syncMessages.date} < ${since.toISOString()}::timestamptz`,
        ),
      );
    const rows = await db
      .select({ providerId: syncMessages.providerId, messageId: syncMessages.messageId })
      .from(syncMessages)
      .where(
        and(
          eq(syncMessages.workspaceId, acct.workspaceId),
          eq(syncMessages.bodyState, "pending"),
          eq(syncMessages.stale, false),
          ...(onlyMailbox ? [sql`${onlyMailbox} = any(${syncMessages.mailboxIds})`] : []),
        ),
      )
      .orderBy(desc(syncMessages.date))
      .limit(BODIES_PER_PASS + 1);
    const batch = rows.slice(0, BODIES_PER_PASS);
    // A few at once, newest first: each waits its turn at the quota bucket,
    // so this is as fast as the Provider allows rather than one round trip
    // after another.
    const width = Math.max(1, (await readSettings()).bodyConcurrency);
    let next = 0;
    let outOfTime = false;
    const worker = async () => {
      for (;;) {
        if (deadline !== undefined && Date.now() >= deadline) {
          outOfTime = true;
          return;
        }
        const row = batch[next++];
        if (!row) return;
        await storeBody(acct, s, row.providerId, row.messageId);
        report.bodies += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, batch.length) }, worker));
    if (outOfTime && next <= batch.length) return { more: true };
    return { more: rows.length > BODIES_PER_PASS };
  }

  async function storeBody(
    acct: AccountRow,
    s: Session,
    providerId: string,
    messageId: string,
  ): Promise<void> {
    const raw = await s.fetchMessage(providerId);
    const row = await db.query.syncMessages.findFirst({
      where: and(
        eq(syncMessages.workspaceId, acct.workspaceId),
        eq(syncMessages.providerId, providerId),
      ),
    });
    if (!row) return;
    const message = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
    if (!message) return;
    const headers = { ...message.headers };
    for (const [name, value] of Object.entries(raw.headers))
      if (!(name in headers)) headers[name] = value;
    await mailstore.upsertMessage({
      threadId: message.threadId,
      providerMessageId: message.providerMessageId,
      from: message.from,
      to: message.to,
      cc: message.cc,
      date: message.date.toISOString(),
      headers,
      bodyText: raw.text,
      bodyHtml: raw.html,
      snippet: snippetOf(raw.text),
    });
    for (const attachment of raw.attachments) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of attachment.content()) chunks.push(chunk);
      const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      await mailstore.putAttachment(messageId, {
        name: attachment.name,
        mediaType: attachment.mediaType,
        bytes,
        contentId: attachment.contentId,
        inline: attachment.inline,
      });
    }
    await db
      .update(syncMessages)
      .set({ bodyState: "fetched", updatedAt: now() })
      .where(eq(syncMessages.messageId, messageId));
    touch(acct.id, message.threadId);
    if (bodyObserver) {
      try {
        await bodyObserver(
          { id: acct.id, workspaceId: acct.workspaceId, address: acct.address },
          messageId,
          message.threadId,
          raw,
        );
      } catch (error) {
        log(`body observer ${messageId}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  /**
   * Drafts the Provider holds that no Server Draft mirrors become Server
   * Drafts (ADR 0010: Drafts are Server-owned). Runs after the header pass so
   * the mirror rows are current; bodies are fetched here because the Drafts
   * mailbox is small and a Draft is useless without its text.
   */
  async function importDrafts(acct: AccountRow, s: Session, map: MailboxMap): Promise<number> {
    if (!draftImporter || !knownDraftIds) return 0;
    const draftsBox = map.mailboxes.find((m) => m.role === "drafts");
    if (!draftsBox) return 0;
    const known = await knownDraftIds(acct.workspaceId);
    const rows = await db
      .select({
        providerId: syncMessages.providerId,
        messageId: syncMessages.messageId,
        rfcMessageId: syncMessages.rfcMessageId,
      })
      .from(syncMessages)
      .where(
        and(
          eq(syncMessages.workspaceId, acct.workspaceId),
          eq(syncMessages.stale, false),
          sql`${draftsBox.id} = any(${syncMessages.mailboxIds})`,
        ),
      )
      .orderBy(desc(syncMessages.date))
      .limit(200);
    let imported = 0;
    for (const row of rows) {
      if (known.has(row.providerId)) continue;
      // monday's own mirror, under a Provider id the Draft row does not hold (a Gmail draft id).
      if (isMirrorMessageId(row.rfcMessageId)) continue;
      const message = await db.query.messages.findFirst({ where: eq(messages.id, row.messageId) });
      if (!message) continue;
      const raw = await s.fetchMessage(row.providerId);
      const summary: MessageSummary = {
        id: row.providerId,
        threadId: null,
        mailboxIds: [draftsBox.id],
        flags: { seen: true, flagged: false, answered: false, draft: true, keywords: [] },
        from: message.from,
        to: message.to,
        cc: message.cc,
        subject: raw.headers.subject ?? "",
        date: message.date.toISOString(),
        receivedAt: message.date.toISOString(),
        messageId: null,
        inReplyTo: null,
        references: [],
        headers: message.headers,
        size: 0,
        hasAttachments: raw.attachments.length > 0,
        preview: null,
      };
      await draftImporter({
        accountId: acct.id,
        workspaceId: acct.workspaceId,
        providerId: row.providerId,
        summary,
        raw,
      });
      imported += 1;
    }
    return imported;
  }

  /* ------------------------------ Watchers ------------------------------ */

  async function enqueueSync(accountId: string, mailboxIds?: string[]): Promise<void> {
    if (!jobsRef) return;
    const bucket = Math.floor(now().getTime() / debounceMs);
    await jobsRef.enqueue(
      SYNC_STEP,
      {
        accountId,
        ...(mailboxIds && mailboxIds.length > 0 ? { mailboxIds } : {}),
      } satisfies SyncPayload,
      { id: `${SYNC_STEP}:${accountId}:${bucket}` },
    );
  }

  async function startWatcher(acct: AccountRow): Promise<Watcher> {
    const s = await session(acct);
    const settingsNow = await readSettings();
    const map = await syncMailboxList(acct.workspaceId, s);
    const hot = syncable(map.mailboxes)
      .slice(0, settingsNow.hotFolders)
      .map((m) => m.id);
    const watch = s.watch(hot);
    const done = (async () => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let pendingMailboxes = new Set<string>();
      const flush = () => {
        timer = null;
        const ids = [...pendingMailboxes];
        pendingMailboxes = new Set();
        enqueueSync(acct.id, ids).catch((error) => log(`enqueue sync failed: ${error}`));
      };
      try {
        for await (const event of watch.events) {
          if (event.type === "changed") {
            for (const id of event.mailboxIds) pendingMailboxes.add(id);
            if (!timer) timer = setTimeout(flush, debounceMs);
          } else if (event.type === "connected") {
            // Anything that happened while the stream was down is unknown: sync.
            if (!timer) timer = setTimeout(flush, debounceMs);
          } else {
            log(`push for ${acct.id} disconnected: ${event.reason}`);
          }
        }
      } catch (error) {
        log(`watch for ${acct.id} ended: ${error}`);
      } finally {
        if (timer) {
          clearTimeout(timer);
          flush();
        }
        watchers.delete(acct.id);
      }
    })();
    const watcher = { watch, done, supported: watch.supported };
    watchers.set(acct.id, watcher);
    return watcher;
  }

  /* ------------------------------ The engine ------------------------------ */

  // One pass per Account at a time: with several job workers, the sync and
  // the reconcile of one Account queue behind each other instead of paging
  // the same mailboxes (and spending the same quota) at once.
  const accountLocks = new Map<string, Promise<unknown>>();
  function oneAtATime<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    const before = accountLocks.get(accountId) ?? Promise.resolve();
    const run = before.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    accountLocks.set(accountId, tail);
    void tail.then(() => {
      if (accountLocks.get(accountId) === tail) accountLocks.delete(accountId);
    });
    return run;
  }

  async function syncAccountNow(
    accountId: string,
    opts: Parameters<SyncEngine["syncAccount"]>[1] = {},
  ): Promise<SyncReport> {
    const acct = await account(accountId);
    const report: SyncReport = {
      accountId,
      added: 0,
      changed: 0,
      removed: 0,
      bodies: 0,
      more: false,
    };
    const settingsNow = await readSettings();
    const deadline = opts.deadline;
    const outOfTime = () => deadline !== undefined && Date.now() >= deadline;
    try {
      await withSession(acct, async (s) => {
        const map = await syncMailboxList(acct.workspaceId, s);
        await saveState(acct, { tier: s.capabilities().syncTier });
        const inbox = map.mailboxes.find((m) => m.role === "inbox") ?? null;
        if (inbox && inbox.totalMessages !== null) {
          await recordFirstSync(acct, { inboxTotal: inbox.totalMessages });
        }
        const wanted = opts.mailboxIds ? new Set(opts.mailboxIds) : null;
        const state = await loadState(acct);
        const pending = new Set(state.pending);
        const targets = syncable(map.mailboxes).filter(
          (m) => !wanted || wanted.has(m.id) || pending.has(m.id),
        );
        for (const mailbox of targets) {
          if (outOfTime()) {
            report.more = true;
            break;
          }
          // A large Inbox pages its headers for hours at the Provider's
          // quota; its newest bodies keep pace page by page rather than
          // waiting for the last header, so what the user sees first reads.
          const interleave =
            mailbox.role === "inbox" && !opts.headersOnly
              ? async () => {
                  await fetchBodies(
                    acct,
                    s,
                    settingsNow.bodyWindowDays,
                    deadline,
                    report,
                    mailbox.id,
                  );
                }
              : undefined;
          // Each pass opens with the newest Inbox bodies, so they arrive even
          // when a paced header page outlasts the Job's budget.
          if (interleave && pending.has(mailbox.id)) await interleave();
          const { complete } = await syncOneMailbox(
            acct,
            s,
            mailbox,
            map,
            report,
            settingsNow.batchSize,
            deadline,
            interleave,
          );
          if (!complete) {
            report.more = true;
            continue;
          }
          // The Inbox's window bodies follow its headers at once, before the
          // other folders, so the first sync screen can let the app open.
          if (mailbox.role === "inbox" && !opts.headersOnly) {
            for (;;) {
              if (outOfTime()) {
                report.more = true;
                break;
              }
              const inboxBodies = await fetchBodies(
                acct,
                s,
                settingsNow.bodyWindowDays,
                deadline,
                report,
                mailbox.id,
              );
              if (!inboxBodies.more) break;
            }
          }
        }
        if (!opts.headersOnly && !outOfTime()) {
          const bodies = await fetchBodies(acct, s, settingsNow.bodyWindowDays, deadline, report);
          if (bodies.more) report.more = true;
        }
        if (!opts.headersOnly && !outOfTime()) await importDrafts(acct, s, map);
        await notifyTouched(acct);
        if (!report.more) {
          const fresh = await loadState(acct);
          await saveState(acct, {
            lastReconcile: now(),
            ...(fresh.lastFullSync ? {} : { lastFullSync: now() }),
          });
        }
      });
    } catch (error) {
      await saveState(acct, {
        lastError: error instanceof Error ? error.message : String(error),
      });
      const code = (error as Partial<ProviderError>).code ?? null;
      await recordFirstSync(acct, { errorCode: code }).catch(() => {});
      throw error;
    }
    return report;
  }

  const engine: SyncEngine = {
    async session(accountId) {
      return session(await account(accountId));
    },

    async wake(accountId, mailboxIds) {
      await enqueueSync(accountId, mailboxIds);
    },

    async syncAccount(accountId, opts = {}) {
      return oneAtATime(accountId, () => syncAccountNow(accountId, opts));
    },

    async fetchBody(messageId) {
      const row = await db.query.syncMessages.findFirst({
        where: eq(syncMessages.messageId, messageId),
      });
      if (!row) throw new Error(`message ${messageId} is not synced`);
      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, row.workspaceId),
      });
      if (!workspace) throw new Error(`workspace ${row.workspaceId} not found`);
      const acct = await account(workspace.accountId);
      await withSession(acct, (s) => storeBody(acct, s, row.providerId, messageId));
      await notifyTouched(acct);
    },

    async withSession(accountId, fn) {
      return withSession(await account(accountId), fn);
    },

    async pacing(accountId) {
      const pending = sessions.get(accountId);
      if (!pending) return false;
      const open = await pending.catch(() => null);
      return open?.pacing?.() ?? false;
    },

    setArrivalHook(hook) {
      arrivalHook = hook;
    },

    setDraftImporter(importer, known) {
      draftImporter = importer;
      knownDraftIds = known;
    },

    setThreadObserver(observer) {
      threadObserver = observer;
      if (!observer) touched.clear();
    },

    setBodyObserver(observer) {
      bodyObserver = observer;
    },

    async recordIntent(intent, workspaceId) {
      const rows = await db
        .select()
        .from(syncMessages)
        .where(
          and(
            eq(syncMessages.workspaceId, workspaceId),
            eq(syncMessages.threadId, intent.threadId),
          ),
        );
      if (rows.length === 0) return;
      const map = await mailboxMapFromLabels(workspaceId);
      const accountId = await accountIdOf(workspaceId);
      if (!accountId) return;
      const acct = await account(accountId);
      const change = providerChangeOf(intent, {
        inboxId: map.inboxId,
        trashId: map.mailboxes.find((m) => m.role === "trash")?.id ?? null,
        labels: acct.labels,
      });
      if (!change) return;
      // The mirror takes the user's word now; the pass never flips the row back while the Job is on its way.
      for (const row of rows) {
        await db
          .update(syncMessages)
          .set({ ...localEffect(row, change, map), updatedAt: now() })
          .where(
            and(
              eq(syncMessages.workspaceId, workspaceId),
              eq(syncMessages.providerId, row.providerId),
            ),
          );
      }
      await refreshThread(intent.threadId, map);
      if (!jobsRef) return;
      const payload: ChangePayload = { accountId, threadId: intent.threadId, change };
      await jobsRef.enqueue(CHANGE_STEP, payload, {
        id: `${CHANGE_STEP}:${intent.threadId}:${intent.kind}:${intent.at}`,
      });
    },

    async applyChange(accountId, target, change) {
      const acct = await account(accountId);
      const rows =
        "threadId" in target
          ? await db
              .select()
              .from(syncMessages)
              .where(
                and(
                  eq(syncMessages.workspaceId, acct.workspaceId),
                  eq(syncMessages.threadId, target.threadId),
                ),
              )
          : await db
              .select()
              .from(syncMessages)
              .where(
                and(
                  eq(syncMessages.workspaceId, acct.workspaceId),
                  inArray(syncMessages.messageId, target.messageIds),
                ),
              );
      if (rows.length === 0) return;
      await withSession(acct, async (s) => {
        await s.applyChange({ messageIds: rows.map((r) => r.providerId) }, change);
        const map = await syncMailboxList(acct.workspaceId, s);
        // Mirror what the Provider will report, so the list is right before the next sync.
        for (const row of rows) {
          const patch = localEffect(row, change, map);
          await db
            .update(syncMessages)
            .set({ ...patch, updatedAt: now() })
            .where(
              and(
                eq(syncMessages.workspaceId, acct.workspaceId),
                eq(syncMessages.providerId, row.providerId),
              ),
            );
        }
        for (const threadId of new Set(rows.map((r) => r.threadId)))
          await refreshThread(threadId, map);
      });
    },

    async watch(accountId) {
      const existing = watchers.get(accountId);
      if (existing) return { supported: existing.supported, running: true };
      const acct = await account(accountId);
      const watcher = await startWatcher(acct);
      if (!watcher.supported) {
        await watcher.watch.stop();
        return { supported: false, running: false };
      }
      return { supported: true, running: true };
    },

    async unwatch(accountId) {
      const existing = watchers.get(accountId);
      if (!existing) return;
      watchers.delete(accountId);
      await existing.watch.stop();
      await existing.done;
    },

    registerSteps(jobs) {
      jobsRef = jobs;
      jobs.registerStep<SyncPayload>(SYNC_STEP, async (job, ctx) => {
        const report = await engine.syncAccount(job.payload.accountId, {
          deadline: ctx.deadline - 5_000,
          ...(job.payload.mailboxIds ? { mailboxIds: job.payload.mailboxIds } : {}),
        });
        return report.more ? "again" : "done";
      });
      jobs.registerStep<SyncPayload>(WATCH_STEP, async (job) => {
        const { supported, running } = await engine.watch(job.payload.accountId);
        if (!supported) return "done";
        return running ? { sleepMs: WATCH_RENEW_MS } : "again";
      });
      jobs.registerStep<ChangePayload>(CHANGE_STEP, async (job) => {
        await engine.applyChange(
          job.payload.accountId,
          { threadId: job.payload.threadId },
          job.payload.change,
        );
        return "done";
      });
      jobs.registerStep<SyncPayload>(RECONCILE_STEP, async (job, ctx) => {
        const settingsNow = await readSettings();
        const report = await engine.syncAccount(job.payload.accountId, {
          deadline: ctx.deadline - 5_000,
        });
        if (report.more) return "again";
        return { sleepMs: settingsNow.reconcileMinutes * 60_000 };
      });
    },

    async startAccount(jobs, accountId) {
      const payload: SyncPayload = { accountId };
      await jobs.enqueue(SYNC_STEP, payload, { id: `${SYNC_STEP}:${accountId}:initial` });
      await jobs.enqueue(WATCH_STEP, payload, {
        id: `${WATCH_STEP}:${accountId}`,
        needs: ["needs-process"],
      });
      await jobs.enqueue(RECONCILE_STEP, payload, { id: `${RECONCILE_STEP}:${accountId}` });
    },

    async forget(accountId) {
      await engine.unwatch(accountId);
      await dropSession(accountId);
      touched.delete(accountId);
    },

    async close() {
      for (const id of [...watchers.keys()]) await engine.unwatch(id);
      for (const id of [...sessions.keys()]) await dropSession(id);
    },
  };

  /** What an action does to a mirror row, per inbox.md. */
  function localEffect(
    row: typeof syncMessages.$inferSelect,
    change: Change,
    map: MailboxMap,
  ): Partial<typeof syncMessages.$inferInsert> {
    const roleId = (role: string) => map.mailboxes.find((m) => m.role === role)?.id ?? null;
    switch (change.kind) {
      case "read":
        return { seen: change.value };
      case "star":
        return { flagged: change.value };
      case "archive": {
        const inbox = map.inboxId;
        const rest = row.mailboxIds.filter((m) => m !== inbox);
        const archive = roleId("archive");
        return { mailboxIds: rest.length > 0 ? rest : archive ? [archive] : rest };
      }
      case "delete": {
        const trash = roleId("trash");
        return trash ? { mailboxIds: [trash] } : {};
      }
      case "move":
        return { mailboxIds: [change.mailboxId] };
      case "label":
        return {
          mailboxIds: [
            ...new Set([
              ...row.mailboxIds.filter((m) => !change.remove.includes(m)),
              ...change.add,
            ]),
          ],
        };
    }
  }

  return engine;
}

/** For tests and diagnostics: the mirror rows of a Workspace. */
export async function mirrorRows(db: Db, workspaceId: string) {
  return db
    .select()
    .from(syncMessages)
    .where(eq(syncMessages.workspaceId, workspaceId))
    .orderBy(asc(syncMessages.providerId));
}

export async function labelRows(db: Db, workspaceId: string) {
  return db.select().from(labels).where(eq(labels.workspaceId, workspaceId));
}
