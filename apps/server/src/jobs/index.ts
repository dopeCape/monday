// Jobs: the leased step runner over the jobs table (ADR 0005, research 22).
// Every background action is an idempotent, time-budgeted row. A Server claims
// rows whose needs it can serve, runs the registered step inside the budget,
// and reports done, again (more work, requeue now) or a sleep.

import { and, arrayContained, eq, lt, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type JobStatus, jobs } from "../db/schema.ts";

export const JOBS_CHANNEL = "monday_jobs";

export interface Job<P = unknown> {
  id: string;
  class: string;
  needs: string[];
  payload: P;
  runAt: Date;
  leaseUntil: Date | null;
  leaseOwner: string | null;
  attempts: number;
  status: JobStatus;
  lastError: string | null;
}

export interface StepContext {
  /** Epoch milliseconds by which the step must return; moves forward on extend(). */
  deadline: number;
  owner: string;
  /** Milliseconds left before the deadline. */
  remainingMs(): number;
  /**
   * Renews the lease for another budget from now, so a step that is still
   * working (a long model call, a slow Provider) is not swept and run twice
   * by another Server. False when the lease is no longer this step's.
   */
  extend(): Promise<boolean>;
}

export type StepResult = "done" | "again" | { sleepMs: number };
export type Step<P = unknown> = (job: Job<P>, ctx: StepContext) => Promise<StepResult>;

export interface EnqueueOptions {
  runAt?: Date;
  needs?: string[];
  /** Supply an id to make the enqueue idempotent; a duplicate is ignored. */
  id?: string;
  /**
   * With an id: a row under it that failed is queued again with fresh
   * attempts, instead of being ignored. For standing Jobs an Account needs
   * to keep syncing (its sync, reconcile and watch), re-armed at every boot.
   */
  revive?: boolean;
}

export interface JobsOptions {
  /** Attempts before a job is marked failed. */
  maxAttempts?: number;
  /** Backoff after a failed attempt, given the attempt number just made. */
  backoffMs?: (attempt: number) => number;
  now?: () => Date;
  /**
   * Called after every enqueue and immediate requeue, beside the NOTIFY. A
   * serverless kicker has no LISTEN connection and wakes from here instead.
   */
  onEnqueue?: (id: string) => void;
}

export interface Jobs {
  /** Attempts a job gets before it is marked failed; a step that wants a last word compares `job.attempts` to it. */
  readonly maxAttempts: number;
  enqueue(cls: string, payload: unknown, options?: EnqueueOptions): Promise<string>;
  claim(owner: string, canServe: string[], budgetMs: number): Promise<Job | null>;
  complete(id: string, owner: string): Promise<void>;
  fail(id: string, owner: string, error: string): Promise<void>;
  /** Requeue a job the step wants to continue, now or after a sleep. */
  requeue(id: string, owner: string, sleepMs?: number): Promise<void>;
  /** Pushes a running job's lease to now plus `budgetMs`; false when the job is not this owner's any more. */
  extend(id: string, owner: string, budgetMs: number): Promise<boolean>;
  /**
   * Removes every job, queued or asleep, whose payload names `value` under
   * `field` (an Account that was removed). Running ones finish and are not
   * requeued by their owner, whose complete and requeue find no row.
   */
  cancelByPayload(field: string, value: string): Promise<number>;
  sweepExpiredLeases(): Promise<number>;
  /**
   * Hands this owner's running jobs back to the queue without spending an
   * attempt: the Server is shutting down, which says nothing about the step.
   */
  release(owner: string): Promise<number>;
  /**
   * Removes a job that has not started. True when a queued row was removed;
   * false when it is running, done, failed or unknown (ADR 0010: Undo works
   * only before the send Job runs).
   */
  cancel(id: string): Promise<boolean>;
  registerStep<P>(cls: string, step: Step<P>): void;
  hasStep(cls: string): boolean;
  /** Run the registered step for a claimed job and record its outcome. */
  run(job: Job, budgetMs: number): Promise<StepResult | "failed">;
  get(id: string): Promise<Job | null>;
}

