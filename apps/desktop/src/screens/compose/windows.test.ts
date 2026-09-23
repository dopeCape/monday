/// <reference types="bun-types" />
// Compose windows as data: which window is open, which sit beside it, which
// are docked, and what each Setting changes about that.

import { describe, expect, test } from "bun:test";
import type { DraftContent } from "@monday/shared";
import { placeMenu } from "./placement.ts";
import {
  type ComposeWindow,
  cycleOrder,
  dockView,
  hasContent,
  minimizeActive,
  NO_WINDOWS,
  nextInCycle,
  openWindow,
  setDirty,
  type WindowSettings,
} from "./windows.ts";

const content = (patch: Partial<DraftContent> = {}): DraftContent => ({
  threadId: null,
  kind: "new",
  inReplyToMessageId: null,
  to: [],
  cc: [],
  bcc: [],
  subject: "",
  bodyText: "",
  bodyHtml: "",
  attachments: [],
  ...patch,
});

const win = (draftId: string, patch: Partial<DraftContent> = {}): ComposeWindow => ({
  draftId,
  initial: content(patch),
  pristine: null,
  dirty: false,
});

const settings = (patch: Partial<WindowSettings> = {}): WindowSettings => ({
  closeBehavior: "minimize",
  dockPosition: "bottom-right",
  dockMaxVisible: 3,
  newWhileOpen: "minimize",
  windowStyle: "sheet",
  restoreDocked: true,
  ...patch,
});

describe("compose windows", () => {
  test("a new window minimizes the open one into the front of the dock", () => {
    let w = openWindow(NO_WINDOWS, win("a", { subject: "A" }), settings());
    w = openWindow(w, win("b"), settings());
    w = openWindow(w, win("c"), settings());
    expect(w.active?.draftId).toBe("c");
    expect(w.docked.map((d) => d.draftId)).toEqual(["b", "a"]);
    expect(w.stacked).toEqual([]);
  });

  test("with new_while_open = stack the open one stays open beside it", () => {
    let w = openWindow(NO_WINDOWS, win("a"), settings({ newWhileOpen: "stack" }));
    w = openWindow(w, win("b"), settings({ newWhileOpen: "stack" }));
    expect(w.active?.draftId).toBe("b");
    expect(w.stacked.map((d) => d.draftId)).toEqual(["a"]);
    expect(w.docked).toEqual([]);
  });

  test("setting a window aside keeps the latest content it reported", () => {
    const first = openWindow(NO_WINDOWS, win("a"), settings());
    const typed = { ...win("a"), initial: content({ subject: "Typed" }) };
    const w = openWindow(first, win("b"), settings(), typed);
    expect(w.docked[0]?.initial.subject).toBe("Typed");
  });

  test("restoring a docked Draft moves it out of the dock and says it came from there", () => {
    let w = openWindow(NO_WINDOWS, win("a"), settings());
    w = minimizeActive(w, win("a"));
    expect(w.active).toBeNull();
    w = openWindow(w, win("a"), settings());
    expect(w.active?.draftId).toBe("a");
    expect(w.active?.fromDock).toBe(true);
    expect(w.docked).toEqual([]);
  });

  test("a Draft never opens twice", () => {
    let w = openWindow(NO_WINDOWS, win("a"), settings());
    w = openWindow(w, win("b"), settings());
    w = openWindow(w, win("a"), settings());
    expect(cycleOrder(w)).toEqual(["a", "b"]);
  });

  test("the cycle walks every window, sending the current one to the back", () => {
    let w = openWindow(NO_WINDOWS, win("a"), settings());
    w = openWindow(w, win("b"), settings());
    w = openWindow(w, win("c"), settings());
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const next = nextInCycle(w);
      if (!next) break;
      seen.push(next);
      w = openWindow(w, win(next), settings(), undefined, "back");
    }
    expect(seen).toEqual(["b", "a", "c"]);
  });

  test("the dock folds past the visible count into +N", () => {
    const docked = ["a", "b", "c", "d", "e"].map((id) => win(id));
    const view = dockView(docked, 3);
    expect(view.visible.map((w) => w.draftId)).toEqual(["a", "b", "c"]);
    expect(view.folded.map((w) => w.draftId)).toEqual(["d", "e"]);
    expect(dockView(docked.slice(0, 2), 3).folded).toEqual([]);
  });

  test("the unsaved dot clears once the Draft is saved", () => {
    let w = minimizeActive(openWindow(NO_WINDOWS, win("a"), settings()), {
      ...win("a"),
      dirty: true,
    });
    expect(w.docked[0]?.dirty).toBe(true);
    w = setDirty(w, "a", false);
    expect(w.docked[0]?.dirty).toBe(false);
  });

  test("a fresh window counts as written in only once it changed; a saved Draft by its content", () => {
    const fresh = content({ bodyText: "Tejas" });
    expect(hasContent(fresh, fresh)).toBe(false);
    expect(hasContent({ ...fresh, subject: "Hi" }, fresh)).toBe(true);
    expect(hasContent(content(), null)).toBe(false);
    expect(hasContent(content({ to: [{ name: "", email: "a@b.c" }] }), null)).toBe(true);
  });
});

describe("the anchored menu's placement", () => {
  const viewport = { width: 1440, height: 900 };
  const size = { width: 220, height: 160 };

  test("below the button when there is room, aligned to its start", () => {
    const p = placeMenu({ top: 100, bottom: 130, left: 300, right: 380 }, size, viewport);
    expect(p).toEqual({ top: 136, left: 300, above: false });
  });

  test("above the button when the room below is too small", () => {
    const p = placeMenu({ top: 820, bottom: 850, left: 300, right: 380 }, size, viewport);
    expect(p.above).toBe(true);
    expect(p.top).toBe(820 - 6 - 160);
  });

  test("aligned to the button's end, and never past the window edge", () => {
    const end = placeMenu({ top: 100, bottom: 130, left: 1300, right: 1380 }, size, viewport, {
      align: "end",
    });
    expect(end.left).toBe(1380 - 220);
    const clamped = placeMenu({ top: 100, bottom: 130, left: 1400, right: 1430 }, size, viewport);
    expect(clamped.left).toBe(1440 - 8 - 220);
  });
});
