// Snooze wakes (docs/spec/inbox.md, "Action semantics"): a snooze leaves the
// Inbox with archive semantics and stores a wake time on the Thread; a Job
// returns it to the Inbox as unread at the top of its Section. The wake is a
// `thread.unsnooze` Job armed when a snooze intent wins (the Mailstore's
// intent observer hands it here beside the sync engine) and re-armed for
// every Thread still asleep when a Server boots, so an install that
// predates the Job catches up. The wake itself is two automation intents,
// unsnooze and unread, through the same Mailstore path a Device uses, so it
// obeys last-writer-wins, lands in the Changes feed and reaches the Provider.

import type { Intent } from "@monday/shared";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { threads } from "./db/schema.ts";
import type { Job, Jobs } from "./jobs/index.ts";
import type { Mailstore } from "./mailstore/index.ts";

export const UNSNOOZE_STEP = "thread.unsnooze";

export interface SnoozePayload {
  workspaceId: string;
  threadId: string;
  /** The wake time this Job was armed for; a later snooze makes it stand down. */
  until: string;
}

export interface SnoozeWaker {
  /** The Mailstore intent observer: a winning snooze arms its wake. */
  observe(intent: Intent, workspaceId: string): Promise<void>;
  /** Arms a wake for every Thread still asleep; idempotent. Returns how many. */
  armAll(): Promise<number>;
  /** Wakes one Thread now if its time has come; the Job step's body. */
  wake(threadId: string): Promise<"woken" | "asleep" | "gone">;
  registerSteps(jobs: Jobs): void;
}

export interface SnoozeWakerOptions {
  db: Db;
  mailstore: Mailstore;
  now?: () => Date;
  log?: (message: string) => void;
}

export function jobIdFor(threadId: string, until: string): string {
  return `${UNSNOOZE_STEP}:${threadId}:${until}`;
}

export function createSnoozeWaker(options: SnoozeWakerOptions): SnoozeWaker {
  const { db, mailstore } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  let jobs: Jobs | null = null;

  const arm = async (workspaceId: string, threadId: string, until: Date): Promise<void> => {
    if (!jobs) return;
    const payload: SnoozePayload = { workspaceId, threadId, until: until.toISOString() };
    await jobs.enqueue(UNSNOOZE_STEP, payload, {
      id: jobIdFor(threadId, until.toISOString()),
      runAt: until,
    });
  };

  const waker: SnoozeWaker = {
    async observe(intent, workspaceId) {
      if (intent.kind !== "snooze") return;
      await arm(workspaceId, intent.threadId, new Date(intent.until));
    },

    async armAll() {
      const rows = await db
        .select({ id: threads.id, workspaceId: threads.workspaceId, until: threads.snoozedUntil })
        .from(threads)
        .where(isNotNull(threads.snoozedUntil));
      for (const row of rows) if (row.until) await arm(row.workspaceId, row.id, row.until);
      return rows.length;
    },

    async wake(threadId) {
      const row = await db.query.threads.findFirst({
        where: and(eq(threads.id, threadId), isNotNull(threads.snoozedUntil)),
        columns: { id: true, snoozedUntil: true },
      });
      if (!row?.snoozedUntil) return "gone";
      if (row.snoozedUntil.getTime() > now().getTime()) return "asleep";
      const at = now().toISOString();
      const back = await mailstore.applyIntent({
        kind: "unsnooze",
        threadId,
        at,
        actor: "automation",
      });
      if (!back.applied) {
        log(`unsnooze ${threadId} lost to a newer write: ${back.reason}`);
        return "gone";
      }
      await mailstore.applyIntent({ kind: "unread", threadId, at, actor: "automation" });
      // Back at the top of its Section: the wake is the Thread's newest activity.
      await mailstore.updateThread(threadId, { lastActivity: at });
      return "woken";
    },

    registerSteps(target) {
      jobs = target;
      target.registerStep<SnoozePayload>(UNSNOOZE_STEP, async (job: Job<SnoozePayload>) => {
        const outcome = await waker.wake(job.payload.threadId);
        if (outcome !== "asleep") return "done";
        // Snoozed again for later: this Job stands down; the later snooze armed its own.
        const row = await db.query.threads.findFirst({
          where: eq(threads.id, job.payload.threadId),
          columns: { snoozedUntil: true },
        });
        const until = row?.snoozedUntil?.getTime() ?? 0;
        const target = Date.parse(job.payload.until);
        if (until !== target) return "done";
        return { sleepMs: Math.max(1_000, until - now().getTime()) };
      });
    },
  };
  return waker;
}

/** For tests and diagnostics: the Threads whose wake time has passed. */
export async function overdueSnoozes(db: Db, at: Date) {
  return db
    .select({ id: threads.id })
    .from(threads)
    .where(and(isNotNull(threads.snoozedUntil), lte(threads.snoozedUntil, at)));
}
