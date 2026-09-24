// The three built-in keymaps (docs/spec/inbox.md, Keyboard) and the chord
// grammar. Pure: no DOM, so the maps and the resolver are testable as data.
//
// A chord is "mod+shift+k": modifiers in any order, then one key. "mod" is
// Command on macOS and Control elsewhere; both are accepted. Keys are
// event.key lowercased ("j", "enter", "escape", "arrowdown", "#", "/").
// Shift is implied for printable non-letters such as "#", so the chord is "#"
// even though the user holds Shift to type it.
//
// Actions have a scope: the mail screens' actions and the Calendar's share
// chords ("m" moves a Thread in the Inbox and opens Month on the Calendar),
// and a few global ones (the palette, the agent, Escape, the saved views)
// work everywhere. Two actions clash only when their scopes meet.

export const KEY_ACTIONS = [
  "move.down",
  "move.up",
  "thread.open",
  "sheet.close",
  "thread.archive",
  "thread.snooze",
  "thread.star",
  "thread.delete",
  "thread.label",
  "thread.move",
  "compose.new",
  "compose.reply",
  "compose.reply_all",
  "compose.forward",
  "compose.cycle",
  "select.toggle",
  "select.extend_down",
  "select.extend_up",
  "undo",
  "agent.focus",
  "palette.open",
  "view.1",
  "view.2",
  "view.3",
  "view.4",
  "view.5",
  "view.6",
  "view.7",
  "view.8",
  "view.9",
  "calendar.today",
  "calendar.previous",
  "calendar.next",
  "calendar.view.day",
  "calendar.view.week",
  "calendar.view.month",
  "calendar.view.agenda",
  "calendar.new_event",
  "calendar.search",
] as const;

export type KeyAction = (typeof KEY_ACTIONS)[number];
export type KeymapName = "vim" | "gmail" | "natural";
export type Keymap = Readonly<Record<KeyAction, string>>;

/** Where an action works: the mail screens, the Calendar, or everywhere. */
export type KeyScope = "mail" | "calendar" | "global";

const GLOBAL_ACTIONS: ReadonlySet<string> = new Set([
  "palette.open",
  "agent.focus",
  "sheet.close",
  "undo",
]);

export function actionScope(action: KeyAction): KeyScope {
  if (action.startsWith("calendar.")) return "calendar";
  if (GLOBAL_ACTIONS.has(action) || action.startsWith("view.")) return "global";
  return "mail";
}

/** Whether an action is live on a screen of this scope. */
export function inScope(action: KeyAction, scope: Exclude<KeyScope, "global">): boolean {
  const own = actionScope(action);
  return own === "global" || own === scope;
}

const calendarKeys = {
  "calendar.today": "t",
  "calendar.view.day": "d",
  "calendar.view.week": "w",
  "calendar.view.month": "m",
  "calendar.view.agenda": "a",
  "calendar.search": "mod+f",
} as const;

const views = {
  "view.1": "mod+1",
  "view.2": "mod+2",
  "view.3": "mod+3",
  "view.4": "mod+4",
  "view.5": "mod+5",
  "view.6": "mod+6",
  "view.7": "mod+7",
  "view.8": "mod+8",
  "view.9": "mod+9",
} as const;

export const VIM: Keymap = {
  "move.down": "j",
  "move.up": "k",
  "thread.open": "enter",
  "sheet.close": "escape",
  "thread.archive": "e",
  "thread.snooze": "h",
  "thread.star": "s",
  "thread.delete": "#",
  "thread.label": "l",
  "thread.move": "m",
  "compose.new": "c",
  "compose.reply": "r",
  "compose.reply_all": "a",
  "compose.forward": "f",
  "compose.cycle": "mod+shift+d",
  "select.toggle": "x",
  "select.extend_down": "shift+j",
  "select.extend_up": "shift+k",
  undo: "z",
  "agent.focus": "/",
  "palette.open": "mod+k",
  ...views,
  ...calendarKeys,
  "calendar.previous": "k",
  "calendar.next": "j",
  "calendar.new_event": "c",
};

export const GMAIL: Keymap = {
  "move.down": "j",
  "move.up": "k",
  "thread.open": "o",
  "sheet.close": "u",
  "thread.archive": "e",
  "thread.snooze": "b",
  "thread.star": "s",
  "thread.delete": "#",
  "thread.label": "l",
  "thread.move": "v",
  "compose.new": "c",
  "compose.reply": "r",
  "compose.reply_all": "a",
  "compose.forward": "f",
  "compose.cycle": "mod+shift+d",
  "select.toggle": "x",
  "select.extend_down": "shift+j",
  "select.extend_up": "shift+k",
  undo: "z",
  "agent.focus": "/",
  "palette.open": "mod+k",
  ...views,
  ...calendarKeys,
  "calendar.previous": "k",
  "calendar.next": "j",
  "calendar.new_event": "c",
};

