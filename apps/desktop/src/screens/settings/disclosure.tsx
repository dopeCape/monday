// The Settings disclosures (docs/spec/settings.md, "Disclosure"): "More" in
// place, a group folded to its heading, the providers folded into one row, the
// page's Advanced. Each is a button with aria-expanded over a region that is
// only rendered while open, so a folded page stays light. Their state is kept
// per section for the session: a module-level map survives leaving Settings
// and coming back, and "Show in section" or the page index open the ones a
// target sits in. The body eases in with the motion tokens, which
// `appearance.transitions` turns to zero.

import { CaretRightIcon } from "@phosphor-icons/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useMemo,
  useState,
} from "react";

/** The session's disclosure state, by id. */
const session = new Map<string, boolean>();

/** Forgets every disclosure's state; tests start each case fresh. */
export function resetDisclosures() {
  session.clear();
}

export interface DisclosureStore {
  /** Bumps on every change, so a reader re-renders. */
  version: number;
  isOpen(id: string, byDefault: boolean): boolean;
  set(id: string, open: boolean): void;
  /** Opens several at once: the path to a card "Show in section" jumps to. */
  open(ids: readonly string[]): void;
}

const Store = createContext<DisclosureStore | null>(null);

/**
 * The page's store over the session map. A version bump re-renders every
 * disclosure; the map itself outlives the page. Settings owns it so its
 * navigation can open the disclosures a target sits in.
 */
export function useSessionDisclosures(): DisclosureStore {
  const [version, setVersion] = useState(0);
  const set = useCallback((id: string, open: boolean) => {
    session.set(id, open);
    setVersion((v) => v + 1);
  }, []);
  const open = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return;
    for (const id of ids) session.set(id, true);
    setVersion((v) => v + 1);
  }, []);
  return useMemo<DisclosureStore>(
    () => ({
      version,
      isOpen: (id, byDefault) => session.get(id) ?? byDefault,
      set,
      open,
    }),
    [set, open, version],
  );
}

export function DisclosureProvider({
  store,
  children,
}: {
  store: DisclosureStore;
  children: ReactNode;
}) {
  return <Store.Provider value={store}>{children}</Store.Provider>;
}

/** A local store for a disclosure outside the Settings page (a search result's card). */
const fallback: DisclosureStore = {
  version: 0,
  isOpen: (id, byDefault) => session.get(id) ?? byDefault,
  set: (id, open) => {
    session.set(id, open);
  },
  open: (ids) => {
    for (const id of ids) session.set(id, true);
  },
};

export function useDisclosureStore(): DisclosureStore {
  return useContext(Store) ?? fallback;
}

/** One disclosure's open state and its toggle, remembered by id. */
export function useDisclosure(id: string, byDefault = false): [boolean, (open: boolean) => void] {
  const store = useDisclosureStore();
  // Outside a provider nothing re-renders on a store change; this does.
  const [, force] = useState(0);
  const set = useCallback(
    (next: boolean) => {
      store.set(id, next);
      force((v) => v + 1);
    },
    [id, store],
  );
  return [store.isOpen(id, byDefault), set];
}

export interface DisclosureProps {
  id: string;
  byDefault?: boolean | undefined;
  /** The button's content: a label, a count, a summary line. */
  summary: ReactNode;
  /** Extra class on the wrapper: "more", "fold", "group-toggle", "section-advanced". */
  className?: string | undefined;
  children: ReactNode;
  /** data-* attributes for the wrapper (the coverage test walks data-disclosure). */
  attrs?: Record<string, string | undefined> | undefined;
  /** The button is a group's heading: wrapped in an h3 so the outline stays. */
  heading?: boolean | undefined;
}

/**
 * A button that opens a region in place. The region renders only while open
 * and eases in; focus stays on the button, as the disclosure pattern expects,
 * and Escape inside the region closes it and returns focus to the button.
 */
export function Disclosure({
  id,
  byDefault = false,
  summary,
  className,
  children,
  attrs,
  heading,
}: DisclosureProps) {
  const [open, setOpen] = useDisclosure(id, byDefault);
  const region = useId();
  const button = (
    <button
      type="button"
      className="disclosure-toggle"
      aria-expanded={open}
      aria-controls={open ? region : undefined}
      data-disclosure={id}
      onClick={() => setOpen(!open)}
    >
      <CaretRightIcon className="disclosure-caret" aria-hidden="true" />
      <span className="disclosure-summary">{summary}</span>
    </button>
  );
  return (
    <div
      className={`disclosure ${className ?? ""} ${open ? "open" : ""}`}
      data-disclosure-id={id}
      {...(attrs ?? {})}
    >
      {heading ? <h3 className="disclosure-heading">{button}</h3> : button}
      {open ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the region it is inside
        <div
          id={region}
          className="disclosure-body"
          onKeyDown={(e) => {
            if (e.key !== "Escape" || e.defaultPrevented) return;
            const target = e.target as HTMLElement;
            if (target.closest("input, textarea, select")) return;
            e.preventDefault();
            setOpen(false);
            document.querySelector<HTMLElement>(`[data-disclosure="${CSS.escape(id)}"]`)?.focus();
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
