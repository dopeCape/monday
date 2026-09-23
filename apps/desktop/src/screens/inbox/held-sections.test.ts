/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import type { Thread } from "@monday/shared";
import { threads as fixtureThreads } from "@monday/ui/fixtures";
import { type HeldSections, holdSections } from "./held-sections.ts";

const base = fixtureThreads[0] as Thread;
const t = (id: string, section: string): Thread => ({ ...base, id, section });
const sectionsOf = (list: readonly Thread[]) => list.map((x) => `${x.id}:${x.section}`);

describe("holdSections", () => {
  test("a Thread keeps the Section it was first shown in while nothing new arrives", () => {
    const held: HeldSections = { scope: ["a"], sections: new Map() };
    const first = [t("a", "needs-reply"), t("b", "fyi")];
    expect(holdSections(first, held, ["a"], new Set())).toBe(first);
    const moved = [t("a", "fyi"), t("b", "fyi")];
    expect(sectionsOf(holdSections(moved, held, ["a"], new Set()))).toEqual([
      "a:needs-reply",
      "b:fyi",
    ]);
  });

  test("a new arrival rebuilds the stream, except the rows under the cursor", () => {
    const held: HeldSections = { scope: ["a"], sections: new Map() };
    holdSections([t("a", "needs-reply"), t("b", "needs-reply")], held, ["a"], new Set());
    const next = [t("n", "needs-reply"), t("a", "fyi"), t("b", "fyi")];
    expect(sectionsOf(holdSections(next, held, ["a"], new Set(["a"])))).toEqual([
      "n:needs-reply",
      "a:needs-reply",
      "b:fyi",
    ]);
  });

  test("a changed scope rebuilds; a Thread that left and came back keeps its hold", () => {
    const held: HeldSections = { scope: ["a"], sections: new Map() };
    holdSections([t("a", "needs-reply"), t("b", "fyi")], held, ["a"], new Set());
    // b archived, then undone while a moved: both keep their holds.
    holdSections([t("a", "fyi")], held, ["a"], new Set());
    expect(sectionsOf(holdSections([t("a", "fyi"), t("b", "x")], held, ["a"], new Set()))).toEqual([
      "a:needs-reply",
      "b:fyi",
    ]);
    expect(sectionsOf(holdSections([t("a", "fyi"), t("b", "x")], held, ["b"], new Set()))).toEqual([
      "a:fyi",
      "b:x",
    ]);
  });
});
