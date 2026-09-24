// The Calendar screen (issue 15; docs/spec/calendar.md): Day, Week, Month
// and Agenda over every Account's calendars, with the mini month, today,
// the invites waiting for an answer and the calendar list beside them.
// Click or drag on the grid to make an Event, drag one to move it, drag its
// bottom edge to resize it; a click opens its detail with Join, the answer
// and edit, duplicate and delete. A recurring Event asks which instances a
// change reaches; one with guests asks before they are emailed (ADR 0002).
// Keys come from the keymap (t, j/k, d/w/m/a, c, mod+f), search looks
// through the Events held, and the palette jumps to a typed date. An
// Account whose calendar cannot be read says why and how to fix it.
// Recurring masters are expanded on the client. Every string and behavior
// is a Setting (strings.calendar.*, calendar.*).

import type {
  CalendarEvent,
  Calendar as CalendarRow,
  CalendarStatus,
  EventPatch,
  RecurrenceScope,
  Settings,
} from "@monday/shared";
import { AgentBar, AgentDock, Btn, ColHead, formatMonth, Icon, Seg, Toast, Vr } from "@monday/ui";
import {
  CalendarBlankIcon,
  CaretLeftIcon,
  CaretRightIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  SidebarSimpleIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { chordLabel, type KeyAction } from "../keyboard/keymaps.ts";
import { type KeyContext, type KeyHandlers, useKeymap } from "../keyboard/useKeymap.ts";
import { openExternal } from "../platform/open.ts";
import { useShell } from "../shell/Shell.tsx";
import { useWorkspace } from "../workspace.tsx";
import { Agenda, CalendarEmpty } from "./calendar/Agenda.tsx";
import {
  aimAt,
  type CalendarSource,
  isRecurring,
  type Occurrence,
  occurrencesIn,
} from "./calendar/calendar-data.ts";
import {
  addDays,
  addMonths,
  allDayDate,
  allDayIso,
  DAY_MS,
  dayKey,
  daysBetween,
  fromDayKey,
  isoWeek,
  nextSlot,
  sameDay,
  startOfDay,
  startOfWeek,
  WEEKDAY_KEYS,
} from "./calendar/dates.ts";
import { type Draft, draftForSlot, draftOf, inputOf, patchOf } from "./calendar/draft.ts";
import { EventDetail } from "./calendar/EventDetail.tsx";
import { EventEditor, QuickCreate } from "./calendar/EventForm.tsx";
import { calendarColors, eventsOnDay, monthWeeks, searchOccurrences } from "./calendar/layout.ts";
import { MonthGrid } from "./calendar/MonthGrid.tsx";
import { canAnswer, canEdit, errorText, guestsOf, isOwn } from "./calendar/model.ts";
import { type AnchorRect, type Ask, AskDialog, Popover, rectOf } from "./calendar/overlay.tsx";
import { Sidebar } from "./calendar/Sidebar.tsx";
import { StatusBanner } from "./calendar/StatusBanner.tsx";
import { type Slot, TimeGrid } from "./calendar/TimeGrid.tsx";
import { useExit } from "./inbox/useExit.ts";
import { Palette, type PaletteCommand } from "./Palette.tsx";

export { answerLabel, TodayPanel, type TodayPanelProps } from "./calendar/TodayPanel.tsx";

export type CalendarView = "day" | "week" | "month" | "agenda";

export interface CalendarProps {
  source: CalendarSource;
  /** Opens a meeting link; the system browser by default. */
  onOpenLink?: ((href: string) => void) | undefined;
  /** Hands "Set up a call with ..." to the composer. */
  onAsk?: ((text: string) => void) | undefined;
  onNavigate?: ((target: string) => void) | undefined;
  /** A fixed clock (tests); absent, the screen keeps its own that ticks. */
  now?: Date | undefined;
  initialView?: CalendarView | undefined;
  /** A day to open on ("2026-10-03"), bumped by `n` each time it is asked for. */
  jumpTo?: { day: string; n: number } | undefined;
  /**
   * The bottom agent the App owns, so asking here opens it here without
   * leaving the page; absent, a bar that hands off to the Inbox's.
   */
  agent?: ReactNode | undefined;
}

type Pop =
  | { kind: "detail"; key: string; rect: AnchorRect }
  | { kind: "create"; rect: AnchorRect; slot: Slot };

interface EditorState {
  draft: Draft;
  /** The Draft as the Event was, when editing; null when making one. */
  original: Draft | null;
  occ: Occurrence | null;
}

interface ToastState {
  id: number;
  text: string;
  undo?: (() => void) | undefined;
}

const fill = (t: string, vars: Record<string, string | number>) =>
  t.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

/** The clock the views draw now by: a fixed one, or one that ticks every half minute. */
function useClock(fixed: Date | undefined): Date {
  const [tick, setTick] = useState(() => new Date());
  useEffect(() => {
    if (fixed) return;
    const t = setInterval(() => setTick(new Date()), 30_000);
    return () => clearInterval(t);
  }, [fixed]);
  return fixed ?? tick;
}

const LONG_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function Calendar({
  source,
  onAsk,
  onNavigate,
  onOpenLink,
  now: nowProp,
  initialView,
  jumpTo,
  agent,
}: CalendarProps) {
  const shell = useShell();
  const workspace = useWorkspace();
  const open = onOpenLink ?? ((href: string) => void openExternal(href));
  const s: Settings = shell.settings;
  // Just mail (CONTEXT.md "AI level"): no agent bar and no Schedule handoff; the calendar stays.
  const aiOff = s["ai.level"] === "off";
  const now = useClock(nowProp);
  const calendars = useSyncExternalStore(source.subscribe, source.calendars, source.calendars);
  const events = useSyncExternalStore(source.subscribe, source.events, source.events);
  const accounts = useSyncExternalStore(source.subscribe, source.accounts, source.accounts);
  const [view, setView] = useState<CalendarView>(initialView ?? s["calendar.default_view"]);
  const [anchor, setAnchor] = useState<Date>(() => startOfDay(nowProp ?? new Date()));
  const [pop, setPop] = useState<Pop | null>(null);
  const [quick, setQuick] = useState<Draft | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /** The last failed write from a view, in plain words; cleared by the next one. */
  const [lineError, setLineError] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastSeq = useRef(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchInput = useRef<HTMLInputElement | null>(null);
  const newButton = useRef<HTMLSpanElement | null>(null);
  const [statuses, setStatuses] = useState<CalendarStatus[] | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const paletteExit = useExit(paletteOpen);
  /** Moves shown at once while the write is on its way: occurrence key to its new times. */
  const [moved, setMoved] = useState<ReadonlyMap<string, { start: string; end: string }>>(
    () => new Map(),
  );
  const mondayFirst = s["calendar.week_starts_monday"];
  const showDeclined = s["calendar.show_declined"];
  const sidebar = s["calendar.sidebar"];

  // A day the palette asked for.
  const jumped = useRef(0);
  useEffect(() => {
    if (!jumpTo || jumpTo.n === jumped.current) return;
    jumped.current = jumpTo.n;
    const day = fromDayKey(jumpTo.day);
    if (day) setAnchor(day);
  }, [jumpTo]);

  // The Events changed under the moves: the Cache has caught up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: cleared whenever the Events change
  useEffect(() => {
    setMoved((m) => (m.size ? new Map() : m));
  }, [events]);

  // Whether each Account's calendar can be read; asked on open.
  useEffect(() => {
    let live = true;
    source
      .status()
      .then((list) => {
        if (live) setStatuses(list);
      })
      .catch(() => {
        if (live) setStatuses([]);
      });
    return () => {
      live = false;
    };
  }, [source]);

  const byId = useMemo(() => new Map(calendars.map((c) => [c.id, c])), [calendars]);
  const colors = useMemo(
    () => calendarColors(calendars, s["calendar.colors"]),
    [calendars, s["calendar.colors"]],
  );
  const addressOf = useCallback(
    (workspaceId: string) =>
      accounts.find((a) => a.workspaceId === workspaceId)?.address ?? workspace.address,
    [accounts, workspace.address],
  );
  const addressKnown = useCallback(
    (workspaceId: string) => accounts.find((a) => a.workspaceId === workspaceId)?.address ?? null,
    [accounts],
  );

  /* ------------------------------ The window on screen ------------------------------ */

  const workDays = s["calendar.work_days"];
  const days = useMemo(() => {
    if (view === "day") return [anchor];
    if (view !== "week") return [];
    const from = startOfWeek(anchor, mondayFirst);
    const all = Array.from({ length: 7 }, (_, i) => addDays(from, i));
    if (s["calendar.show_weekends"]) return all;
    const working = all.filter((d) => workDays.includes(WEEKDAY_KEYS[d.getDay()] ?? "sun"));
    return working.length ? working : all;
  }, [view, anchor, mondayFirst, s["calendar.show_weekends"], workDays]);
  const weeks = useMemo(
    () => (view === "month" ? monthWeeks(anchor, mondayFirst) : []),
    [view, anchor, mondayFirst],
  );
  const range = useMemo(() => {
    if (view === "day" || view === "week") {
      const first = days[0] ?? anchor;
      const last = days[days.length - 1] ?? anchor;
      return { from: startOfDay(first), to: addDays(startOfDay(last), 1) };
    }
    if (view === "month") {
      const first = weeks[0]?.[0] ?? anchor;
      const lastWeek = weeks[weeks.length - 1];
      const last = lastWeek?.[lastWeek.length - 1] ?? anchor;
      return { from: first, to: addDays(last, 1) };
    }
    return { from: anchor, to: addDays(anchor, s["calendar.agenda_days"]) };
  }, [view, days, weeks, anchor, s["calendar.agenda_days"]]);

  useEffect(() => {
    source.cover(range.from, range.to);
  }, [source, range]);

  // A day either side, so an all-day Event in UTC lands whatever the Device's offset.
  const items = useMemo(() => {
    const list = occurrencesIn(
      events,
      calendars,
      { from: addDays(range.from, -1), to: addDays(range.to, 1) },
      { showDeclined },
    );
    if (moved.size === 0) return list;
    return list.map((o) => {
      const m = moved.get(o.key);
      return m ? { ...o, ...m } : o;
    });
  }, [events, calendars, range, showDeclined, moved]);

  const todays = useMemo(
    () =>
      eventsOnDay(
        occurrencesIn(
          events,
          calendars,
          { from: addDays(startOfDay(now), -1), to: addDays(startOfDay(now), 2) },
          { showDeclined },
        ),
        now,
      ),
    [events, calendars, now, showDeclined],
  );
  const waiting = useMemo(
    () =>
      occurrencesIn(events, calendars, {
        from: now,
        to: new Date(now.getTime() + s["calendar.window_future_days"] * DAY_MS),
      })
        .filter((o) => o.response === "needs-action" && canAnswer(o, addressKnown))
        .slice(0, 5),
    [events, calendars, now, s["calendar.window_future_days"], addressKnown],
  );
  const busyDays = useMemo(() => {
    const out = new Set<string>();
    const from = addDays(startOfDay(anchor), -45);
    for (const o of occurrencesIn(events, calendars, { from, to: addDays(from, 90) })) {
      out.add(dayKey(o.allDay ? allDayDate(o.start) : new Date(o.start)));
    }
    return out;
  }, [events, calendars, anchor]);

  const searching = searchOpen && query.trim() !== "";
  const found = useMemo(() => {
    if (!searching) return [];
    const from = new Date(now.getTime() - s["calendar.window_past_days"] * DAY_MS);
    const to = new Date(now.getTime() + s["calendar.window_future_days"] * DAY_MS);
    return searchOccurrences(
      occurrencesIn(events, calendars, { from, to }, { showDeclined }),
      query,
    );
  }, [searching, query, events, calendars, now, showDeclined, s]);

  /* ------------------------------ Moving through time ------------------------------ */

  const step = useCallback(
    (n: number) => {
      setPop(null);
      setAnchor((a) => {
        if (view === "day") return addDays(a, n);
        if (view === "week") return addDays(a, 7 * n);
        if (view === "month") return addMonths(new Date(a.getFullYear(), a.getMonth(), 1), n);
        return addDays(a, s["calendar.agenda_days"] * n);
      });
    },
    [view, s],
  );
  const goToday = () => {
    setPop(null);
    setAnchor(startOfDay(now));
  };
  const pickDay = (day: Date) => {
    setPop(null);
    setAnchor(startOfDay(day));
    setView("day");
  };

  const heading = (() => {
    if (view === "day")
      return `${LONG_DAYS[anchor.getDay()]} ${anchor.getDate()} ${formatMonth(anchor)}`;
    if (view === "month") return formatMonth(anchor);
    const first = range.from;
    const last = addDays(range.to, -1);
    const months =
      first.getMonth() === last.getMonth()
        ? formatMonth(first)
        : first.getFullYear() === last.getFullYear()
          ? `${formatMonth(first).split(" ")[0]} ${s["strings.calendar.to"]} ${formatMonth(last)}`
          : `${formatMonth(first)} ${s["strings.calendar.to"]} ${formatMonth(last)}`;
    return view === "week" && s["calendar.week_numbers"]
      ? `${months} · ${fill(s["strings.calendar.week_short"], { n: isoWeek(first) })}`
      : months;
  })();

  /* ------------------------------ Asking first ------------------------------ */

  const askScope = (action: "edit" | "delete") =>
    new Promise<RecurrenceScope | null>((resolve) => setAsk({ kind: "scope", action, resolve }));
  const askSend = (action: "invite" | "update" | "cancel", guests: readonly string[]) =>
    new Promise<boolean>((resolve) => setAsk({ kind: "send", action, guests, resolve }));
  const names = (people: ReadonlyArray<{ name: string; email: string }>) =>
    people.map((p) => p.name || p.email);

  const showToast = (text: string, undo?: () => void) => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, text, undo });
  };
  const failed = (template: string, error: unknown) =>
    setLineError(fill(template, { message: errorText(error) }));

  /* ------------------------------ Writes ------------------------------ */

  const defaultCalendar = (): string | null => {
    const writable = calendars.filter((c) => c.writable);
    const own = writable.filter((c) => c.workspaceId === workspace.id);
    return (
      (own.find((c) => c.primary) ?? own[0] ?? writable.find((c) => c.primary) ?? writable[0])
        ?.id ?? null
    );
  };

  const startCreate = (slot: Slot, rect: AnchorRect) => {
    setFormError(null);
    setQuick(draftForSlot(slot, defaultCalendar()));
    setPop({ kind: "create", rect, slot });
  };

  const newEvent = () => {
    const start =
      sameDay(anchor, now) || view === "month" || view === "agenda"
        ? nextSlot(now, s["calendar.snap_minutes"])
        : new Date(
            anchor.getFullYear(),
            anchor.getMonth(),
            anchor.getDate(),
            s["calendar.day_start_hour"],
          );
    const slot = {
      start,
      end: new Date(start.getTime() + s["calendar.default_duration_minutes"] * 60_000),
      allDay: false,
    };
    const rect = rectOf(newButton.current) ?? { left: 200, top: 80, width: 0, height: 0 };
    startCreate(slot, rect);
  };

  const create = async (draft: Draft): Promise<boolean> => {
    const input = inputOf(draft);
    if (!input) return false;
    const guests = draft.attendees;
    if (guests.length > 0 && !(await askSend("invite", names(guests)))) return false;
    setBusy(true);
    setFormError(null);
    try {
      await source.create(input);
      showToast(s["strings.calendar.toast.added"]);
      return true;
    } catch (error) {
      setFormError(fill(s["strings.calendar.form.failed"], { message: errorText(error) }));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const update = async (
    o: Occurrence,
    patch: EventPatch,
    opts: { guestsAfter?: ReadonlyArray<{ name: string; email: string }>; undoable?: boolean } = {},
  ): Promise<boolean> => {
    if (Object.keys(patch).length === 0) return true;
    let scope: RecurrenceScope | undefined;
    if (isRecurring(o)) {
      const answer = await askScope("edit");
      if (!answer) return false;
      scope = answer;
    }
    const before = guestsOf(o, addressOf);
    const after = opts.guestsAfter ?? before;
    const everyone = [
      ...new Map([...before, ...after].map((p) => [p.email.toLowerCase(), p])).values(),
    ];
    if (isOwn(o, addressOf) && everyone.length > 0 && !(await askSend("update", names(everyone)))) {
      return false;
    }
    const times = patch.start !== undefined || patch.end !== undefined;
    if (times && (!scope || scope === "this")) {
      setMoved((m) =>
        new Map(m).set(o.key, { start: patch.start ?? o.start, end: patch.end ?? o.end }),
      );
    }
    setLineError(null);
    try {
      await source.update(o.id, patch, aimAt(o, scope));
      const back: EventPatch = { start: o.start, end: o.end };
      showToast(
        s["strings.calendar.toast.updated"],
        opts.undoable && everyone.length === 0 && !scope
          ? () => {
              setToast(null);
              void source
                .update(o.id, back, aimAt(o, scope))
                .catch((e) => failed(s["strings.calendar.update_failed"], e));
            }
          : undefined,
      );
      return true;
    } catch (error) {
      setMoved((m) => {
        const next = new Map(m);
        next.delete(o.key);
        return next;
      });
      failed(s["strings.calendar.update_failed"], error);
      setFormError(fill(s["strings.calendar.update_failed"], { message: errorText(error) }));
      return false;
    }
  };

  const moveTo = (o: Occurrence, start: Date, end: Date) => {
    if (o.allDay) {
      const delta = Math.round((start.getTime() - Date.parse(o.start)) / DAY_MS);
      const from = addDays(allDayDate(o.start), delta);
      const length = Math.max(1, daysBetween(allDayDate(o.start), allDayDate(o.end)));
      void update(
        o,
        { start: allDayIso(from), end: allDayIso(addDays(from, length)) },
        { undoable: true },
      );
      return;
    }
    void update(o, { start: start.toISOString(), end: end.toISOString() }, { undoable: true });
  };

  const moveDays = (o: Occurrence, n: number) => {
    if (o.allDay) {
      const from = addDays(allDayDate(o.start), n);
      const length = Math.max(1, daysBetween(allDayDate(o.start), allDayDate(o.end)));
      void update(
        o,
        { start: allDayIso(from), end: allDayIso(addDays(from, length)) },
        { undoable: true },
      );
      return;
    }
    const start = addDays(new Date(o.start), n);
    const end = addDays(new Date(o.end), n);
    void update(o, { start: start.toISOString(), end: end.toISOString() }, { undoable: true });
  };

  const remove = async (o: Occurrence): Promise<boolean> => {
    let scope: RecurrenceScope | undefined;
    if (isRecurring(o)) {
      const answer = await askScope("delete");
      if (!answer) return false;
      scope = answer;
    }
    const guests = guestsOf(o, addressOf);
    if (isOwn(o, addressOf) && guests.length > 0 && !(await askSend("cancel", names(guests)))) {
      return false;
    }
    setLineError(null);
    try {
      await source.remove(o.id, aimAt(o, scope));
      showToast(s["strings.calendar.toast.deleted"]);
      return true;
    } catch (error) {
      failed(s["strings.calendar.delete_failed"], error);
      return false;
    }
  };

  const respond = (o: Occurrence, response: "accepted" | "tentative" | "declined") => {
    setLineError(null);
    source
      .respond(o.id, response)
      .catch((err: unknown) => failed(s["strings.calendar.answer_failed"], err));
  };

  const saveQuick = async () => {
    if (!quick) return;
    if (await create(quick)) {
      setQuick(null);
      setPop(null);
    }
  };

  const saveEditor = async () => {
    if (!editor) return;
    const { draft, original, occ } = editor;
    let ok: boolean;
    if (occ && original) {
      const patch = patchOf(draft, original);
      if (!patch) return;
      ok = await update(occ, patch, { guestsAfter: draft.attendees });
    } else {
      ok = await create(draft);
    }
    if (ok) setEditor(null);
  };

  const editOcc = (o: Occurrence) => {
    setPop(null);
    setFormError(null);
    const d = draftOf(o);
    setEditor({ draft: d, original: d, occ: o });
  };
  const duplicate = (o: Occurrence) => {
    setPop(null);
    setFormError(null);
    const d = draftOf(o);
    const writable = byId.get(o.calendarId)?.writable ? o.calendarId : defaultCalendar();
    setEditor({
      draft: {
        ...d,
        title: fill(s["strings.calendar.copy_title"], { title: o.title }),
        calendarId: writable,
        recurrence: o.recurringEventId ? null : d.recurrence,
      },
      original: null,
      occ: null,
    });
  };

  /* ------------------------------ Keys ------------------------------ */

  const overlay = pop !== null || editor !== null || ask !== null || paletteOpen;
  const ctx: KeyContext = { pane: overlay ? "overlay" : "list", focus: null, selection: [] };
  const handlers: KeyHandlers = {
    "calendar.today": () => !overlay && goToday(),
    "calendar.previous": () => !overlay && step(-1),
    "calendar.next": () => !overlay && step(1),
    "calendar.view.day": () => !overlay && setView("day"),
    "calendar.view.week": () => !overlay && setView("week"),
    "calendar.view.month": () => !overlay && setView("month"),
    "calendar.view.agenda": () => !overlay && setView("agenda"),
    "calendar.new_event": () => {
      if (overlay) return false;
      newEvent();
    },
    "calendar.search": () => {
      if (editor || ask) return false;
      setPop(null);
      setSearchOpen(true);
      requestAnimationFrame(() => searchInput.current?.focus());
    },
    "sheet.close": () => {
      if (ask || editor) return false;
      if (paletteOpen) setPaletteOpen(false);
      else if (pop) setPop(null);
      else if (searchOpen) {
        setSearchOpen(false);
        setQuery("");
      } else return false;
    },
    undo: ({ typing }) => {
      if (overlay || typing || !toast?.undo) return false;
      toast.undo();
    },
    "agent.focus": () => {
      if (overlay || aiOff) return false;
      onNavigate?.("agent");
    },
    "palette.open": () => {
      if (editor || ask) return false;
      setPaletteQuery("");
      setPaletteOpen((o) => !o);
    },
  };
  const keymap = useKeymap(handlers, ctx, "calendar");
  const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

  const runCommand = (command: PaletteCommand) => {
    setPaletteOpen(false);
    switch (command.type) {
      case "action": {
        const h = handlers[command.action as keyof KeyHandlers];
        // After the palette has gone, so the overlay check lets it through.
        if (h) setTimeout(() => h({ ...ctx, pane: "list" }), 0);
        break;
      }
      case "navigate":
        if (command.target.startsWith("calendar:")) {
          const day = fromDayKey(command.target.slice("calendar:".length));
          if (day) {
            setAnchor(day);
            setSearchOpen(false);
            setQuery("");
          }
        } else if (command.target !== "calendar") onNavigate?.(command.target);
        break;
      case "open":
        onNavigate?.(`thread:${command.threadId}`);
        break;
      case "search":
        setSearchOpen(true);
        setQuery(command.text);
        break;
      case "ask":
      case "suggest":
        onAsk?.(command.text);
        break;
      case "intent":
        break;
    }
  };

  /* ------------------------------ Status ------------------------------ */

  const problems = (statuses ?? []).filter((st) => st.problem);
  const retry = async (workspaceId: string) => {
    try {
      const next = await source.retry(workspaceId);
      setStatuses((list) => (list ?? []).map((st) => (st.workspaceId === workspaceId ? next : st)));
    } catch (error) {
      failed(s["strings.calendar.retry_failed"], error);
    }
  };

  /* ------------------------------ The view ------------------------------ */

  const detail =
    pop?.kind === "detail"
      ? (items.find((o) => o.key === pop.key) ??
        found.find((o) => o.key === pop.key) ??
        todays.find((o) => o.key === pop.key) ??
        waiting.find((o) => o.key === pop.key))
      : undefined;
  const selectedKey = pop?.kind === "detail" ? pop.key : null;
  const editable = (o: Occurrence) => canEdit(o, byId, addressOf);
  const openDetail = (o: Occurrence, rect: AnchorRect) => {
    setQuick(null);
    setPop({ kind: "detail", key: o.key, rect });
  };
  const loading = statuses === null && calendars.length === 0;

  const agendaGroups = (list: readonly Occurrence[], from: Date, to: Date) => {
    const out: Array<readonly [Date, Occurrence[]]> = [];
    for (let d = startOfDay(from); d < to; d = addDays(d, 1)) {
      const on = eventsOnDay(list, d);
      if (on.length) out.push([d, on] as const);
    }
    return out;
  };

  let body: ReactNode;
  if (searching) {
    const sorted = [...found].sort((a, b) => a.start.localeCompare(b.start));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const groups =
      first && last
        ? agendaGroups(
            sorted,
            first.allDay ? allDayDate(first.start) : new Date(first.start),
            addDays(new Date(last.end), 1),
          )
        : [];
    body = (
      <Agenda
        groups={groups}
        now={now}
        s={s}
        colors={colors}
        selectedKey={selectedKey}
        addressOf={addressOf}
        onOpen={openDetail}
        onJoin={open}
        onRespond={respond}
        className="cal-results"
        empty={
          <CalendarEmpty
            title={fill(s["strings.calendar.search.none"], { query: query.trim() })}
            body={s["strings.calendar.search.none_body"]}
          />
        }
      />
    );
  } else if (view === "agenda") {
    body = (
      <Agenda
        groups={agendaGroups(items, range.from, range.to)}
        now={now}
        s={s}
        colors={colors}
        selectedKey={selectedKey}
        addressOf={addressOf}
        onOpen={openDetail}
        onJoin={open}
        onRespond={respond}
        empty={
          <CalendarEmpty
            title={s["strings.calendar.no_events"]}
            body={fill(s["strings.calendar.no_events_body"], { n: s["calendar.agenda_days"] })}
            action={
              <Btn onClick={newEvent}>
                <Icon icon={PlusIcon} /> {s["strings.calendar.new_event_long"]}
              </Btn>
            }
          />
        }
      />
    );
  } else if (view === "month") {
    body = (
      <MonthGrid
        weeks={weeks}
        month={anchor}
        items={items}
        now={now}
        s={s}
        colors={colors}
        selectedKey={selectedKey}
        ghostDay={pop?.kind === "create" && pop.slot.allDay ? pop.slot.start : null}
        editable={editable}
        onCreate={startCreate}
        onOpen={openDetail}
        onMoveDays={moveDays}
        onPickDay={pickDay}
      />
    );
  } else {
    body = (
      <TimeGrid
        days={days}
        items={items}
        now={now}
        s={s}
        colors={colors}
        selectedKey={selectedKey}
        ghost={pop?.kind === "create" ? pop.slot : null}
        addressOf={addressOf}
        editable={editable}
        onCreate={startCreate}
        onOpen={openDetail}
        onMove={moveTo}
        onPickDay={pickDay}
        scrollKey={`${view}:${days[0]?.toISOString() ?? ""}`}
      />
    );
  }

  const key = (action: KeyAction) => chordLabel(keymap[action], mac);

  return (
    <div className="main page">
      <div className={`page-wrap cal-wrap${sidebar ? "" : " no-side"}`}>
        <ColHead title={s["strings.calendar.title"]} count={heading}>
          <Vr />
          <Btn
            icon
            title={`${s["strings.calendar.previous"]} (${key("calendar.previous")})`}
            onClick={() => step(-1)}
          >
            <Icon icon={CaretLeftIcon} />
          </Btn>
          <Btn
            title={`${s["strings.calendar.today"]} (${key("calendar.today")})`}
            onClick={goToday}
          >
            {s["strings.calendar.today"]}
          </Btn>
          <Btn
            icon
            title={`${s["strings.calendar.next"]} (${key("calendar.next")})`}
            onClick={() => step(1)}
          >
            <Icon icon={CaretRightIcon} />
          </Btn>
          <span className="sp" />
          <div className={`cal-search${searchOpen ? " open" : ""}`}>
            {searchOpen ? (
              <>
                <Icon icon={MagnifyingGlassIcon} />
                <input
                  ref={searchInput}
                  value={query}
                  aria-label={s["strings.calendar.search.label"]}
                  placeholder={s["strings.calendar.search.placeholder"]}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setSearchOpen(false);
                      setQuery("");
                    }
                  }}
                />
                <Btn
                  icon
                  sm
                  title={s["strings.calendar.search.close"]}
                  onClick={() => {
                    setSearchOpen(false);
                    setQuery("");
                  }}
                >
                  <Icon icon={XIcon} />
                </Btn>
              </>
            ) : (
              <Btn
                icon
                title={`${s["strings.calendar.search.label"]} (${key("calendar.search")})`}
                onClick={() => {
                  setSearchOpen(true);
                  requestAnimationFrame(() => searchInput.current?.focus());
                }}
              >
                <Icon icon={MagnifyingGlassIcon} />
              </Btn>
            )}
          </div>
          <Seg
            value={view}
            onChange={(v) => {
              setPop(null);
              setView(v);
            }}
            options={[
              { value: "day", label: s["strings.calendar.view.day"] },
              { value: "week", label: s["strings.calendar.view.week"] },
              { value: "month", label: s["strings.calendar.view.month"] },
              { value: "agenda", label: s["strings.calendar.view.agenda"] },
            ]}
          />
          <span ref={newButton} className="cal-new">
            <Btn
              onClick={newEvent}
              title={`${s["strings.calendar.new_event_long"]} (${key("calendar.new_event")})`}
            >
              <Icon icon={PlusIcon} /> {s["strings.calendar.new_event"]}
            </Btn>
          </span>
          {onAsk && !aiOff ? (
            <Btn onClick={() => onAsk(s["strings.calendar.schedule_ask"])}>
              <Icon icon={CalendarBlankIcon} /> {s["strings.calendar.schedule"]}
            </Btn>
          ) : null}
          <Btn
            icon
            on={sidebar}
            aria-pressed={sidebar}
            title={s["strings.calendar.sidebar_toggle"]}
            onClick={() => void shell.set("calendar.sidebar", !sidebar)}
          >
            <Icon icon={SidebarSimpleIcon} />
          </Btn>
        </ColHead>
        {problems.map((st) => (
          <StatusBanner
            key={st.workspaceId}
            status={st}
            address={addressKnown(st.workspaceId) ?? workspace.address}
            s={s}
            onOpen={open}
            onRetry={() => retry(st.workspaceId)}
            onReconnect={() => onNavigate?.("settings:accounts")}
          />
        ))}
        {lineError ? (
          <p className="cal-error cal-answer-error" role="alert">
            {lineError}
            <button
              type="button"
              aria-label={s["strings.calendar.close"]}
              onClick={() => setLineError(null)}
            >
              <Icon icon={XIcon} />
            </button>
          </p>
        ) : null}
        <div className="cal-body">
          <div className="cal-view" key={searching ? "search" : view}>
            {body}
          </div>
          {sidebar ? (
            <Sidebar
              anchor={anchor}
              now={now}
              shown={range}
              busy={busyDays}
              today={todays}
              waiting={waiting}
              calendars={calendars}
              accounts={accounts}
              colors={colors}
              loading={loading}
              s={s}
              onPick={(d) => {
                setPop(null);
                setAnchor(startOfDay(d));
              }}
              onOpen={(o, el) => {
                const r = rectOf(el);
                if (r) openDetail(o, r);
              }}
              onJoin={(o) => open(o.link as string)}
              onToggle={(c: CalendarRow, visible) =>
                void source
                  .setVisible(c.id, visible)
                  .catch((e) => failed(s["strings.calendar.visible_failed"], e))
              }
              onColor={(c, color) => {
                const next = { ...s["calendar.colors"] };
                if (color) next[c.id] = color;
                else delete next[c.id];
                void shell.set("calendar.colors", next);
              }}
            />
          ) : null}
        </div>
      </div>
      {pop?.kind === "detail" && detail ? (
        <Popover
          anchor={pop.rect}
          onClose={() => setPop(null)}
          label={detail.title || s["strings.calendar.untitled"]}
          className="cal-pop-detail"
        >
          <EventDetail
            occ={detail}
            calendar={byId.get(detail.calendarId)}
            account={addressKnown(detail.workspaceId)}
            color={colors.get(detail.calendarId) ?? "var(--fg-muted)"}
            s={s}
            now={now}
            editable={editable(detail)}
            answerable={canAnswer(detail, addressOf)}
            onClose={() => setPop(null)}
            onJoin={open}
            onEdit={() => editOcc(detail)}
            onDuplicate={() => duplicate(detail)}
            onDelete={() => {
              void remove(detail).then((ok) => ok && setPop(null));
            }}
            onRespond={(r) => respond(detail, r)}
          />
        </Popover>
      ) : null}
      {pop?.kind === "create" && quick ? (
        <Popover
          anchor={pop.rect}
          onClose={() => {
            setPop(null);
            setQuick(null);
          }}
          label={s["strings.calendar.new_event"]}
          className="cal-pop-create"
        >
          <QuickCreate
            draft={quick}
            onChange={setQuick}
            calendars={calendars}
            accounts={accounts}
            colors={colors}
            s={s}
            busy={busy}
            error={formError}
            onSave={() => void saveQuick()}
            onMore={() => {
              setEditor({ draft: quick, original: null, occ: null });
              setPop(null);
              setQuick(null);
            }}
            onCancel={() => {
              setPop(null);
              setQuick(null);
            }}
          />
        </Popover>
      ) : null}
      {editor ? (
        <EventEditor
          draft={editor.draft}
          onChange={(draft) => setEditor({ ...editor, draft })}
          editing={editor.occ !== null}
          instance={Boolean(editor.occ?.recurringEventId)}
          calendars={calendars}
          accounts={accounts}
          colors={colors}
          s={s}
          busy={busy}
          error={formError}
          onSave={() => void saveEditor()}
          onDelete={
            editor.occ && byId.get(editor.occ.calendarId)?.writable
              ? () => {
                  const o = editor.occ as Occurrence;
                  void remove(o).then((ok) => ok && setEditor(null));
                }
              : undefined
          }
          onCancel={() => setEditor(null)}
        />
      ) : null}
      <AskDialog ask={ask} s={s} onDone={() => setAsk(null)} />
      {toast ? (
        <Toast
          key={toast.id}
          className="cal-toast"
          text={toast.text}
          undoLabel={s["strings.inbox.undo"]}
          undoKey={key("undo")}
          ms={s["inbox.undo_toast_ms"]}
          onUndo={toast.undo}
          onExpire={() => setToast(null)}
        />
      ) : null}
      {paletteExit.mounted ? (
        <Palette
          query={paletteQuery}
          onQuery={setPaletteQuery}
          onClose={() => setPaletteOpen(false)}
          leaving={paletteExit.leaving}
          onLeft={paletteExit.onEnd}
          keymap={keymap}
          workspaceId={workspace.id}
          recentThreads={[]}
          now={now}
          scope="calendar"
          onCommand={runCommand}
          onAsk={(a) => {
            setPaletteOpen(false);
            onAsk?.(a.text);
          }}
        />
      ) : null}
      {shell.layout.agent === "bottom" && !aiOff
        ? (agent ?? (
            <AgentDock>
              <AgentBar
                placeholder={s["strings.agent.placeholder"]}
                onFocus={() => onNavigate?.("agent")}
              />
            </AgentDock>
          ))
        : null}
    </div>
  );
}

/** Events touching a day, for the stream's Today panel and the tests. */
export function eventsOn(
  events: readonly CalendarEvent[],
  calendars: readonly CalendarRow[],
  day: Date,
): Occurrence[] {
  return eventsOnDay(
    occurrencesIn(events, calendars, { from: addDays(day, -1), to: addDays(day, 2) }),
    day,
  );
}
