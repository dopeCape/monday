// The judge's worker pool (docs/research/judge-parallelism.md): many
// one-Thread requests in flight at once, never lock-step. A pool keeps up to
// `concurrency` pieces of work running at every moment: as soon as one
// finishes the next one starts, so one slow request never holds back the
// ones behind it. Results come back in input order with an error per item.
// Every judge request still passes the limiter (limiter.ts), which keeps the
// rate, the background concurrency, the 429 back-off and arrival first; the
// pool only makes sure there is always work waiting at the limiter.

/** What one item came to: its value, its error, or not started (the pool was stopped). */
export type Settled<R> =
  | { status: "done"; value: R }
  | { status: "failed"; error: unknown }
  | { status: "skipped" };

export interface PoolOptions {
  /** Checked before each item starts; true starts no more, and the ones in flight finish. */
  stop?: () => boolean;
}

const widthOf = (concurrency: number, count: number) =>
  Math.max(1, Math.min(Number.isFinite(concurrency) ? Math.floor(concurrency) : 1, count));

/**
 * Runs `work` over `items`, `concurrency` at a time continuously. Never
 * throws for an item: each one's error is in its place in the result.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<R>,
  options: PoolOptions = {},
): Promise<Array<Settled<R>>> {
  const results: Array<Settled<R>> = items.map(() => ({ status: "skipped" }));
  if (items.length === 0) return results;
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      if (options.stop?.()) return;
      const i = next++;
      try {
        results[i] = { status: "done", value: await work(items[i] as T, i) };
      } catch (error) {
        results[i] = { status: "failed", error };
      }
    }
  };
  await Promise.all(Array.from({ length: widthOf(concurrency, items.length) }, worker));
  return results;
}

/** The values in order; the first error (in input order) is thrown once every item has settled. */
export function valuesOf<R>(results: ReadonlyArray<Settled<R>>): R[] {
  const out: R[] = [];
  for (const r of results) {
    if (r.status === "failed") throw r.error;
    if (r.status === "done") out.push(r.value);
  }
  return out;
}

/** `mapPool`, then the first error thrown: for callers that fail as a whole. */
export async function eachPool<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<void>,
  options: PoolOptions = {},
): Promise<void> {
  valuesOf(await mapPool(items, concurrency, work, options));
}

export interface StreamPoolOptions<T> {
  concurrency: number;
  /** The next page after the last one fetched; an empty page ends the stream. */
  next: () => Promise<readonly T[]>;
  work: (item: T) => Promise<void>;
  /**
   * Called once every item of a page has settled, strictly in page order, so
   * a cursor written here never passes an item still in flight.
   */
  onPage?: (page: readonly T[], results: ReadonlyArray<Settled<void>>) => Promise<void>;
  /** Checked before each page is fetched; true fetches no more, and the items already fetched still run. */
  stop?: () => boolean;
}

export interface StreamPoolResult {
  /** Items whose work ran. */
  items: number;
  /** Pages handed to onPage. */
  pages: number;
  /** Whether `next` ran out (an empty page), not stopped. */
  exhausted: boolean;
}

/**
 * A pool over a paged source: the next page is fetched while the current
 * one is still running, so the pool never drains between pages. A failing
 * `next` or `onPage` stops the stream and is thrown once the work in flight
 * has settled; an item's own error goes to onPage with its page.
 */
export async function streamPool<T>(options: StreamPoolOptions<T>): Promise<StreamPoolResult> {
  const width = widthOf(options.concurrency, Number.POSITIVE_INFINITY);
  const pages: Array<{ items: readonly T[]; results: Array<Settled<void>>; left: number }> = [];
  const queue: Array<{ page: number; index: number }> = [];
  let exhausted = false;
  let fetching: Promise<void> | null = null;
  let failure: { error: unknown } | null = null;
  let committed = 0;
  let commits: Promise<void> = Promise.resolve();
  let ran = 0;

  const canFetch = () => !exhausted && failure === null && !(options.stop?.() ?? false);
  const fetchMore = (): Promise<void> => {
    fetching ??= (async () => {
      try {
        const items = await options.next();
        if (items.length === 0) {
          exhausted = true;
          return;
        }
        const page = pages.length;
        pages.push({
          items,
          results: items.map(() => ({ status: "skipped" as const })),
          left: items.length,
        });
        for (let index = 0; index < items.length; index++) queue.push({ page, index });
      } catch (error) {
        failure ??= { error };
      } finally {
        fetching = null;
      }
    })();
    return fetching;
  };

  const take = async (): Promise<{ page: number; index: number } | null> => {
    for (;;) {
      if (failure) return null;
      // Read ahead: the next page is on its way before the workers run dry.
      if (queue.length <= width && canFetch()) void fetchMore();
      const job = queue.shift();
      if (job) return job;
      if (fetching) {
        await fetching;
        continue;
      }
      if (!canFetch()) return null;
      await fetchMore();
    }
  };

  const commit = () => {
    commits = commits.then(async () => {
      while (failure === null && committed < pages.length) {
        const page = pages[committed];
        if (!page || page.left > 0) return;
        committed += 1;
        try {
          await options.onPage?.(page.items, page.results);
        } catch (error) {
          failure ??= { error };
        }
      }
    });
  };

  const worker = async () => {
    for (;;) {
      const job = await take();
      if (!job) return;
      const page = pages[job.page];
      if (!page) return;
      ran += 1;
      try {
        await options.work(page.items[job.index] as T);
        page.results[job.index] = { status: "done", value: undefined };
      } catch (error) {
        page.results[job.index] = { status: "failed", error };
      }
      page.left -= 1;
      if (page.left === 0) commit();
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  await commits;
  if (failure) throw (failure as { error: unknown }).error;
  return { items: ran, pages: committed, exhausted };
}
