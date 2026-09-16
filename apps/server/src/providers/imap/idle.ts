// IDLE (RFC 2177, RFC 9051 section 6.3.13) on one mailbox over one dedicated
// connection, re-issued every 29 minutes so the server's autologout timer
// (30 minute floor) never fires, reconnected with backoff when the socket
// drops. Written against an abstract connection and clock so the timing is
// testable without a server.

import { type Backoff, DEFAULT_BACKOFF, nextBackoff } from "../jmap/eventsource.ts";
import type { WatchEvent } from "../types.ts";

/** "At least every 29 minutes" per RFC 2177 section 3. */
export const IDLE_REISSUE_MS = 29 * 60 * 1000;

export interface IdleConnection {
  /** Connects (again) and selects the mailbox. */
  open(): Promise<void>;
  /** Enters IDLE; resolves when wake() or the server ends it, rejects when the socket dies. */
  idle(): Promise<void>;
  /** Ends a running IDLE. */
  wake(): Promise<void>;
  close(): Promise<void>;
  /** Fires on EXISTS, EXPUNGE and FETCH FLAGS while idling; returns an unsubscribe. */
  onChange(listener: () => void): () => void;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface IdleLoopOptions {
  reissueMs?: number;
  timers?: Timers;
  backoff?: Backoff;
  sleep?: (ms: number) => Promise<void>;
}

export interface IdleLoop {
  /** Resolves once the loop has exited after stop(). */
  done: Promise<void>;
  stop(): Promise<void>;
  /** How many times IDLE was (re)issued; for tests and diagnostics. */
  issued(): number;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function idleLoop(
  mailboxId: string,
  connection: IdleConnection,
  emit: (event: WatchEvent) => void,
  options: IdleLoopOptions = {},
): IdleLoop {
  const reissueMs = options.reissueMs ?? IDLE_REISSUE_MS;
  const timers = options.timers ?? realTimers;
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let stopped = false;
  let issued = 0;
  let wakeSleep: (() => void) | null = null;

  const unsubscribe = connection.onChange(() => {
    if (!stopped) emit({ type: "changed", mailboxIds: [mailboxId] });
  });

  const run = async () => {
    let delay = 0;
    while (!stopped) {
      try {
        await connection.open();
        if (stopped) break;
        delay = 0;
        emit({ type: "connected" });
        while (!stopped) {
          const timer = timers.setTimeout(() => {
            connection.wake().catch(() => {});
          }, reissueMs);
          issued += 1;
          try {
            await connection.idle();
          } finally {
            timers.clearTimeout(timer);
          }
        }
      } catch (error) {
        if (stopped) break;
        delay = nextBackoff(delay, backoff);
        emit({
          type: "disconnected",
          reason: error instanceof Error ? error.message : String(error),
        });
        await new Promise<void>((resolve) => {
          wakeSleep = resolve;
          void sleep(delay).then(resolve);
        });
        wakeSleep = null;
      }
    }
    unsubscribe();
    await connection.close().catch(() => {});
  };

  const done = run();
  return {
    done,
    issued: () => issued,
    async stop() {
      stopped = true;
      wakeSleep?.();
      await connection.wake().catch(() => {});
      await done;
    },
  };
}
