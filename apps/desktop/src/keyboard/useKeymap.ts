// Resolves the active keymap from Settings and dispatches key presses to named
// actions with a context: which pane has focus and what is selected.
//
// Keys are ignored while the user types in an input, textarea or editable
// element, with two exceptions so the app stays reachable from a field:
// Escape, and chords that hold the platform modifier (such as the palette).
// A handler that declines a key (an overlay is open, the field's own undo
// should win) returns false, and the key keeps its default: the browser's
// own undo in a field, a newline in the editor.

import { useEffect, useMemo, useRef } from "react";
import { useIsActivePane } from "../shell/active.ts";
import { useShell } from "../shell/Shell.tsx";
import {
  actionFor,
  chordOf,
  type KeyAction,
  type KeyLike,
  type Keymap,
  type KeymapName,
  type KeyScope,
  resolveKeymap,
} from "./keymaps.ts";

export type Pane = "list" | "reader" | "agent" | "overlay";

export interface KeyContext {
  pane: Pane;
  /** The focus row, the one the next single action applies to. */
  focus: string | null;
  /** The multi-select, in the order the rows were added. */
  selection: readonly string[];
  /** The key came from a field that takes typing (only Escape and mod chords reach a handler then). */
  typing?: boolean | undefined;
}

/** A handler returns false to decline the key; anything else means it was handled. */
export type KeyHandlers = Partial<Record<KeyAction, (ctx: KeyContext) => unknown>>;

export interface DispatchEvent extends KeyLike {
  /** True when the event target takes typing. */
  typing: boolean;
  preventDefault(): void;
}

/**
 * The pure core: given a map, handlers and a context, decides what one key
 * press does. Returns the action it ran, or null when nothing matched.
 */
export function dispatchKey(
  map: Keymap,
  handlers: KeyHandlers,
  ctx: KeyContext,
  e: DispatchEvent,
  scope: Exclude<KeyScope, "global"> = "mail",
): KeyAction | null {
  const chord = chordOf(e);
  if (e.typing && chord !== "escape" && !chord.startsWith("mod+")) return null;
  const action = actionFor(map, chord, scope);
  if (!action) return null;
  const handler = handlers[action];
  if (!handler) return null;
  if (handler({ ...ctx, typing: e.typing }) === false) return null;
  e.preventDefault();
  return action;
}

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (TYPING_TAGS.has(target.tagName)) return true;
  return target.isContentEditable === true;
}

/** The active map from Settings: the chosen built-in plus the user's overrides. */
export function useActiveKeymap(): Keymap {
  const { settings } = useShell();
  const name = settings["keyboard.keymap"] as KeymapName;
  const bindings = settings["keyboard.bindings"];
  return useMemo(() => resolveKeymap(name, bindings), [name, bindings]);
}

/**
 * Listens for key presses on the window and dispatches them through the
 * active map. Handlers and context are read at press time, so callers pass
 * fresh values on every render without re-binding the listener.
 */
export function useKeymap(
  handlers: KeyHandlers,
  ctx: KeyContext,
  scope: Exclude<KeyScope, "global"> = "mail",
): Keymap {
  const map = useActiveKeymap();
  // A Workspace kept mounted behind the one on show answers no keys.
  const active = useIsActivePane();
  const latest = useRef({ handlers, ctx, map, scope, active });
  latest.current = { handlers, ctx, map, scope, active };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!latest.current.active) return;
      if (e.defaultPrevented || e.isComposing) return;
      const { handlers: h, ctx: c, map: m, scope: sc } = latest.current;
      dispatchKey(
        m,
        h,
        c,
        {
          key: e.key,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          typing: isTypingTarget(e.target),
          preventDefault: () => e.preventDefault(),
        },
        sc,
      );
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  return map;
}
