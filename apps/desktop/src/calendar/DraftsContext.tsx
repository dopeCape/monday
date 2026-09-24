// The calendar drafts seam as React context: the App owns the DraftStore,
// the one dialog that asks before a draft's guests are emailed, and "show
// on the Calendar"; the composer's draft card and the Calendar's draft bar
// both reach them here. Absent (a test, a host without a calendar), the
// card shows its summary without buttons.

import type { CalendarDraft, Person, Settings } from "@monday/shared";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
} from "react";
import { ChoiceDialog } from "../screens/calendar/overlay.tsx";
import type { ApplyResult, DraftEntry, DraftStore } from "./drafts.ts";

export interface CalendarDrafts {
  store: DraftStore;
  /** Asks once before the listed guests are emailed; true to go on. */
  confirmGuests(guests: readonly Person[]): Promise<boolean>;
  /** Opens the Calendar on a draft and overlays it. */
  show(draft: CalendarDraft): void;
  /** Applies a draft (all of it, or some changes) with the ask and says what happened. */
  apply(draftId: string, changeIds?: readonly string[]): Promise<ApplyResult>;
}

const Context = createContext<CalendarDrafts | null>(null);

export function useCalendarDrafts(): CalendarDrafts | null {
  return useContext(Context);
}

const noSubscribe = () => () => {};
const NO_ENTRIES: readonly DraftEntry[] = [];
const noEntries = (): readonly DraftEntry[] => NO_ENTRIES;
const noActive = (): string | null => null;

/** The drafts and the active one, re-rendering on change; empty without a provider. */
export function useDraftEntries(): { entries: readonly DraftEntry[]; active: string | null } {
  const drafts = useCalendarDrafts();
  const store = drafts?.store;
  const entries = useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.list ?? noEntries,
    store?.list ?? noEntries,
  );
  const active = useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.active ?? noActive,
    store?.active ?? noActive,
  );
  return { entries, active };
}

const fill = (t: string, vars: Record<string, string | number>) =>
  t.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

export function CalendarDraftsProvider({
  store,
  settings,
  onShow,
  children,
}: {
  store: DraftStore;
  settings: Settings;
  onShow: (draft: CalendarDraft) => void;
  children: ReactNode;
}) {
  const [asking, setAsking] = useState<{
    guests: readonly Person[];
    resolve: (ok: boolean) => void;
  } | null>(null);
  const confirmGuests = useCallback(
    (guests: readonly Person[]) =>
      new Promise<boolean>((resolve) => setAsking({ guests, resolve })),
    [],
  );
  const value: CalendarDrafts = {
    store,
    confirmGuests,
    show: onShow,
    apply: (id, ids) => store.apply(id, confirmGuests, ids),
  };
  const s = settings;
  const names = asking?.guests.map((p) => p.name || p.email) ?? [];
  return (
    <Context.Provider value={value}>
      {children}
      {asking ? (
        <ChoiceDialog<"ok">
          title={s["strings.calendar.draft.send_title"]}
          body={fill(s["strings.calendar.send.body"], {
            guests:
              names.slice(0, 3).join(", ") +
              (names.length > 3
                ? fill(s["strings.calendar.send.more"], { n: names.length - 3 })
                : ""),
            n: names.length,
          })}
          confirm={s["strings.calendar.send.confirm"]}
          cancel={s["strings.calendar.form.cancel"]}
          onAnswer={(v) => {
            asking.resolve(v === "ok");
            setAsking(null);
          }}
        />
      ) : null}
    </Context.Provider>
  );
}
