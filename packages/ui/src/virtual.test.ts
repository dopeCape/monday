/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { indexAt, offsetsOf, scrollToReveal, windowOf } from "./virtual.ts";

describe("the virtual window", () => {
  const sizes = [40, ...Array.from({ length: 999 }, () => 44)];
  const offsets = offsetsOf(sizes);

  test("offsets add up the sizes", () => {
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBe(40);
    expect(offsets[1000]).toBe(40 + 999 * 44);
    expect(indexAt(offsets, 0)).toBe(0);
    expect(indexAt(offsets, 39)).toBe(0);
    expect(indexAt(offsets, 40)).toBe(1);
    expect(indexAt(offsets, 1e9)).toBe(999);
  });

  test("the view plus the overscan on each side, and the space around it", () => {
    const w = windowOf(offsets, 40 + 44 * 500, 600, 10);
    expect(w.start).toBe(501 - 10);
    expect(w.end).toBe(501 + 14 + 10);
    expect(w.before).toBe(offsets[w.start] as number);
    expect(w.before + w.after + ((offsets[w.end] as number) - (offsets[w.start] as number))).toBe(
      offsets[1000] as number,
    );
    expect(windowOf(offsets, 0, 600, 0)).toMatchObject({ start: 0, end: 14 });
    expect(windowOf(offsetsOf([]), 0, 600, 10)).toEqual({ start: 0, end: 0, before: 0, after: 0 });
  });

  test("revealing moves the least it can", () => {
    expect(scrollToReveal(100, 600, 200, 244)).toBe(100);
    expect(scrollToReveal(100, 600, 50, 94)).toBe(50);
    expect(scrollToReveal(100, 600, 800, 844)).toBe(244);
  });
});