export const NATURAL: Keymap = {
  "move.down": "arrowdown",
  "move.up": "arrowup",
  "thread.open": "enter",
  "sheet.close": "escape",
  "thread.archive": "backspace",
  "thread.snooze": "mod+shift+h",
  "thread.star": "mod+shift+s",
  "thread.delete": "delete",
  "thread.label": "mod+shift+l",
  "thread.move": "mod+shift+m",
  "compose.new": "mod+n",
  "compose.reply": "mod+r",
  "compose.reply_all": "mod+shift+r",
  "compose.forward": "mod+shift+f",
  "compose.cycle": "mod+shift+d",
  "select.toggle": " ",
  "select.extend_down": "shift+arrowdown",
  "select.extend_up": "shift+arrowup",
  undo: "mod+z",
  "agent.focus": "mod+/",
  "palette.open": "mod+k",
  ...views,
  ...calendarKeys,
  "calendar.previous": "arrowleft",
  "calendar.next": "arrowright",
  "calendar.new_event": "mod+n",
};

export const KEYMAPS: Readonly<Record<KeymapName, Keymap>> = {
  vim: VIM,
  gmail: GMAIL,
  natural: NATURAL,
};

export function isKeyAction(name: string): name is KeyAction {
  return (KEY_ACTIONS as readonly string[]).includes(name);
}

/**
 * The active map: the named built-in with per-action overrides on top
 * (settings "keyboard.keymap" and "keyboard.bindings"). Unknown action names
 * and empty chords in the overrides are ignored.
 */
export function resolveKeymap(
  name: KeymapName,
  overrides: Readonly<Record<string, string>>,
): Keymap {
  const map: Record<KeyAction, string> = { ...(KEYMAPS[name] ?? VIM) };
  for (const [action, chord] of Object.entries(overrides)) {
    const c = normalizeChord(chord);
    if (isKeyAction(action) && c) map[action] = c;
  }
  return map;
}

/* ------------------------------ Chords ------------------------------ */

const MOD_NAMES = new Set(["mod", "cmd", "meta", "ctrl", "control"]);
const ALT_NAMES = new Set(["alt", "option"]);

/** "Shift+J" to "shift+j"; "Cmd+K" to "mod+k". Empty when no key is named. */
export function normalizeChord(text: string): string {
  if (text.trim() === "+") return "+";
  const parts = text
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  const mods = new Set<string>();
  let key = "";
  for (const p of parts) {
    if (MOD_NAMES.has(p)) mods.add("mod");
    else if (ALT_NAMES.has(p)) mods.add("alt");
    else if (p === "shift") mods.add("shift");
    else key = keyName(p);
  }
  if (!key) return "";
  const out: string[] = [];
  if (mods.has("mod")) out.push("mod");
  if (mods.has("alt")) out.push("alt");
  if (mods.has("shift") && isLetterOrSpecial(key)) out.push("shift");
  out.push(key);
  return out.join("+");
}

function keyName(k: string): string {
  if (k === "space" || k === "spacebar") return " ";
  if (k === "esc") return "escape";
  if (k === "return") return "enter";
  if (k === "del") return "delete";
  if (k === "up") return "arrowup";
  if (k === "down") return "arrowdown";
  if (k === "left") return "arrowleft";
  if (k === "right") return "arrowright";
  return k;
}

/** Shift matters for letters and named keys; "#" already means Shift on most layouts. */
function isLetterOrSpecial(key: string): boolean {
  return /^[a-z]$/.test(key) || key.length > 1;
}

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** The chord a keyboard event represents, in the normalized form above. */
export function chordOf(e: KeyLike): string {
  const key = e.key.toLowerCase();
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey && isLetterOrSpecial(key)) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

/**
 * The action a chord is bound to in a map on a screen of `scope` (the mail
 * screens by default), if any. Earlier actions win on conflict.
 */
export function actionFor(
  map: Keymap,
  chord: string,
  scope: Exclude<KeyScope, "global"> = "mail",
): KeyAction | null {
  for (const action of KEY_ACTIONS) {
    if (map[action] === chord && inScope(action, scope)) return action;
  }
  return null;
}

/** Bindings that share one chord where both work, for the Shortcuts page to highlight. */
export function conflicts(map: Keymap): Array<{ chord: string; actions: KeyAction[] }> {
  const byChord = new Map<string, KeyAction[]>();
  for (const action of KEY_ACTIONS) {
    const list = byChord.get(map[action]) ?? [];
    list.push(action);
    byChord.set(map[action], list);
  }
  const meet = (a: KeyAction, b: KeyAction) => {
    const x = actionScope(a);
    const y = actionScope(b);
    return x === "global" || y === "global" || x === y;
  };
  const out: Array<{ chord: string; actions: KeyAction[] }> = [];
  for (const [chord, actions] of byChord) {
    const clashing = actions.filter((a) => actions.some((b) => b !== a && meet(a, b)));
    if (clashing.length > 1) out.push({ chord, actions: clashing });
  }
  return out;
}

/** "mod+k" as the label the UI prints: "⌘K" on macOS, "Ctrl+K" elsewhere. */
export function chordLabel(chord: string, mac: boolean): string {
  const names: Record<string, string> = {
    enter: "↵",
    escape: "Esc",
    arrowdown: "↓",
    arrowup: "↑",
    arrowleft: "←",
    arrowright: "→",
    backspace: "⌫",
    delete: "Del",
    " ": "Space",
  };
  return chord
    .split("+")
    .map((p) => {
      if (p === "mod") return mac ? "⌘" : "Ctrl";
      if (p === "shift") return mac ? "⇧" : "Shift";
      if (p === "alt") return mac ? "⌥" : "Alt";
      return names[p] ?? p.toUpperCase();
    })
    .join(mac ? "" : "+");
}
