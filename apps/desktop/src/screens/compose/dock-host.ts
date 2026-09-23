// Where the dock renders: its own small React root on the document body, so
// the minimized messages stay on screen whatever the Inbox screen renders
// (the screen only renders the active window). Created the first time there
// is something to show and kept until the controller unmounts.

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

type RootLike = { render(node: ReactNode): void; unmount(): void };

export function useDockHost(node: ReactNode, show: boolean): void {
  const host = useRef<{ el: HTMLElement; root: RootLike | null; pending: ReactNode } | null>(null);
  const latest = useRef(node);
  latest.current = node;

  useEffect(() => {
    if (!show && !host.current) return;
    if (!host.current) {
      const el = document.createElement("div");
      el.className = "compose-layer";
      document.body.appendChild(el);
      const entry: { el: HTMLElement; root: RootLike | null; pending: ReactNode } = {
        el,
        root: null,
        pending: latest.current,
      };
      host.current = entry;
      // Loaded on first use: react-dom/client must not load before a test's DOM exists.
      void import("react-dom/client").then(({ createRoot }) => {
        if (host.current !== entry) return;
        entry.root = createRoot(el);
        entry.root.render(entry.pending);
      });
      return;
    }
    host.current.pending = node;
    host.current.root?.render(node);
  });

  useEffect(
    () => () => {
      const entry = host.current;
      host.current = null;
      if (!entry) return;
      // Unmounting a root while React renders another warns; after the commit it is quiet.
      queueMicrotask(() => {
        entry.root?.unmount();
        entry.el.remove();
      });
    },
    [],
  );
}
