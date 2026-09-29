// The agent bar's text bridge: the screen's late echo of what the composer
// sent must never be written back over newer typing (it deleted characters
// and moved the cursor), while a change made elsewhere still reaches the input.

import { describe, expect, test } from "bun:test";
import { createEchoFilter } from "./Thread.tsx";

describe("the text bridge's echo filter", () => {
  test("a stale echo of earlier typing is ignored while the composer holds newer text", () => {
    const f = createEchoFilter();
    f.sent("a");
    f.sent("ab");
    f.sent("abc");
    // The screen catches up one render late: "ab" arrives while the input holds "abc".
    expect(f.isExternal("ab", "abc")).toBe(false);
    expect(f.isExternal("abc", "abc")).toBe(false);
  });

  test("a change made elsewhere reaches the input: a recall, the clear after Send, a prefill", () => {
    const f = createEchoFilter();
    f.sent("draft");
    expect(f.isExternal("", "draft")).toBe(true);
    expect(f.isExternal("Summarize this thread", "")).toBe(true);
  });

  test("once in step, an old echo that repeats a later external value is not swallowed", () => {
    const f = createEchoFilter();
    f.sent("hi");
    expect(f.isExternal("hi", "hi")).toBe(false);
    // Much later the screen sets "hi" again from elsewhere while the input is empty.
    expect(f.isExternal("hi", "")).toBe(true);
  });

  test("it keeps a bounded memory", () => {
    const f = createEchoFilter(3);
    for (const v of ["1", "12", "123", "1234"]) f.sent(v);
    // "1" fell out of memory: treated as news rather than growing forever.
    expect(f.isExternal("1", "1234")).toBe(true);
    expect(f.isExternal("123", "1234")).toBe(false);
  });
});
