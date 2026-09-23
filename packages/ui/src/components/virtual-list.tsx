// A scroller that renders only the items near its view, plus an overscan on
// each side, so a list of thousands of Threads scrolls like a list of thirty.
// Heights are measured, never assumed: every rendered item is measured after
// layout and remembered by key, items not yet rendered are estimated from
// the average of their kind (a row, a Section heading), and before the first
// measurement from the density's --row-h token. Where there is no layout at
// all (a DOM without CSS, as in render tests) every item renders.
//
// The render callback must return exactly one element per item; the list
// finds them by position after its start marker. A change of `focusKey`
// scrolls that item into view (with the heading right above it, when
// `revealWithPrevious` says so), and a change of `scrollKey` puts the scroll
// position back where it was the last time that key was shown.

import {
  type ReactNode,
  type UIEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cx } from "../format.ts";
import { offsetsOf, scrollToReveal, type VirtualWindow, windowOf } from "../virtual.ts";

export interface VirtualItem {
  key: string;
  /** Items of one kind share a height estimate until measured; absent, all items are one kind. */
  kind?: string | undefined;
}

export interface VirtualListProps<T extends VirtualItem> {
  items: readonly T[];
  /** One element per item. */
  render: (item: T) => ReactNode;
  /** Items rendered above and below the view (the inbox.overscan_rows Setting). */
  overscan: number;
  /** The item to keep in view; each change scrolls it in when it is out. */
  focusKey?: string | null | undefined;
  /** Whether revealing an item also reveals the one before it (its Section heading). */
  revealWithPrevious?: ((previous: T) => boolean) | undefined;
  /** The list being shown; each change restores the scroll position that key last had. */
  scrollKey?: string | undefined;
  /** What changes every height at once (density, list layout): a change forgets the measurements. */
  layoutKey?: string | undefined;
  /** Content above the items, inside the scroller. */
  before?: ReactNode;
  className?: string | undefined;
  role?: string | undefined;
  "aria-label"?: string | undefined;
}

interface View {
  top: number;
  height: number;
  listTop: number;
}

/** The density's row height from the tokens; 0 where no stylesheet is loaded. */
function rowToken(): number {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--row-h");
  const px = Number.parseFloat(raw);
  return Number.isFinite(px) && px > 0 ? px : 0;
}

/** Used when the overscan Setting is missing or invalid. */
const DEFAULT_OVERSCAN = 10;

