// The judge's limiter (docs/spec/signals.md, "Budget and rate"; slice 31):
// every judge request from one Server passes it. At most
// signals.rate.requests_per_minute requests start in any minute, and at most
// signals.backfill.concurrency background requests are in flight. Arrival
// requests go first: a background request waits while an arrival one is
// queued. A 429 honours retry-after, halves the background concurrency for
// signals.rate.cooldown_seconds, then grows it back one request at a time.
// A 503 is never guessed around: the caller's Job keeps its retry.

export type JudgePriority = "arrival" | "background";

export interface LimiterSettings {
  requestsPerMinute: number;
  /** The most background requests in flight. */
  concurrency: number;
  cooldownSeconds: number;
}

export interface LimiterState {
  /** Background requests allowed in flight now. */
  backgroundLimit: number;
  inFlight: { arrival: number; background: number };
  queued: { arrival: number; background: number };
  /** When the cooldown after the last 429 ends, ms since the epoch; 0 when none. */
  coolingUntil: number;
}

export interface JudgeLimiter {
  /** Runs one request under the limits; retries after a 429's retry-after, a few times. */
  run<T>(priority: JudgePriority, request: () => Promise<T>): Promise<T>;
  state(): LimiterState;
}

export interface LimiterOptions {
  settings: () => Promise<LimiterSettings>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Whether an error is a rate limit, and how long it asks to wait. */
  rateLimited?: (error: unknown) => { retryAfterMs: number } | null;
  /** Attempts after a 429 before the error goes to the caller. */
  retries?: number;
}

const MINUTE = 60_000;

/** A TypeSafeError-shaped rate limit: code rate_limited, maybe a retry-after. */
export function isRateLimited(error: unknown): { retryAfterMs: number } | null {
  if (!error || typeof error !== "object") return null;
  const e = error as { code?: unknown; retryAfterMs?: unknown };
  if (e.code !== "rate_limited") return null;
  return { retryAfterMs: typeof e.retryAfterMs === "number" ? e.retryAfterMs : 1000 };
}

export function createJudgeLimiter(options: LimiterOptions): JudgeLimiter {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rateLimited = options.rateLimited ?? isRateLimited;
  const retries = options.retries ?? 3;
  const started: number[] = [];
  const inFlight = { arrival: 0, background: 0 };
  const queued = { arrival: 0, background: 0 };
  let backgroundLimit: number | null = null;
  let coolingUntil = 0;
  let blockedUntil = 0;
  const waiters: Array<() => void> = [];

  const wake = () => {
    for (const w of waiters.splice(0)) w();
  };
  const waitAWhile = (ms: number) =>
    new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      waiters.push(finish);
      void sleep(Math.max(1, ms)).then(finish);
    });

  const acquire = async (priority: JudgePriority) => {
    queued[priority] += 1;
    try {
      for (;;) {
        const s = await options.settings();
        const max = Math.max(1, s.concurrency);
        backgroundLimit ??= max;
        if (backgroundLimit > max) backgroundLimit = max;
        const at = now();
        while (started.length > 0 && (started[0] as number) <= at - MINUTE) started.shift();
        if (at < blockedUntil) {
          await waitAWhile(blockedUntil - at);
          continue;
        }
        if (started.length >= Math.max(1, s.requestsPerMinute)) {
          await waitAWhile((started[0] as number) + MINUTE - at);
          continue;
        }
        if (priority === "background") {
          // Arrival first; background within its concurrency.
          if (queued.arrival > 0 || inFlight.background >= backgroundLimit) {
            await waitAWhile(50);
            continue;
          }
        }
        started.push(at);
        inFlight[priority] += 1;
        return;
      }
    } finally {
      queued[priority] -= 1;
    }
  };

  const release = (priority: JudgePriority, ok: boolean) => {
    inFlight[priority] -= 1;
    // After the cooldown, each background request that went through grows the limit back by one.
    if (ok && priority === "background" && backgroundLimit !== null && now() >= coolingUntil) {
      void options.settings().then((s) => {
        if (backgroundLimit !== null)
          backgroundLimit = Math.min(Math.max(1, s.concurrency), backgroundLimit + 1);
        wake();
      });
    }
    wake();
  };

  const onRateLimit = async (retryAfterMs: number) => {
    const s = await options.settings();
    const at = now();
    blockedUntil = Math.max(blockedUntil, at + retryAfterMs);
    backgroundLimit = Math.max(1, Math.floor((backgroundLimit ?? Math.max(1, s.concurrency)) / 2));
    coolingUntil = at + Math.max(0, s.cooldownSeconds) * 1000;
  };

  return {
    async run(priority, request) {
      for (let attempt = 0; ; attempt++) {
        await acquire(priority);
        let ok = false;
        try {
          const result = await request();
          ok = true;
          return result;
        } catch (error) {
          const limited = rateLimited(error);
          if (!limited || attempt >= retries) throw error;
          await onRateLimit(limited.retryAfterMs);
        } finally {
          release(priority, ok);
        }
      }
    },
    state: () => ({
      backgroundLimit: backgroundLimit ?? 0,
      inFlight: { ...inFlight },
      queued: { ...queued },
      coolingUntil,
    }),
  };
}
