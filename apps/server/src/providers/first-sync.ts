// The first sync's progress, read from the mirror (docs/spec/onboarding.md,
// "First sync"; the definition lives in @monday/shared first-sync.ts). The
// counts come from sync_messages and its body_state, completeness from the
// engine's per-mailbox paging state, the Inbox total and the last failure's
// kind from what the engine records under accounts.sync_state.firstSync.
//
// Completion latches: once a phase is complete for a Workspace it stays
// complete, so new mail arriving after the first sync never brings the
// screen back. A Workspace whose full pass ever finished (lastFullSync) has
// its headers complete; its bodies still count, since a headers-only pass
// also sets it.

import type { FirstSyncErrorKind, FirstSyncProgress, Provider } from "@monday/shared";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { accounts, labels, syncMessages, syncState, workspaces } from "../db/schema.ts";
import { readGlobalSettings } from "../settings/read.ts";
import { readSyncSettings, type SyncEngine } from "./sync.ts";

/** What the engine keeps under accounts.sync_state.firstSync. */
interface FirstSyncRecord {
  inboxTotal?: number;
  errorCode?: string | null;
  headersAt?: string;
  bodiesAt?: string;
}

export interface FirstSyncReader {
  /** The Account's progress; null when there is no such Account. */
  read(accountId: string): Promise<FirstSyncProgress | null>;
  /** Clears the recorded failure and asks the engine for a pass now. False when there is no such Account. */
  retry(accountId: string): Promise<boolean>;
}

export interface FirstSyncReaderOptions {
  db: Db;
  sync: SyncEngine;
  /** The body window; defaults to the stored Setting. */
  bodyWindowDays?: () => Promise<number>;
  /**
   * How many of the newest Inbox Messages the wait covers (headers, then
   * bodies); 0 means the whole Inbox. Defaults to the stored Settings.
   */
  limits?: () => Promise<{ messages: number; bodies: number }>;
  now?: () => Date;
}

function errorKind(code: string | null | undefined): FirstSyncErrorKind {
  if (code === "auth") return "auth";
  if (code === "network") return "network";
  return "other";
}

export function createFirstSyncReader(options: FirstSyncReaderOptions): FirstSyncReader {
  const { db, sync } = options;
  const now = options.now ?? (() => new Date());
  const windowDays =
    options.bodyWindowDays ?? (async () => (await readSyncSettings(db)).bodyWindowDays);
  const limits =
    options.limits ??
    (async () => {
      const s = await readGlobalSettings(db, [
        "sync.first_run_messages",
        "sync.first_run_bodies",
      ] as const);
      return { messages: s["sync.first_run_messages"], bodies: s["sync.first_run_bodies"] };
    });

  async function latch(accountId: string, patch: FirstSyncRecord): Promise<void> {
    await db
      .update(accounts)
      .set({
        syncState: sql`jsonb_set(coalesce(${accounts.syncState}, '{}'::jsonb), '{firstSync}', coalesce(${accounts.syncState} -> 'firstSync', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)`,
      })
      .where(eq(accounts.id, accountId));
  }

  return {
    async read(accountId) {
      const [row] = await db
        .select({
          id: accounts.id,
          provider: accounts.provider,
          address: accounts.address,
          syncState: accounts.syncState,
          workspaceId: workspaces.id,
        })
        .from(accounts)
        .innerJoin(workspaces, eq(workspaces.accountId, accounts.id))
        .where(eq(accounts.id, accountId));
      if (!row) return null;
      const record = ((row.syncState as { firstSync?: FirstSyncRecord } | null)?.firstSync ??
        {}) as FirstSyncRecord;
      const state = await db.query.syncState.findFirst({
        where: eq(syncState.workspaceId, row.workspaceId),
      });
      const [inboxLabel] = await db
        .select({ providerId: labels.providerId })
        .from(labels)
        .where(and(eq(labels.workspaceId, row.workspaceId), eq(labels.role, "inbox")))
        .limit(1);
      const inboxId = inboxLabel?.providerId ?? null;

      let found = 0;
      let bodiesTotal = 0;
      let bodiesDone = 0;
      const lim = await limits();
      if (inboxId) {
        const inInbox = and(
          eq(syncMessages.workspaceId, row.workspaceId),
          eq(syncMessages.stale, false),
          sql`${inboxId} = any(${syncMessages.mailboxIds})`,
        );
        const since = new Date(now().getTime() - (await windowDays()) * 86_400_000);
        const [headers] = await db.select({ n: count() }).from(syncMessages).where(inInbox);
        found = Number(headers?.n ?? 0);
        // The bodies the wait covers: the newest Inbox Messages inside the body
        // window, at most `bodies` of them (0: every one in the window).
        const newest = db
          .select({ bodyState: syncMessages.bodyState })
          .from(syncMessages)
          .where(and(inInbox, gte(syncMessages.date, since)))
          .orderBy(desc(syncMessages.date))
          .$dynamic();
        const covered = lim.bodies > 0 ? await newest.limit(lim.bodies) : await newest;
        bodiesTotal = covered.length;
        bodiesDone = covered.filter((r) => r.bodyState === "fetched").length;
      }

      const fullPass = state?.lastFullSync != null;
      // The Inbox finished its first paging: it has a cursor and is not pending.
      const inboxPaged =
        inboxId !== null &&
        state !== undefined &&
        state.mailboxStates[inboxId] !== undefined &&
        !state.pending.includes(inboxId);
      // The wait covers the newest `messages` Inbox Messages (0: all of them); the
      // provider pages newest first, so once that many are in, they are the newest.
      const inboxTotal = record.inboxTotal ?? null;
      // Before the provider reports its total, the wait still ends once the
      // newest `messages` are in: there are at least that many.
      const target =
        inboxTotal === null
          ? null
          : lim.messages > 0
            ? Math.min(lim.messages, inboxTotal)
            : inboxTotal;
      const enough =
        target !== null ? target > 0 && found >= target : lim.messages > 0 && found >= lim.messages;
      const headersComplete = record.headersAt !== undefined || fullPass || inboxPaged || enough;
      const bodiesComplete =
        record.bodiesAt !== undefined || (headersComplete && bodiesDone >= bodiesTotal);

      const stamp: FirstSyncRecord = {};
      if (headersComplete && record.headersAt === undefined) stamp.headersAt = now().toISOString();
      if (bodiesComplete && record.bodiesAt === undefined) stamp.bodiesAt = now().toISOString();
      if (Object.keys(stamp).length > 0) await latch(row.id, stamp);

      const total = target;
      return {
        accountId: row.id,
        workspaceId: row.workspaceId,
        provider: row.provider as Provider,
        address: row.address,
        headers: {
          done: total === null ? found : headersComplete ? total : Math.min(found, total),
          total,
          complete: headersComplete,
          ...(inboxTotal !== null && target !== null && inboxTotal > target ? { inboxTotal } : {}),
        },
        bodies: {
          done: bodiesComplete ? Math.max(bodiesDone, bodiesTotal) : bodiesDone,
          total: bodiesTotal,
          complete: bodiesComplete,
        },
        pacing: await sync.pacing(row.id).catch(() => false),
        error: state?.lastError
          ? { kind: errorKind(record.errorCode), message: state.lastError }
          : null,
        at: now().toISOString(),
      };
    },

    async retry(accountId) {
      const row = await db.query.workspaces.findFirst({
        where: eq(workspaces.accountId, accountId),
      });
      if (!row) return false;
      await db
        .update(syncState)
        .set({ lastError: null, updatedAt: now() })
        .where(eq(syncState.workspaceId, row.id));
      await sync.wake(accountId);
      return true;
    },
  };
}
