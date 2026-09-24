// The window title follows the screen (strings.window.title, "{screen} · monday"):
// the document's title everywhere, and the native window's in the app.

import { useEffect } from "react";
import { useIsActivePane } from "./active.ts";

/** The title for a screen from the Setting's template. */
export function windowTitle(template: string, screen: string): string {
  return template.replaceAll("{screen}", screen);
}

/** Sets the document title and, inside Tauri, the native window's. Never throws. */
export function useWindowTitle(title: string): void {
  // Only the Workspace on show names the window.
  const active = useIsActivePane();
  useEffect(() => {
    if (!active) return;
    if (typeof document !== "undefined") document.title = title;
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
      .catch(() => {});
  }, [title, active]);
}
