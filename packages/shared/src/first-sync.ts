// The first sync (docs/spec/onboarding.md, "First sync"): what "every email
// in the inbox is fetched" means, in one place. The Server counts; this file
// says when the count is enough for the app to open.
//
// Headers: every Message the Provider holds in the Inbox mailbox has a mirror
// row (its first pass over the Inbox finished paging). Bodies: every Inbox
// Message dated inside `sync.body_window_days` has its body, so the first
// Threads the user opens render at once. Older bodies fill in afterwards.
// `sync.first_run_wait` picks which of the two the screen waits for.
//
// Runtime-neutral: no Bun, no DOM.

import type { Id, Provider } from "./domain.ts";

/** What the first sync screen waits for (the Setting `sync.first_run_wait`). */
export type FirstRunWait = "headers" | "inbox_bodies";

export const FIRST_RUN_WAITS: readonly FirstRunWait[] = ["headers", "inbox_bodies"];

/** Why the sync engine's last pass failed, in the words the screen needs. */
export type FirstSyncErrorKind = "auth" | "network" | "other";

export interface FirstSyncCount {
  /** Messages counted so far. */
  done: number;
  /** What the Provider says there is; null when it does not say (Gmail before its first answer). */
  total: number | null;
  /** The phase is finished by the definition above; latched on the Server once true. */
  complete: boolean;
}

/** GET /accounts/:id/sync. */
export interface FirstSyncProgress {
  accountId: Id;
  workspaceId: Id;
  provider: Provider;
  address: string;
  /** Inbox Messages with a mirror row, against the Provider's Inbox total. */
  headers: FirstSyncCount;
  /** Inbox Messages inside the body window with their body, against all of them found so far. */
  bodies: FirstSyncCount & { total: number };
  /** The Provider refused calls for quota and the adapter is running slower on purpose. */
  pacing: boolean;
  /** The last pass failed and nothing has succeeded since. */
  error: { kind: FirstSyncErrorKind; message: string } | null;
  /** Server time of this reading. */
  at: string;
}

/** Whether the app may open: the phase the Setting names is complete. */
export function firstSyncComplete(progress: FirstSyncProgress, wait: FirstRunWait): boolean {
  if (!progress.headers.complete) return false;
  return wait === "headers" || progress.bodies.complete;
}

export type FirstSyncPhase = "headers" | "bodies" | "done";

/** The phase in progress under the Setting. */
export function firstSyncPhase(progress: FirstSyncProgress, wait: FirstRunWait): FirstSyncPhase {
  if (firstSyncComplete(progress, wait)) return "done";
  return progress.headers.complete ? "bodies" : "headers";
}

/**
 * The share of the wait that is done, 0 to 1, over both phases when the
 * Setting waits for bodies. Headers weigh by count against bodies so a large
 * Inbox with a short body window reads right; a phase without a known total
 * counts as not started.
 */
export function firstSyncFraction(progress: FirstSyncProgress, wait: FirstRunWait): number {
  if (firstSyncComplete(progress, wait)) return 1;
  const share = (c: FirstSyncCount): number => {
    if (c.complete) return 1;
    if (c.total === null || c.total <= 0) return 0;
    return Math.min(1, c.done / c.total);
  };
  if (wait === "headers") return Math.min(0.999, share(progress.headers));
  const headersWeight = Math.max(1, progress.headers.total ?? progress.headers.done);
  const bodiesWeight = Math.max(1, progress.bodies.total);
  const whole = headersWeight + bodiesWeight;
  const done = share(progress.headers) * headersWeight + share(progress.bodies) * bodiesWeight;
  return Math.min(0.999, done / whole);
}
