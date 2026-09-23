// What a compose surface asks of the controller that owns it, beyond the props
// the screen passes: minimize into the dock, discard with Undo, the window
// Settings, the assist switch, who wrote the Draft. Keyed by the Composer, so
// the overlay and the inline reply find their controller without the screen
// threading new props through. Absent (a surface rendered on its own in a
// test) means the plain behavior: close is close, no dock.

import type { DraftContent } from "@monday/shared";
import type { Composer } from "./composer.ts";
import type { WindowSettings } from "./windows.ts";

/** What an open surface reports when the controller needs its latest content. */
export interface SurfaceState {
  content: DraftContent;
  /** A change is not saved yet. */
  dirty: boolean;
}

/** An open surface as the controller reaches it. */
export interface Surface {
  read(): SurfaceState;
  /** Drops pending changes unsaved: the Draft is being thrown away. */
  stop(): void;
}

export interface ComposeLink {
  settings: WindowSettings;
  /** The writing toolbar is shown (compose.toolbar). */
  toolbar: boolean;
  /** The assist menu may show: the Setting is on and the AI level is not off. */
  assist: boolean;
  /** The language Translate offers first. */
  translateTo: string;
  /** Minimizes a window or the inline reply into the dock. */
  minimize(draftId: string, state: SurfaceState): void;
  /** Throws the Draft away; the screen offers Undo. */
  discard(draftId: string, content: DraftContent): void;
  /** What a fresh window opened with, for "has this any content"; null for a saved Draft. */
  pristineOf(draftId: string): DraftContent | null;
  /** How the window with this Draft is leaving, for its animation. */
  exitOf(draftId: string): "minimize" | "close" | null;
  /** The window was restored from the dock: it grows out of its chip. */
  fromDock(draftId: string): boolean;
  /** "agent" when the Agent wrote the Draft as it was opened. */
  authorOf(draftId: string): "agent" | "user" | null;
  /** The open surface registers how to read and stop it; returns the unregister. */
  register(draftId: string, surface: Surface): () => void;
}

const links = new WeakMap<Composer, ComposeLink>();

export function linkOf(composer: Composer): ComposeLink | undefined {
  return links.get(composer);
}

export function setLink(composer: Composer, link: ComposeLink | null): void {
  if (link) links.set(composer, link);
  else links.delete(composer);
}
