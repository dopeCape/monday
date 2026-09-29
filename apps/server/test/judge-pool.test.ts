// The judge's worker pool (docs/research/judge-parallelism.md): N one-Thread
// requests finish in about ceil(N / concurrency) request times, not N; a slow
// request never holds back the ones behind it; results keep their order with
// an error per item; a paged source is read ahead and its pages are handed
// back strictly in order; and through the limiter the background cap and the
// 429 back-off still hold.

import { describe, expect, test } from "bun:test";
import { createJudgeLimiter } from "../src/intelligence/signals/limiter.ts";
import { eachPool, mapPool, streamPool, valuesOf } from "../src/intelligence/signals/pool.ts";

const UNIT = 40;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A fake judge: each request takes `ms`, and it counts how many are in flight at once. */
function fakeJudge() {
  let inFlight = 0;
  let most = 0;
  const started: number[] = [];
  const finished: number[] = [];
  const t0 = Date.now();
  return {
    async ask(id: number, ms = UNIT) {
      inFlight += 1;
      most = Math.max(most, inFlight);
      started[id] = Date.now() - t0;
      await delay(ms);
      inFlight -= 1;
      finished[id] = Date.now() - t0;
      return `answer ${id}`;
    },
    most: () => most,
    started,
    finished,
  };
}

describe("mapPool", () => {
  test("N requests finish in about ceil(N / concurrency) request times, not N", async () => {
    const judge = fakeJudge();
    const items = Array.from({ length: 16 }, (_, i) => i);
    const at = Date.now();
    const results = await mapPool(items, 4, (i) => judge.ask(i));
    const elapsed = Date.now() - at;
    // Four rounds of one unit each; sequential would be sixteen.
    expect(elapsed).toBeGreaterThanOrEqual(4 * UNIT - 5);
    expect(elapsed).toBeLessThan(8 * UNIT);
    expect(judge.most()).toBe(4);
    expect(valuesOf(results)).toEqual(items.map((i) => `answer ${i}`));
  });

  test("a slow request does not stop the next ones from starting", async () => {
    const judge = fakeJudge();
    const items = Array.from({ length: 8 }, (_, i) => i);
    const at = Date.now();
    // Item 0 takes eight units; the other seven take one each on the second slot.
    await mapPool(items, 2, (i) => judge.ask(i, i === 0 ? 8 * UNIT : UNIT));
    const elapsed = Date.now() - at;
    const slowEnd = judge.finished[0] as number;
    for (let i = 1; i < 8; i++) {
      expect(judge.started[i] as number).toBeLessThan(slowEnd);
      expect(judge.finished[i] as number).toBeLessThan(slowEnd);
    }
    // Lock-step chunks of two would take 8 + 3 = 11 units; the pool takes about 8.
    expect(elapsed).toBeLessThan(10 * UNIT);
    expect(judge.most()).toBe(2);
  });

  test("keeps order and an error per item, and stop starts no more", async () => {
    const results = await mapPool([3, 1, 2, 0], 4, async (n) => {
      await delay(n * 5);
      if (n === 2) throw new Error("two failed");
      return n * 10;
    });
    expect(results.map((r) => r.status)).toEqual(["done", "done", "failed", "done"]);
    expect(results[0]).toEqual({ status: "done", value: 30 });
    expect(() => valuesOf(results)).toThrow("two failed");
    await expect(
      eachPool([1, 2], 2, async (n) => {
        if (n === 2) throw new Error("no");
      }),
    ).rejects.toThrow("no");

    let started = 0;
    const stopped = await mapPool(
      Array.from({ length: 10 }, (_, i) => i),
      2,
      async () => {
        started += 1;
        await delay(5);
      },
      { stop: () => started >= 4 },
    );
    expect(started).toBe(4);
    expect(stopped.filter((r) => r.status === "skipped")).toHaveLength(6);
  });
});

describe("streamPool", () => {
  test("reads the next page ahead, never waits for a whole page, and hands pages back in order", async () => {
    const judge = fakeJudge();
    const source = [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9, 10, 11],
    ];
    let fetched = 0;
    const fetchedAt: number[] = [];
    const t0 = Date.now();
    const committed: number[][] = [];
    const result = await streamPool<number>({
      concurrency: 4,
      next: async () => {
        fetchedAt.push(Date.now() - t0);
        return source[fetched++] ?? [];
      },
      // Item 0 is slow: page 0 cannot be handed back until it ends, yet pages 1 and 2 run meanwhile.
      work: async (i) => {
        await judge.ask(i, i === 0 ? 5 * UNIT : UNIT);
      },
      onPage: async (page, results) => {
        expect(results.every((r) => r.status === "done")).toBe(true);
        committed.push([...page]);
      },
    });
    expect(result).toEqual({ items: 12, pages: 3, exhausted: true });
    expect(committed).toEqual(source);
    // Everything behind the slow item started before it ended.
    const slowEnd = judge.finished[0] as number;
    for (let i = 1; i < 12; i++) expect(judge.started[i] as number).toBeLessThan(slowEnd);
    // The second page was fetched while the first was still in flight.
    expect(fetchedAt[1] as number).toBeLessThan(UNIT);
    expect(judge.most()).toBe(4);
  });

  test("stop fetches no more pages but finishes the ones fetched; a failing page write is thrown", async () => {
    let pagesAsked = 0;
    let stop = false;
    const done: number[] = [];
    const result = await streamPool<number>({
      concurrency: 2,
      next: async () => {
        pagesAsked += 1;
        return pagesAsked > 10 ? [] : [pagesAsked * 10, pagesAsked * 10 + 1];
      },
      work: async (n) => {
        await delay(5);
        done.push(n);
      },
      onPage: async () => {
        stop = true;
      },
      stop: () => stop,
    });
    expect(result.exhausted).toBe(false);
    // Every item fetched ran and every page fetched was handed back.
    expect(result.items).toBe(pagesAsked * 2);
    expect(result.pages).toBe(pagesAsked);
    expect(pagesAsked).toBeLessThan(10);

    const errors: unknown[] = [];
    await expect(
      streamPool<number>({
        concurrency: 2,
        next: (() => {
          let n = 0;
          return async () => (n++ < 3 ? [n] : []);
        })(),
        work: async (n) => {
          if (n === 1) throw new Error("item failed");
        },
        onPage: async (_page, results) => {
          for (const r of results) if (r.status === "failed") errors.push(r.error);
          if (errors.length > 0) throw new Error("write failed");
        },
      }),
    ).rejects.toThrow("write failed");
    expect(errors).toHaveLength(1);
  });
});

describe("the pool through the limiter", () => {
  test("background requests stay under the limiter's cap and a 429 still halves it", async () => {
    const limiter = createJudgeLimiter({
      settings: async () => ({
        requestsPerMinute: 10_000,
        concurrency: 4,
        cooldownSeconds: 60,
        arrivalReservePerMinute: 0,
      }),
    });
    const judge = fakeJudge();
    let limited = false;
    const items = Array.from({ length: 12 }, (_, i) => i);
    const results = await mapPool(items, 16, (i) =>
      limiter.run("background", async () => {
        if (i === 5 && !limited) {
          limited = true;
          throw Object.assign(new Error("slow down"), { code: "rate_limited", retryAfterMs: 5 });
        }
        return judge.ask(i, 10);
      }),
    );
    expect(valuesOf(results)).toHaveLength(12);
    expect(judge.most()).toBeLessThanOrEqual(4);
    expect(limited).toBe(true);
    expect(limiter.state().backgroundLimit).toBe(2);
  });
});
