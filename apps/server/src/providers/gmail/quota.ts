// Gmail quota pacing (research, "Rate limits (changed on 2026-05-01)"): a
// project created today gets 6,000 quota units per user per minute, and
// messages.get costs 20 of them, so a cold sync can fetch at most 300
// messages a minute. A token bucket the client draws from before every call
// keeps the adapter under the limit instead of discovering it through 429s.

/** Units per method, from the quota reference. */
export const GMAIL_COST = {
  "history.list": 2,
  "messages.list": 5,
  "messages.get": 20,
  "messages.attachments.get": 20,
  "messages.modify": 5,
  "messages.batchModify": 50,
  "messages.send": 100,
  "drafts.send": 100,
  "threads.get": 40,
  "labels.list": 1,
  "labels.get": 1,
  getProfile: 1,
  watch: 100,
  stop: 50,
} as const;

export type GmailMethod = keyof typeof GMAIL_COST;

/** The per-user per-minute budget for projects created on or after 2026-05-01. */
export const GMAIL_UNITS_PER_MINUTE = 6_000;

export interface TokenBucketOptions {
  /** Units the bucket holds when full and the burst it allows. */
  capacity: number;
  /** Units added per millisecond. */
  refillPerMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface TokenBucket {
  /** Resolves once `units` are available and taken. */
  take(units: number): Promise<void>;
  /** Units available right now, for tests and diagnostics. */
  available(): number;
  /**
   * The Provider refused a call for quota: the bucket empties and its rate
   * halves (never below the floor), so the adapter fits whatever the project's
   * real limit turns out to be instead of trusting the documented one. The
   * rate grows back a step at a time while calls go through.
   */
  penalize(): void;
  /** Units per minute the bucket refills at right now. */
  rate(): number;
  /** Whether a penalty still holds the rate under the configured one. */
  pacing?(): boolean;
}

/** The rate never drops below this share of the configured one after penalties. */
export const PENALTY_FLOOR = 0.1;
/** Clean calls this many units apart grow the rate back by one step. */
export const RECOVERY_STEP_UNITS = 2_000;
/** Each recovery step restores this share of the configured rate. */
export const RECOVERY_STEP = 0.1;

export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const full = options.refillPerMs;
  let refillPerMs = full;
  let level = options.capacity;
  let last = now();
  /** Units taken since the last penalty, towards the next recovery step. */
  let clean = 0;
  // Takes are served in order so a big request cannot starve behind small ones.
  let queue: Promise<void> = Promise.resolve();

  function refill(): void {
    const at = now();
    level = Math.min(options.capacity, level + (at - last) * refillPerMs);
    last = at;
  }

  async function acquire(units: number): Promise<void> {
    if (units > options.capacity) throw new RangeError("request exceeds the bucket capacity");
    for (;;) {
      refill();
      if (level >= units) {
        level -= units;
        if (refillPerMs < full) {
          clean += units;
          if (clean >= RECOVERY_STEP_UNITS) {
            clean = 0;
            refillPerMs = Math.min(full, refillPerMs + full * RECOVERY_STEP);
          }
        }
        return;
      }
      const wait = Math.ceil((units - level) / refillPerMs);
      await sleep(wait);
    }
  }

  return {
    take(units) {
      const next = queue.then(() => acquire(units));
      queue = next.catch(() => {});
      return next;
    },
    available() {
      refill();
      return level;
    },
    penalize() {
      refill();
      level = 0;
      clean = 0;
      refillPerMs = Math.max(full * PENALTY_FLOOR, refillPerMs / 2);
    },
    rate() {
      return refillPerMs * 60_000;
    },
    pacing() {
      return refillPerMs < full;
    },
  };
}

/** The share of a minute's units the bucket may hold as a burst; the rest refills over the minute. */
export const BURST_SHARE = 0.2;

/**
 * Google counts a rolling minute, and a token bucket cannot be exact about
 * one; holding a fifth of the minute as burst and refilling the other four
 * fifths keeps any sixty seconds at or under the ceiling.
 */
export function gmailQuotaBucket(
  options: Pick<TokenBucketOptions, "now" | "sleep"> & { unitsPerMinute?: number } = {},
): TokenBucket {
  const perMinute = options.unitsPerMinute ?? GMAIL_UNITS_PER_MINUTE;
  return createTokenBucket({
    capacity: perMinute * BURST_SHARE,
    refillPerMs: (perMinute * (1 - BURST_SHARE)) / 60_000,
    ...(options.now ? { now: options.now } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
}
