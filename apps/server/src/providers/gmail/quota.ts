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
}

export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let level = options.capacity;
  let last = now();
  // Takes are served in order so a big request cannot starve behind small ones.
  let queue: Promise<void> = Promise.resolve();

  function refill(): void {
    const at = now();
    level = Math.min(options.capacity, level + (at - last) * options.refillPerMs);
    last = at;
  }

  async function acquire(units: number): Promise<void> {
    if (units > options.capacity) throw new RangeError("request exceeds the bucket capacity");
    for (;;) {
      refill();
      if (level >= units) {
        level -= units;
        return;
      }
      const wait = Math.ceil((units - level) / options.refillPerMs);
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
  };
}

export function gmailQuotaBucket(
  options: Pick<TokenBucketOptions, "now" | "sleep"> & { unitsPerMinute?: number } = {},
): TokenBucket {
  const perMinute = options.unitsPerMinute ?? GMAIL_UNITS_PER_MINUTE;
  return createTokenBucket({
    capacity: perMinute,
    refillPerMs: perMinute / 60_000,
    ...(options.now ? { now: options.now } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
}