export function VirtualList<T extends VirtualItem>({
  items,
  render,
  overscan: overscanProp,
  focusKey,
  revealWithPrevious,
  scrollKey = "",
  layoutKey = "",
  before,
  className,
  role,
  "aria-label": ariaLabel,
}: VirtualListProps<T>) {
  // A missing or non-finite overscan (a Setting not yet loaded) must never blank the list.
  const overscan =
    Number.isFinite(overscanProp) && overscanProp >= 0
      ? Math.floor(overscanProp)
      : DEFAULT_OVERSCAN;
  const scroller = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLDivElement>(null);
  const sizes = useRef(new Map<string, number>());
  const stats = useRef(new Map<string, { sum: number; count: number }>());
  const [view, setView] = useState<View | null>(null);
  const [noLayout, setNoLayout] = useState(false);
  const [, setMeasured] = useState(0);

  const measuredFor = useRef(layoutKey);
  if (measuredFor.current !== layoutKey) {
    measuredFor.current = layoutKey;
    sizes.current.clear();
    stats.current.clear();
  }

  const estimate = (kind = ""): number => {
    const own = stats.current.get(kind);
    if (own?.count) return own.sum / own.count;
    let sum = 0;
    let count = 0;
    for (const s of stats.current.values()) {
      sum += s.sum;
      count += s.count;
    }
    if (count) return sum / count;
    return rowToken() || 1;
  };
  const offsetsNow = () =>
    offsetsOf(items.map((it) => sizes.current.get(it.key) ?? estimate(it.kind)));
  const offsets = offsetsNow();
  const n = items.length;
  let win: VirtualWindow;
  if (noLayout) win = { start: 0, end: n, before: 0, after: 0 };
  else if (!view) {
    // Before the first layout: the top of the list, until the view is known.
    const end = Math.min(n, overscan * 2 + 1);
    win = { start: 0, end, before: 0, after: (offsets[n] ?? 0) - (offsets[end] ?? 0) };
  } else win = windowOf(offsets, view.top - view.listTop, view.height, overscan);

  // The latest arithmetic, for the scroll handler between renders.
  const latest = useRef({ offsets, win, overscan });
  latest.current = { offsets, win, overscan };

  const savedScroll = useRef(new Map<string, number>());
  const shownKey = useRef(scrollKey);

  /** Reads the view; re-renders only when the rendered window would change. */
  const sync = useCallback((force = false) => {
    const el = scroller.current;
    if (!el) return;
    const height = el.clientHeight;
    if (height === 0) return;
    savedScroll.current.set(shownKey.current, el.scrollTop);
    const listTop = mark.current?.offsetTop ?? 0;
    const { offsets: o, win: w, overscan: over } = latest.current;
    const next = windowOf(o, el.scrollTop - listTop, height, over);
    setView((v) => {
      if (
        !force &&
        v &&
        v.height === height &&
        v.listTop === listTop &&
        next.start === w.start &&
        next.end === w.end
      ) {
        return v;
      }
      return { top: el.scrollTop, height, listTop };
    });
  }, []);

  // After every render: measure what rendered, and learn the view once.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const height = el.clientHeight;
    if (height === 0) {
      if (!noLayout) setNoLayout(true);
      return;
    }
    if (noLayout) setNoLayout(false);
    let changed = false;
    let node = mark.current?.nextElementSibling ?? null;
    for (let i = win.start; node && i < win.end; node = node.nextElementSibling) {
      if (node.classList.contains("vpad")) continue;
      const item = items[i++];
      const h = (node as HTMLElement).offsetHeight;
      if (!item || h <= 0 || node.classList.contains("leaving")) continue;
      const old = sizes.current.get(item.key);
      if (old === h) continue;
      const s = stats.current.get(item.kind ?? "") ?? { sum: 0, count: 0 };
      if (old === undefined) s.count++;
      else s.sum -= old;
      s.sum += h;
      stats.current.set(item.kind ?? "", s);
      sizes.current.set(item.key, h);
      changed = true;
    }
    const listTop = mark.current?.offsetTop ?? 0;
    if (!view || view.height !== height || view.listTop !== listTop) {
      setView({ top: el.scrollTop, height, listTop });
    } else if (changed) setMeasured((m) => m + 1);
    if (pendingReveal.current) revealStep();
  });

  // A different list: remember where the last one was, go back to where this one was.
  useLayoutEffect(() => {
    if (shownKey.current === scrollKey) return;
    shownKey.current = scrollKey;
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = savedScroll.current.get(scrollKey) ?? 0;
    sync(true);
  }, [scrollKey, sync]);

  // The focus moved: bring it into view, with its heading when it opens a Section.
  // Items far away are only estimated, so the reveal repeats after each
  // measurement until the focused item's own height is known.
  const focusIndex = focusKey ? items.findIndex((it) => it.key === focusKey) : -1;
  const revealFrom =
    focusIndex > 0 && revealWithPrevious?.(items[focusIndex - 1] as T)
      ? focusIndex - 1
      : focusIndex;
  const pendingReveal = useRef(false);
  const revealStep = () => {
    const el = scroller.current;
    const at = focusIndex;
    const from = revealFrom;
    if (!el || at < 0 || el.clientHeight === 0) {
      pendingReveal.current = false;
      return;
    }
    const o = offsetsNow();
    const listTop = mark.current?.offsetTop ?? 0;
    const next = scrollToReveal(
      el.scrollTop,
      el.clientHeight,
      listTop + (o[from] ?? 0),
      listTop + (o[at + 1] ?? 0),
    );
    const known = (i: number) => sizes.current.has(items[i]?.key ?? "");
    if (known(at) && known(from)) pendingReveal.current = false;
    if (next !== el.scrollTop) {
      el.scrollTop = next;
      sync(true);
    }
  };
  const revealRef = useRef(revealStep);
  revealRef.current = revealStep;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the focused key changes, reading the latest layout
  useLayoutEffect(() => {
    pendingReveal.current = true;
    revealRef.current();
  }, [focusKey]);

  // A resized scroller shows more or fewer items.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => sync());
    ro.observe(el);
    return () => ro.disconnect();
  }, [sync]);

  const onScroll = (_e: UIEvent<HTMLDivElement>) => sync();

  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the caller gives the role (a listbox) with its label
    <div
      ref={scroller}
      className={cx("col-body", "vlist", className)}
      role={role}
      aria-label={ariaLabel}
      onScroll={onScroll}
    >
      {before}
      <div ref={mark} className="vstart" aria-hidden="true" />
      {win.before > 0 ? (
        <div className="vpad" aria-hidden="true" style={{ height: win.before }} />
      ) : null}
      {items.slice(win.start, win.end).map(render)}
      {win.after > 0 ? (
        <div className="vpad" aria-hidden="true" style={{ height: win.after }} />
      ) : null}
    </div>
  );
}
