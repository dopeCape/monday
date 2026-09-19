/// <reference types="bun-types" />
// The dispatcher: every Vim binding reaches its action with the context, and
// typing in a field swallows the plain keys.

import { describe, expect, test } from "bun:test";
import { KEY_ACTIONS, type KeyAction, NATURAL, VIM } from "./keymaps.ts";
import { type DispatchEvent, dispatchKey, type KeyContext, type KeyHandlers } from "./useKeymap.ts";

const ctx: KeyContext = { pane: "list", focus: "e2", selection: ["e1", "e2"] };

function press(key: string, mods: Partial<DispatchEvent> = {}): DispatchEvent {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    typing: false,
    preventDefault: () => undefined,
    ...mods,
  };
}

/** Handlers that record which action ran with which context. */
function recorder() {
  const ran: Array<{ action: KeyAction; ctx: KeyContext }> = [];
  const handlers: KeyHandlers = {};
  for (const action of KEY_ACTIONS) handlers[action] = (c) => ran.push({ action, ctx: c });
  return { ran, handlers };
}

describe("dispatchKey with the Vim map", () => {
  const presses: Array<[DispatchEvent, KeyAction]> = [
    [press("j"), "move.down"],
    [press("k"), "move.up"],
    [press("Enter"), "thread.open"],
    [press("Escape"), "sheet.close"],
    [press("e"), "thread.archive"],
    [press("h"), "thread.snooze"],
    [press("s"), "thread.star"],
    [press("#", { shiftKey: true }), "thread.delete"],
    [press("l"), "thread.label"],
    [press("m"), "thread.move"],
    [press("r"), "compose.reply"],
    [press("a"), "compose.reply_all"],
    [press("f"), "compose.forward"],
    [press("x"), "select.toggle"],
    [press("J", { shiftKey: true }), "select.extend_down"],
    [press("K", { shiftKey: true }), "select.extend_up"],
    [press("z"), "undo"],
    [press("/"), "agent.focus"],
    [press("k", { metaKey: true }), "palette.open"],
    [press("k", { ctrlKey: true }), "palette.open"],
    [press("1", { metaKey: true }), "view.1"],
    [press("5", { ctrlKey: true }), "view.5"],
    [press("9", { metaKey: true }), "view.9"],
  ];

  for (const [e, expected] of presses) {
    test(`${e.shiftKey ? "shift+" : ""}${e.metaKey || e.ctrlKey ? "mod+" : ""}${e.key} runs ${expected}`, () => {
      const { ran, handlers } = recorder();
      let prevented = false;
      const result = dispatchKey(VIM, handlers, ctx, {
        ...e,
        preventDefault: () => {
          prevented = true;
        },
      });
      expect(result).toBe(expected);
      expect(ran).toEqual([{ action: expected, ctx: { ...ctx, typing: false } }]);
      expect(prevented).toBe(true);
    });
  }

  test("an unbound key does nothing and is not prevented", () => {
    const { ran, handlers } = recorder();
    let prevented = false;
    const result = dispatchKey(VIM, handlers, ctx, {
      ...press("q"),
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(result).toBeNull();
    expect(ran).toEqual([]);
    expect(prevented).toBe(false);
  });

  test("a bound action without a handler is left to the browser", () => {
    const result = dispatchKey(VIM, {}, ctx, press("j"));
    expect(result).toBeNull();
  });

  test("a handler that declines with false leaves the key its default", () => {
    let prevented = false;
    const result = dispatchKey(VIM, { "move.down": () => false }, ctx, {
      ...press("j"),
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(result).toBeNull();
    expect(prevented).toBe(false);
  });
});

describe("typing in a field", () => {
  test("swallows plain keys", () => {
    const { ran, handlers } = recorder();
    for (const key of ["j", "e", "#", "x", "z", "/", "Enter"]) {
      expect(dispatchKey(VIM, handlers, ctx, press(key, { typing: true }))).toBeNull();
    }
    expect(ran).toEqual([]);
  });

  test("still lets Escape and modifier chords through", () => {
    const { ran, handlers } = recorder();
    expect(dispatchKey(VIM, handlers, ctx, press("Escape", { typing: true }))).toBe("sheet.close");
    expect(dispatchKey(VIM, handlers, ctx, press("k", { typing: true, metaKey: true }))).toBe(
      "palette.open",
    );
    expect(ran.map((r) => r.action)).toEqual(["sheet.close", "palette.open"]);
  });

  test("tells the handler it is typing, so the Natural map's mod+z can yield to the field's own undo", () => {
    let prevented = false;
    const handlers: KeyHandlers = { undo: (c) => (c.typing ? false : undefined) };
    const e = {
      ...press("z", { typing: true, metaKey: true }),
      preventDefault: () => {
        prevented = true;
      },
    };
    expect(dispatchKey(NATURAL, handlers, ctx, e)).toBeNull();
    expect(prevented).toBe(false);
    expect(dispatchKey(NATURAL, handlers, ctx, { ...e, typing: false })).toBe("undo");
    expect(prevented).toBe(true);
  });
});
