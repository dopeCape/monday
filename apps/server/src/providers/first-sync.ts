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
import { and, count, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { accounts, labels, syncMessages, syncState, workspaces } from "../db/schema.ts";
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
      if (inboxId) {
        const inInbox = and(
          eq(syncMessages.workspaceId, row.workspaceId),
          eq(syncMessages.stale, false),
          sql`${inboxId} = any(${syncMessages.mailboxIds})`,
        );
        const since = new Date(now().getTime() - (await windowDays()) * 86_400_000);
        const [headers] = await db.select({ n: count() }).from(syncMessages).where(inInbox);
        const [windowed] = await db
          .select({
            n: count(),
            fetched: sql<number>`count(*) filter (where ${syncMessages.bodyState} = 'fetched')`,
          })
          .from(syncMessages)
          .where(and(inInbox, gte(syncMessages.date, since)));
        found = Number(headers?.n ?? 0);
        bodiesTotal = Number(windowed?.n ?? 0);
        bodiesDone = Number(windowed?.fetched ?? 0);
      }

      const fullPass = state?.lastFullSync != null;
      // The Inbox finished its first paging: it has a cursor and is not pending.
      const inboxPaged =
        inboxId !== null &&
        state !== undefined &&
        state.mailboxStates[inboxId] !== undefined &&
        !state.pending.includes(inboxId);
      const headersComplete = record.headersAt !== undefined || fullPass || inboxPaged;
      const bodiesComplete =
        record.bodiesAt !== undefined || (headersComplete && bodiesDone >= bodiesTotal);

      const stamp: FirstSyncRecord = {};
      if (headersComplete && record.headersAt === undefined) stamp.headersAt = now().toISOString();
      if (bodiesComplete && record.bodiesAt === undefined) stamp.bodiesAt = now().toISOString();
      if (Object.keys(stamp).length > 0) await latch(row.id, stamp);

      const total = record.inboxTotal ?? null;
      return {
        accountId: row.id,
        workspaceId: row.workspaceId,
        provider: row.provider as Provider,
        address: row.address,
        headers: {
          done: headersComplete && total !== null ? Math.max(found, total) : found,
          total: total === null ? null : Math.max(total, headersComplete ? found : 0),
          complete: headersComplete,
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
