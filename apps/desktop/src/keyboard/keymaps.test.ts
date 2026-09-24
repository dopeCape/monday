/// <reference types="bun-types" />
// Keymap resolution and the chord grammar (docs/spec/inbox.md, Keyboard).

import { describe, expect, test } from "bun:test";
import {
  actionFor,
  chordLabel,
  chordOf,
  conflicts,
  GMAIL,
  KEY_ACTIONS,
  KEYMAPS,
  NATURAL,
  normalizeChord,
  resolveKeymap,
  VIM,
} from "./keymaps.ts";

describe("built-in keymaps", () => {
  test("every map binds every action", () => {
    for (const map of Object.values(KEYMAPS)) {
      for (const action of KEY_ACTIONS) expect(map[action]).toBeTruthy();
    }
  });

  test("the Vim defaults are the ones the spec lists", () => {
    expect(VIM["move.down"]).toBe("j");
    expect(VIM["move.up"]).toBe("k");
    expect(VIM["thread.open"]).toBe("enter");
    expect(VIM["sheet.close"]).toBe("escape");
    expect(VIM["thread.archive"]).toBe("e");
    expect(VIM["thread.snooze"]).toBe("h");
    expect(VIM["thread.star"]).toBe("s");
    expect(VIM["thread.delete"]).toBe("#");
    expect(VIM["thread.label"]).toBe("l");
    expect(VIM["thread.move"]).toBe("m");
    expect(VIM["compose.reply"]).toBe("r");
    expect(VIM["compose.reply_all"]).toBe("a");
    expect(VIM["compose.forward"]).toBe("f");
    expect(VIM["select.toggle"]).toBe("x");
    expect(VIM["select.extend_down"]).toBe("shift+j");
    expect(VIM["select.extend_up"]).toBe("shift+k");
    expect(VIM.undo).toBe("z");
    expect(VIM["agent.focus"]).toBe("/");
    expect(VIM["palette.open"]).toBe("mod+k");
    for (let n = 1; n <= 9; n++) expect(VIM[`view.${n}` as keyof typeof VIM]).toBe(`mod+${n}`);
  });

  test("no built-in map has two actions on one chord", () => {
    expect(conflicts(VIM)).toEqual([]);
    expect(conflicts(GMAIL)).toEqual([]);
    expect(conflicts(NATURAL)).toEqual([]);
  });

  test("Gmail and Natural differ from Vim where they should", () => {
    expect(GMAIL["thread.open"]).toBe("o");
    expect(GMAIL["thread.snooze"]).toBe("b");
    expect(NATURAL["move.down"]).toBe("arrowdown");
    expect(NATURAL["thread.archive"]).toBe("backspace");
    expect(NATURAL.undo).toBe("mod+z");
  });
});

describe("resolveKeymap", () => {
  test("returns the named map with no overrides", () => {
    expect(resolveKeymap("vim", {})).toEqual(VIM);
    expect(resolveKeymap("gmail", {})).toEqual(GMAIL);
    expect(resolveKeymap("natural", {})).toEqual(NATURAL);
  });

  test("overrides replace one action's chord and normalize it", () => {
    const map = resolveKeymap("vim", { "thread.archive": "Shift+E", "palette.open": "Cmd+P" });
    expect(map["thread.archive"]).toBe("shift+e");
    expect(map["palette.open"]).toBe("mod+p");
    expect(map["move.down"]).toBe("j");
  });

  test("unknown actions and empty chords are ignored", () => {
    const map = resolveKeymap("vim", { "not.an.action": "q", undo: "" });
    expect(map).toEqual(VIM);
  });

  test("an override can create a conflict the Shortcuts page can show", () => {
    const map = resolveKeymap("vim", { "thread.star": "e" });
    expect(conflicts(map)).toEqual([{ chord: "e", actions: ["thread.archive", "thread.star"] }]);
  });
});

describe("chords", () => {
  const ev = (key: string, mods: Partial<Parameters<typeof chordOf>[0]> = {}) =>
    chordOf({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

  test("normalizeChord canonicalizes order, case and aliases", () => {
    expect(normalizeChord("K+Shift+Mod")).toBe("mod+shift+k");
    expect(normalizeChord("ctrl+k")).toBe("mod+k");
    expect(normalizeChord("Esc")).toBe("escape");
    expect(normalizeChord("space")).toBe(" ");
    expect(normalizeChord("#")).toBe("#");
    expect(normalizeChord("shift+#")).toBe("#");
    expect(normalizeChord("shift")).toBe("");
  });

  test("chordOf reads the event the way the maps are written", () => {
    expect(ev("j")).toBe("j");
    expect(ev("J", { shiftKey: true })).toBe("shift+j");
    expect(ev("#", { shiftKey: true })).toBe("#");
    expect(ev("k", { metaKey: true })).toBe("mod+k");
    expect(ev("k", { ctrlKey: true })).toBe("mod+k");
    expect(ev("Enter")).toBe("enter");
    expect(ev("ArrowDown", { shiftKey: true })).toBe("shift+arrowdown");
  });

  test("actionFor finds the bound action", () => {
    expect(actionFor(VIM, "e")).toBe("thread.archive");
    expect(actionFor(VIM, "mod+3")).toBe("view.3");
    expect(actionFor(VIM, "q")).toBeNull();
  });

  test("chordLabel prints for the platform", () => {
    expect(chordLabel("mod+k", true)).toBe("⌘K");
    expect(chordLabel("mod+k", false)).toBe("Ctrl+K");
    expect(chordLabel("shift+j", true)).toBe("⇧J");
    expect(chordLabel("escape", false)).toBe("Esc");
    expect(chordLabel("z", false)).toBe("Z");
  });
});

describe("scopes", () => {
  test("the Calendar's keys share chords with the mail screens' without clashing", () => {
    expect(VIM["calendar.view.month"]).toBe(VIM["thread.move"]);
    expect(actionFor(VIM, "m")).toBe("thread.move");
    expect(actionFor(VIM, "m", "calendar")).toBe("calendar.view.month");
    expect(actionFor(VIM, "j", "calendar")).toBe("calendar.next");
    expect(actionFor(NATURAL, "arrowleft", "calendar")).toBe("calendar.previous");
    // The global ones work on both.
    expect(actionFor(VIM, "mod+k", "calendar")).toBe("palette.open");
    expect(actionFor(VIM, "z", "calendar")).toBe("undo");
    expect(actionFor(VIM, "e", "calendar")).toBeNull();
  });

  test("a clash is flagged only where both actions work", () => {
    const map = resolveKeymap("vim", { "calendar.today": "/" });
    expect(conflicts(map)).toEqual([{ chord: "/", actions: ["agent.focus", "calendar.today"] }]);
    const both = resolveKeymap("vim", { "calendar.today": "d" });
    expect(conflicts(both)).toEqual([
      { chord: "d", actions: ["calendar.today", "calendar.view.day"] },
    ]);
  });
});
