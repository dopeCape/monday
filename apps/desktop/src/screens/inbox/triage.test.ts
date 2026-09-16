/// <reference types="bun-types" />
// The pure triage rules: targets, auto-advance direction, the multi-select,
// the batch threshold and string filling.

import { describe, expect, test } from "bun:test";
import {
  extendSelection,
  fill,
  needsPreview,
  neighbor,
  nextFocus,
  targets,
  toggleSelected,
} from "./triage.ts";

const order = ["a", "b", "c", "d", "e"];

describe("targets", () => {
  test("the multi-select when there is one, else the focus row", () => {
    expect(targets("b", [])).toEqual(["b"]);
    expect(targets("b", ["c", "d"])).toEqual(["c", "d"]);
    expect(targets(null, [])).toEqual([]);
  });
});

describe("nextFocus", () => {
  test("advances to the next row by default", () => {
    expect(nextFocus(order, "b", ["b"], "next")).toBe("c");
  });

  test("advances to the previous row when the Setting says so", () => {
    expect(nextFocus(order, "b", ["b"], "previous")).toBe("a");
  });

  test("skips rows that are leaving too", () => {
    expect(nextFocus(order, "b", ["b", "c", "d"], "next")).toBe("e");
    expect(nextFocus(order, "d", ["b", "c", "d"], "previous")).toBe("a");
  });

  test("falls back the other way at the end of the list", () => {
    expect(nextFocus(order, "e", ["e"], "next")).toBe("d");
    expect(nextFocus(order, "a", ["a"], "previous")).toBe("b");
  });

  test("keeps a focus that is not leaving", () => {
    expect(nextFocus(order, "a", ["c"], "next")).toBe("a");
  });

  test("is null when nothing is left", () => {
    expect(nextFocus(order, "a", order, "next")).toBeNull();
    expect(nextFocus(order, null, ["a"], "next")).toBeNull();
  });
});

describe("neighbor", () => {
  test("moves and clamps", () => {
    expect(neighbor(order, "a", 1)).toBe("b");
    expect(neighbor(order, "e", 1)).toBe("e");
    expect(neighbor(order, "a", -1)).toBe("a");
    expect(neighbor(order, null, 1)).toBe("a");
    expect(neighbor(order, null, -1)).toBe("e");
    expect(neighbor([], "a", 1)).toBeNull();
  });
});

describe("multi-select", () => {
  test("X toggles the focus row", () => {
    expect(toggleSelected([], "b")).toEqual(["b"]);
    expect(toggleSelected(["b"], "b")).toEqual([]);
    expect(toggleSelected(["a"], "b")).toEqual(["a", "b"]);
  });

  test("Shift-J accumulates downwards and moves the focus", () => {
    let sel: string[] = [];
    let focus: string | null = "a";
    for (let i = 0; i < 3; i++) {
      const r = extendSelection(order, sel, focus, 1);
      sel = r.selection;
      focus = r.focus;
    }
    expect(sel).toEqual(["a", "b", "c", "d"]);
    expect(focus).toBe("d");
  });

  test("Shift-K accumulates upwards without duplicates", () => {
    const r1 = extendSelection(order, ["c"], "c", -1);
    expect(r1).toEqual({ selection: ["c", "b"], focus: "b" });
    const r2 = extendSelection(order, r1.selection, r1.focus, -1);
    expect(r2).toEqual({ selection: ["c", "b", "a"], focus: "a" });
    const r3 = extendSelection(order, r2.selection, r2.focus, -1);
    expect(r3.selection).toEqual(["c", "b", "a"]);
  });
});

describe("batch threshold", () => {
  test("previews only above the Setting", () => {
    expect(needsPreview(10, 10)).toBe(false);
    expect(needsPreview(11, 10)).toBe(true);
    expect(needsPreview(1, 0)).toBe(true);
  });
});

describe("fill", () => {
  test("fills named holes and leaves unknown ones", () => {
    expect(fill("Syncing, {done} of {total}", { done: "1,204", total: "12,418" })).toBe(
      "Syncing, 1,204 of 12,418",
    );
    expect(fill("{action}, {n} threads", { action: "Archived", n: 3 })).toBe("Archived, 3 threads");
    expect(fill("{missing}", {})).toBe("{missing}");
  });
});
