// The window title follows the screen (strings.window.title, "{screen} · monday"):
// the document's title everywhere, and the native window's in the app.

import { useEffect } from "react";
import { useIsActivePane } from "./active.ts";

/** The title for a screen from the Setting's template. */
export function windowTitle(template: string, screen: string): string {
  return template.replaceAll("{screen}", screen);
}

/**
 * The title with the approvals waiting in front (strings.window.title_waiting,
 * "({n}) {title}"), or the title alone when none wait.
 */
export function titleWithWaiting(template: string, title: string, waiting: number): string {
  if (waiting <= 0) return title;
  return template.replaceAll("{n}", String(waiting)).replaceAll("{title}", title);
}

/**
 * The dock or taskbar badge, inside Tauri where the system shows one (macOS,
 * some Linux desktops): the approvals waiting, or none. Only the Workspace on
 * show sets it. Never throws.
 */
export function useWindowBadge(count: number): void {
  const active = useIsActivePane();
  useEffect(() => {
    if (!active) return;
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().setBadgeCount(count > 0 ? count : undefined),
      )
      .catch(() => {});
  }, [count, active]);
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
