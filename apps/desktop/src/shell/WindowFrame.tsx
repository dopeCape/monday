// The window's own frame in the desktop app, where the native decorations are
// off (tauri.conf.json): the title strip with minimize, maximize or restore,
// and close, over the platform's WindowFrame. The maximize button follows the
// window's state, read again on every resize (a maximize from the keyboard or
// a snap changes it too). Close goes through the window's normal close, so
// Rust stops the Sidecar and its Postgres as it always has. Without a frame
// (the browser dev server, tests) nothing renders and no strip is reserved;
// on a phone or tablet OS neither, whatever the host offers.

import { TitleBar } from "@monday/ui";
import { useEffect, useState } from "react";
import { type WindowFrame as Frame, type Platform, platform } from "../platform/tauri.ts";
import { useShell } from "./Shell.tsx";

export function WindowFrame({
  load = platform,
}: {
  /** The platform seam; tests hand a fake one with or without a frame. */
  load?: (() => Promise<Platform>) | undefined;
}) {
  const shell = useShell();
  const s = shell.settings;
  const [found, setFrame] = useState<Frame | null>(null);
  // A phone or tablet has no window to move or close: no strip, no drag region.
  const frame = shell.mobile ? null : found;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let live = true;
    void load()
      .then((p) => {
        if (live) setFrame(p.frame ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [load]);

  // The strip's height is reserved only while it shows.
  useEffect(() => {
    if (!frame || typeof document === "undefined") return;
    const root = document.documentElement;
    root.dataset.titlebar = "custom";
    return () => {
      delete root.dataset.titlebar;
    };
  }, [frame]);

  useEffect(() => {
    if (!frame) return;
    let live = true;
    const read = () =>
      void frame
        .isMaximized()
        .then((m) => {
          if (live) setMaximized(m);
        })
        .catch(() => {});
    read();
    const off = frame.onResized(read);
    return () => {
      live = false;
      off();
    };
  }, [frame]);

  if (!frame) return null;
  const quiet = (p: Promise<void>) => void p.catch(() => {});
  return (
    <TitleBar
      maximized={maximized}
      labels={{
        minimize: s["strings.window.minimize"],
        maximize: s["strings.window.maximize"],
        restore: s["strings.window.restore"],
        close: s["strings.window.close"],
      }}
      onMinimize={() => quiet(frame.minimize())}
      onToggleMaximize={() => quiet(frame.toggleMaximize())}
      onClose={() => quiet(frame.close())}
      onDrag={() => quiet(frame.startDragging())}
    />
  );
}