export class NoStepError extends Error {
  constructor(cls: string) {
    super(`no step registered for job class ${cls}`);
    this.name = "NoStepError";
  }
}

const defaultBackoff = (attempt: number) => 1000 * 2 ** attempt;

export function createJobs(db: Db, options: JobsOptions = {}): Jobs {
  const maxAttempts = options.maxAttempts ?? 3;
  const backoffMs = options.backoffMs ?? defaultBackoff;
  const now = options.now ?? (() => new Date());
  const onEnqueue = options.onEnqueue ?? (() => {});
  const steps = new Map<string, Step<never>>();

  const toJob = (row: typeof jobs.$inferSelect): Job => ({
    id: row.id,
    class: row.class,
    needs: row.needs,
    payload: row.payload,
    runAt: row.runAt,
    leaseUntil: row.leaseUntil,
    leaseOwner: row.leaseOwner,
    attempts: row.attempts,
    status: row.status,
    lastError: row.lastError,
  });

  const api: Jobs = {
    maxAttempts,
    async enqueue(cls, payload, opts = {}) {
      const id = opts.id ?? crypto.randomUUID();
      await db
        .insert(jobs)
        .values({
          id,
          class: cls,
          needs: opts.needs ?? [],
          payload: payload ?? {},
          runAt: opts.runAt ?? now(),
        })
        .onConflictDoNothing({ target: jobs.id });
      if (opts.revive && opts.id) {
        await db
          .update(jobs)
          .set({
            status: "queued",
            attempts: 0,
            leaseOwner: null,
            leaseUntil: null,
            runAt: opts.runAt ?? now(),
          })
          .where(and(eq(jobs.id, id), eq(jobs.status, "failed")));
      }
      await db.execute(sql`select pg_notify(${JOBS_CHANNEL}, ${id})`);
      onEnqueue(id);
      return id;
    },

    async claim(owner, canServe, budgetMs) {
      const at = now();
      const leaseUntil = new Date(at.getTime() + budgetMs);
      // One row, oldest first, skipping rows another Server is claiming right now.
      const next = db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.status, "queued"),
            lte(jobs.runAt, at),
            canServe.length > 0
              ? arrayContained(jobs.needs, canServe)
              : sql`cardinality(${jobs.needs}) = 0`,
          ),
        )
        .orderBy(jobs.runAt, jobs.createdAt)
        .limit(1)
        .for("update", { skipLocked: true });
      const rows = await db
        .update(jobs)
        .set({
          status: "running",
          leaseOwner: owner,
          leaseUntil,
          attempts: sql`${jobs.attempts} + 1`,
        })
        .where(eq(jobs.id, next))
        .returning();
      const row = rows[0];
      return row ? toJob(row) : null;
    },

    async complete(id, owner) {
      await db
        .update(jobs)
        .set({ status: "done", leaseOwner: null, leaseUntil: null, lastError: null, attempts: 0 })
        .where(and(eq(jobs.id, id), eq(jobs.leaseOwner, owner), eq(jobs.status, "running")));
    },

    async fail(id, owner, error) {
      const current = await api.get(id);
      if (!current || current.leaseOwner !== owner || current.status !== "running") return;
      const exhausted = current.attempts >= maxAttempts;
      await db
        .update(jobs)
        .set(
          exhausted
            ? { status: "failed", leaseOwner: null, leaseUntil: null, lastError: error }
            : {
                status: "queued",
                leaseOwner: null,
                leaseUntil: null,
                lastError: error,
                runAt: new Date(now().getTime() + backoffMs(current.attempts)),
              },
        )
        .where(and(eq(jobs.id, id), eq(jobs.leaseOwner, owner)));
    },

    async requeue(id, owner, sleepMs = 0) {
      await db
        .update(jobs)
        .set({
          status: "queued",
          leaseOwner: null,
          leaseUntil: null,
          attempts: 0,
          runAt: new Date(now().getTime() + Math.max(0, sleepMs)),
        })
        .where(and(eq(jobs.id, id), eq(jobs.leaseOwner, owner), eq(jobs.status, "running")));
      if (sleepMs <= 0) {
        await db.execute(sql`select pg_notify(${JOBS_CHANNEL}, ${id})`);
        onEnqueue(id);
      }
    },

    async cancelByPayload(field, value) {
      const removed = await db
        .delete(jobs)
        .where(and(sql`${jobs.payload} ->> ${field} = ${value}`, eq(jobs.status, "queued")))
        .returning({ id: jobs.id });
      return removed.length;
    },

    async extend(id, owner, budgetMs) {
      const rows = await db
        .update(jobs)
        .set({ leaseUntil: new Date(now().getTime() + budgetMs) })
        .where(and(eq(jobs.id, id), eq(jobs.leaseOwner, owner), eq(jobs.status, "running")))
        .returning({ id: jobs.id });
      return rows.length > 0;
    },

    async release(owner) {
      const rows = await db
        .update(jobs)
        .set({
          status: "queued",
          leaseOwner: null,
          leaseUntil: null,
          attempts: sql`greatest(${jobs.attempts} - 1, 0)`,
          runAt: now(),
        })
        .where(and(eq(jobs.status, "running"), eq(jobs.leaseOwner, owner)))
        .returning({ id: jobs.id });
      return rows.length;
    },

    async sweepExpiredLeases() {
      const at = now();
      const expired = and(eq(jobs.status, "running"), lt(jobs.leaseUntil, at));
      const failed = await db
        .update(jobs)
        .set({
          status: "failed",
          leaseOwner: null,
          leaseUntil: null,
          lastError: "lease expired",
        })
        .where(and(expired, sql`${jobs.attempts} >= ${maxAttempts}`))
        .returning({ id: jobs.id });
      const requeued = await db
        .update(jobs)
        .set({
          status: "queued",
          leaseOwner: null,
          leaseUntil: null,
          lastError: "lease expired",
          runAt: at,
        })
        .where(expired)
        .returning({ id: jobs.id });
      return failed.length + requeued.length;
    },

    async cancel(id) {
      const removed = await db
        .delete(jobs)
        .where(and(eq(jobs.id, id), eq(jobs.status, "queued")))
        .returning({ id: jobs.id });
      return removed.length > 0;
    },

    registerStep(cls, step) {
      steps.set(cls, step as Step<never>);
    },

    hasStep(cls) {
      return steps.has(cls);
    },

    async run(job, budgetMs) {
      const step = steps.get(job.class) as Step | undefined;
      const owner = job.leaseOwner ?? "";
      if (!step) {
        await api.fail(job.id, owner, new NoStepError(job.class).message);
        return "failed";
      }
      const ctx: StepContext = {
        deadline: now().getTime() + budgetMs,
        owner,
        remainingMs: () => Math.max(0, ctx.deadline - now().getTime()),
        extend: async () => {
          const kept = await api.extend(job.id, owner, budgetMs);
          if (kept) ctx.deadline = now().getTime() + budgetMs;
          return kept;
        },
      };
      // A step still working keeps its lease, so a slow one is never swept as
      // dead and run twice. The step's own deadline stays where it was: that
      // is its budget, and it yields "again" by it.
      const keepAlive = setInterval(
        () => void api.extend(job.id, owner, budgetMs).catch(() => {}),
        Math.max(1_000, Math.floor(budgetMs / 2)),
      );
      let result: StepResult;
      try {
        result = await step(job, ctx);
      } catch (error) {
        await api.fail(job.id, owner, error instanceof Error ? error.message : String(error));
        return "failed";
      } finally {
        clearInterval(keepAlive);
      }
      if (result === "done") await api.complete(job.id, owner);
      else if (result === "again") await api.requeue(job.id, owner, 0);
      else await api.requeue(job.id, owner, result.sleepMs);
      return result;
    },

    async get(id) {
      const row = await db.query.jobs.findFirst({ where: eq(jobs.id, id) });
      return row ? toJob(row) : null;
    },
  };

  return api;
}
