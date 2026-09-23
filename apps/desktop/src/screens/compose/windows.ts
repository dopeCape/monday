// Compose windows as data (docs/spec/inbox.md, "Composing several messages at
// once"): the one window that is open, the windows kept open beside it, and
// the minimized ones docked along the bottom edge. Every window is an ordinary
// Draft; these functions only decide where each one shows. Pure, so the rules
// the Settings choose between are testable without a DOM.

import type { DraftContent, Settings } from "@monday/shared";

export type CloseBehavior = "minimize" | "close";
export type DockPosition = "bottom-right" | "bottom-left" | "bottom-full";
export type NewWhileOpen = "minimize" | "stack";
export type WindowStyle = "sheet" | "docked" | "fullscreen";

export interface WindowSettings {
  closeBehavior: CloseBehavior;
  dockPosition: DockPosition;
  dockMaxVisible: number;
  newWhileOpen: NewWhileOpen;
  windowStyle: WindowStyle;
  restoreDocked: boolean;
}

export function windowSettings(s: Settings): WindowSettings {
  return {
    closeBehavior: s["compose.close_behavior"],
    dockPosition: s["compose.dock_position"],
    dockMaxVisible: s["compose.dock_max_visible"],
    newWhileOpen: s["compose.new_while_open"],
    windowStyle: s["compose.window_style"],
    restoreDocked: s["compose.restore_docked_on_launch"],
  };
}

export interface ComposeWindow {
  draftId: string;
  /** What the window opens with: the Draft's content when it was last shown. */
  initial: DraftContent;
  /**
   * What a fresh window opened with (the signature, a reply's recipients and
   * quote), so a window nobody changed counts as empty. Null for a Draft that
   * was saved before: any content counts then.
   */
  pristine: DraftContent | null;
  /** A minimized window whose last change is not saved yet. */
  dirty: boolean;
  /** Restored from the dock: the window grows out of its chip. */
  fromDock?: boolean | undefined;
}

export interface Windows {
  /** The window with the keyboard: the sheet the screen renders. */
  active: ComposeWindow | null;
  /** Kept open beside the active one (compose.new_while_open = stack), oldest first. */
  stacked: readonly ComposeWindow[];
  /** Minimized, most recently minimized first. */
  docked: readonly ComposeWindow[];
}

export const NO_WINDOWS: Windows = { active: null, stacked: [], docked: [] };

export const sameContent = (a: DraftContent, b: DraftContent): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether a Draft holds anything worth keeping. A fresh window counts once it
 * changed from what it opened with; a saved Draft counts with any recipient,
 * subject, attachment or text.
 */
export function hasContent(content: DraftContent, pristine: DraftContent | null = null): boolean {
  if (pristine) return !sameContent(content, pristine);
  if (content.to.length + content.cc.length + content.bcc.length > 0) return true;
  if (content.subject.trim() !== "") return true;
  if (content.attachments.length > 0) return true;
  return content.bodyText.trim() !== "";
}

const without = (list: readonly ComposeWindow[], draftId: string) =>
  list.filter((w) => w.draftId !== draftId);

/** Every window's Draft, in the order the cycle shortcut walks them. */
export function cycleOrder(w: Windows): string[] {
  return [
    ...(w.active ? [w.active.draftId] : []),
    ...w.stacked.map((x) => x.draftId),
    ...w.docked.map((x) => x.draftId),
  ];
}

export function findWindow(w: Windows, draftId: string): ComposeWindow | null {
  if (w.active?.draftId === draftId) return w.active;
  return (
    w.stacked.find((x) => x.draftId === draftId) ??
    w.docked.find((x) => x.draftId === draftId) ??
    null
  );
}

/** Puts the active window aside for another: into the dock, or open beside it. */
function setAside(
  w: Windows,
  s: WindowSettings,
  latest?: ComposeWindow,
  to: "front" | "back" = "front",
): Windows {
  const current = latest ?? w.active;
  if (!current) return w;
  const aside = { ...current, fromDock: false };
  if (s.newWhileOpen === "stack") {
    return { ...w, active: null, stacked: [...without(w.stacked, aside.draftId), aside] };
  }
  const rest = without(w.docked, aside.draftId);
  return { ...w, active: null, docked: to === "front" ? [aside, ...rest] : [...rest, aside] };
}

/**
 * Opens a window. The one already open is minimized (or kept open beside it,
 * by Setting); a Draft already in a window moves to the front instead of
 * opening twice.
 */
export function openWindow(
  w: Windows,
  win: ComposeWindow,
  s: WindowSettings,
  latestActive?: ComposeWindow,
  /** The cycle shortcut sends the current window to the back, so repeated presses walk them all. */
  asideTo: "front" | "back" = "front",
): Windows {
  if (w.active?.draftId === win.draftId) return w;
  const existing = findWindow(w, win.draftId);
  const opening = existing
    ? { ...existing, fromDock: w.docked.some((d) => d.draftId === win.draftId) }
    : win;
  const base = w.active ? setAside(w, s, latestActive, asideTo) : w;
  return {
    active: opening,
    stacked: without(base.stacked, opening.draftId),
    docked: without(base.docked, opening.draftId),
  };
}

/** Collapses the active window (with its latest content) into the dock. */
export function minimizeActive(w: Windows, latest: ComposeWindow): Windows {
  return {
    active: w.active?.draftId === latest.draftId ? null : w.active,
    stacked: without(w.stacked, latest.draftId),
    docked: [{ ...latest, fromDock: false }, ...without(w.docked, latest.draftId)],
  };
}

/** Docks a window that was not the active one (an inline reply, a stacked window). */
export function dock(w: Windows, win: ComposeWindow): Windows {
  return {
    active: w.active?.draftId === win.draftId ? null : w.active,
    stacked: without(w.stacked, win.draftId),
    docked: [{ ...win, fromDock: false }, ...without(w.docked, win.draftId)],
  };
}

/** A window leaves the screen (closed with its Draft kept, sent, discarded). */
export function forget(w: Windows, draftId: string): Windows {
  if (!findWindow(w, draftId)) return w;
  return {
    active: w.active?.draftId === draftId ? null : w.active,
    stacked: without(w.stacked, draftId),
    docked: without(w.docked, draftId),
  };
}

/** Marks a docked window saved (the dot goes away) or not. */
export function setDirty(w: Windows, draftId: string, dirty: boolean): Windows {
  const touch = (list: readonly ComposeWindow[]) =>
    list.some((x) => x.draftId === draftId && x.dirty !== dirty)
      ? list.map((x) => (x.draftId === draftId ? { ...x, dirty } : x))
      : list;
  const docked = touch(w.docked);
  const stacked = touch(w.stacked);
  return docked === w.docked && stacked === w.stacked ? w : { ...w, docked, stacked };
}

/** The next Draft the cycle shortcut opens, or null when there is nothing to move to. */
export function nextInCycle(w: Windows): string | null {
  const order = cycleOrder(w);
  if (!w.active) return order[0] ?? null;
  return order.length > 1 ? (order[1] ?? null) : null;
}

/** The chips the dock shows and the ones folded into "+N". */
export function dockView(
  docked: readonly ComposeWindow[],
  maxVisible: number,
): { visible: ComposeWindow[]; folded: ComposeWindow[] } {
  const n = Math.max(1, maxVisible);
  return { visible: docked.slice(0, n), folded: docked.slice(n) };
}
