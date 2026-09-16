// Keeps a row on screen for one collapse transition after it leaves the
// list, so archive, snooze and delete fold the row instead of snapping it
// away. A row that comes back within the window (undo) simply stops leaving.

import type { Thread } from "@monday/shared";
import { useEffect, useMemo, useRef, useState } from "react";

export interface DisplayRow {
  thread: Thread;
  leaving: boolean;
}

/** True when the user asked for less motion; then rows leave at once. */
export function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useLeavingRows(threads: readonly Thread[], ms: number): DisplayRow[] {
  const prev = useRef<readonly Thread[]>(threads);
  const [leaving, setLeaving] = useState<Map<string, { thread: Thread; index: number }>>(
    () => new Map(),
  );
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const before = prev.current;
    prev.current = threads;
    if (ms <= 0 || before === threads) return;
    const now = new Set(threads.map((t) => t.id));
    const gone = before.map((t, index) => ({ t, index })).filter(({ t }) => !now.has(t.id));
    if (gone.length === 0 && leaving.size === 0) return;
    setLeaving((map) => {
      const next = new Map(map);
      for (const id of next.keys()) if (now.has(id)) next.delete(id);
      for (const { t, index } of gone) next.set(t.id, { thread: t, index });
      return next;
    });
    for (const { t } of gone) {
      const old = timers.current.get(t.id);
      if (old) clearTimeout(old);
      timers.current.set(
        t.id,
        setTimeout(() => {
          timers.current.delete(t.id);
          setLeaving((map) => {
            if (!map.has(t.id)) return map;
            const next = new Map(map);
            next.delete(t.id);
            return next;
          });
        }, ms),
      );
    }
  }, [threads, ms, leaving.size]);

  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const t of active.values()) clearTimeout(t);
      active.clear();
    };
  }, []);

  return useMemo(() => {
    const rows: DisplayRow[] = threads.map((thread) => ({ thread, leaving: false }));
    const present = new Set(threads.map((t) => t.id));
    const ghosts = [...leaving.values()]
      .filter((g) => !present.has(g.thread.id))
      .sort((a, b) => a.index - b.index);
    for (const g of ghosts) {
      rows.splice(Math.min(g.index, rows.length), 0, { thread: g.thread, leaving: true });
    }
    return rows;
  }, [threads, leaving]);
}
