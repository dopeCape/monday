// Calendar drafts on the Device (docs/spec/calendar.md, "Drafts"): the sets
// of changes the Agent proposes with propose_calendar_draft, like a diff
// over the calendar. The store keeps each draft the composer shows, which
// one the Calendar overlays, and what became of it (applied all or some,
// discarded), remembered through a persistence seam so a draft reloaded
// from a Session's history is not offered or focused again. Applying runs
// each change through the calendar seam, the same writes a drag or the
// editor makes; before any guest would be emailed it asks once for the
// whole set (ADR 0002). Undo reverses what was applied. Pure of the DOM.

import type {
  CalendarDraft,
  CalendarDraftChange,
  CalendarEvent,
  DraftEventFields,
  EventInput,
  EventPatch,
  Person,
} from "@monday/shared";
import type { CalendarSource } from "../screens/calendar/calendar-data.ts";

export type DraftStatus = "open" | "applied" | "partial" | "discarded";

export interface DraftEntry {
  draft: CalendarDraft;
  status: DraftStatus;
  /** Change ids applied so far. */
  applied: string[];
}

/** Where a draft's fate is kept between launches: the Cache's meta table in the app. */
export interface DraftMemory {
  get(draftId: string): Promise<DraftStatus | "seen" | null>;
  set(draftId: string, status: DraftStatus | "seen"): Promise<void>;
}

export const memoryDraftMemory = (): DraftMemory => {
  const m = new Map<string, DraftStatus | "seen">();
  return {
    get: async (id) => m.get(id) ?? null,
    set: async (id, status) => {
      m.set(id, status);
    },
  };
};

export interface ApplyResult {
  applied: string[];
  failed: Array<{ changeId: string; message: string }>;
  /** Nothing ran: the user said no to emailing the guests. */
  declined: boolean;
}

export interface DraftStore {
  subscribe(listener: () => void): () => void;
  /** Every draft known, newest first. Stable between changes. */
  list(): readonly DraftEntry[];
  get(draftId: string): DraftEntry | null;
  /** The draft the Calendar overlays, or null. */
  active(): string | null;
  setActive(draftId: string | null): void;
  /**
   * A draft the composer shows. A draft never seen before becomes the active
   * one and is handed to `onFresh` (the App opens the Calendar on it when
   * calendar.agent_draft_focus says so); one seen before is only listed.
   */
  offer(draft: CalendarDraft): Promise<void>;
  /**
   * Applies the draft's open changes, or only `changeIds`. `confirm` is asked
   * once with every guest who would be emailed; false applies nothing.
   */
  apply(
    draftId: string,
    confirm: (guests: readonly Person[]) => Promise<boolean>,
    changeIds?: readonly string[],
  ): Promise<ApplyResult>;
  /** Reverses the last apply of a draft: removes what it made, puts back what it changed or removed. */
  undo(draftId: string): Promise<void>;
  discard(draftId: string): Promise<void>;
}

export interface DraftStoreOptions {
  source: CalendarSource;
  memory: DraftMemory;
  /** A draft seen for the first time. */
  onFresh?: ((draft: CalendarDraft) => void) | undefined;
  /** The calendar a create without one lands on. */
  defaultCalendar?: (() => string | null) | undefined;
}

/** What each applied change needs to be taken back. */
type Reversal =
  | { kind: "remove"; eventId: string }
  | {
      kind: "restore";
      eventId: string;
      patch: EventPatch;
      options: { scope?: CalendarDraftChange["scope"]; occurrence?: string };
    }
  | { kind: "recreate"; input: EventInput };

function inputOf(f: DraftEventFields, fallbackCalendar: string | null): EventInput {
  return {
    title: f.title,
    start: f.start,
    end: f.end,
    allDay: f.allDay,
    ...(f.timeZone !== undefined ? { timeZone: f.timeZone } : {}),
    calendarId: f.calendarId ?? fallbackCalendar,
    ...(f.description !== undefined ? { description: f.description } : {}),
    ...(f.location !== undefined ? { location: f.location } : {}),
    ...(f.attendees !== undefined ? { attendees: f.attendees } : {}),
    ...(f.recurrence !== undefined ? { recurrence: f.recurrence } : {}),
    ...(f.meetingLink !== undefined ? { meetingLink: f.meetingLink } : {}),
  };
}

/** The fields an update changes, from before to after. */
export function patchBetween(before: DraftEventFields | null, after: DraftEventFields): EventPatch {
  const patch: EventPatch = {};
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  if (!before || before.title !== after.title) patch.title = after.title;
  if (!before || before.start !== after.start || before.allDay !== after.allDay)
    patch.start = after.start;
  if (!before || before.end !== after.end || before.allDay !== after.allDay) patch.end = after.end;
  if (!before || before.allDay !== after.allDay) patch.allDay = after.allDay;
  if (after.timeZone !== undefined && !same(before?.timeZone, after.timeZone))
    patch.timeZone = after.timeZone;
  if (after.description !== undefined && !same(before?.description, after.description))
    patch.description = after.description;
  if (after.location !== undefined && !same(before?.location, after.location))
    patch.location = after.location;
  if (after.attendees !== undefined && !same(before?.attendees, after.attendees))
    patch.attendees = after.attendees;
  if (after.recurrence !== undefined && !same(before?.recurrence, after.recurrence))
    patch.recurrence = after.recurrence;
  if (after.calendarId && !same(before?.calendarId, after.calendarId))
    patch.calendarId = after.calendarId;
  if (after.meetingLink !== undefined) patch.meetingLink = after.meetingLink;
  return patch;
}

/** Counts of a draft's changes by kind: "+3 ~2 −1" on the bar and the card. */
export function draftCounts(draft: CalendarDraft): {
  create: number;
  update: number;
  delete: number;
} {
  const out = { create: 0, update: 0, delete: 0 };
  for (const c of draft.changes) out[c.kind] += 1;
  return out;
}

/** Everyone a set of changes would email, once each. */
export function guestsOfChanges(changes: readonly CalendarDraftChange[]): Person[] {
  const seen = new Map<string, Person>();
  for (const c of changes) for (const p of c.guests) seen.set(p.email.toLowerCase(), p);
  return [...seen.values()];
}

export function createDraftStore(options: DraftStoreOptions): DraftStore {
  const listeners = new Set<() => void>();
  let entries: DraftEntry[] = [];
  let activeId: string | null = null;
  const reversals = new Map<string, Reversal[]>();
  const emit = () => {
    entries = [...entries];
    for (const l of [...listeners]) l();
  };
  const find = (id: string) => entries.find((e) => e.draft.id === id) ?? null;
  const replace = (id: string, next: Partial<DraftEntry>) => {
    entries = entries.map((e) => (e.draft.id === id ? { ...e, ...next } : e));
    emit();
  };
  const created = (e: CalendarEvent) => e.id;

  const store: DraftStore = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    list: () => entries,
    get: find,
    active: () => activeId,
    setActive(id) {
      activeId = id;
      emit();
    },
    async offer(draft) {
      if (find(draft.id)) return;
      const known = await options.memory.get(draft.id);
      if (find(draft.id)) return;
      const status: DraftStatus =
        known === "applied" || known === "partial" || known === "discarded" ? known : "open";
      entries = [{ draft, status, applied: [] }, ...entries];
      if (known === null) {
        await options.memory.set(draft.id, "seen");
        activeId = draft.id;
        emit();
        options.onFresh?.(draft);
        return;
      }
      emit();
    },
    async apply(draftId, confirm, changeIds) {
      const entry = find(draftId);
      if (!entry) return { applied: [], failed: [], declined: false };
      const wanted = entry.draft.changes.filter(
        (c) => !entry.applied.includes(c.id) && (!changeIds || changeIds.includes(c.id)),
      );
      const guests = guestsOfChanges(wanted);
      if (guests.length > 0 && !(await confirm(guests))) {
        return { applied: [], failed: [], declined: true };
      }
      const applied: string[] = [];
      const failed: ApplyResult["failed"] = [];
      const undo: Reversal[] = [];
      const fallback = options.defaultCalendar?.() ?? null;
      for (const c of wanted) {
        const aim = {
          ...(c.scope ? { scope: c.scope } : {}),
          ...(c.occurrence ? { occurrence: c.occurrence } : {}),
        };
        try {
          if (c.kind === "create" && c.after) {
            const event = await options.source.create(inputOf(c.after, fallback));
            undo.push({ kind: "remove", eventId: created(event) });
          } else if (c.kind === "update" && c.eventId && c.after) {
            await options.source.update(c.eventId, patchBetween(c.before, c.after), aim);
            if (c.before && (!c.scope || c.scope === "this" || c.scope === "all")) {
              undo.push({
                kind: "restore",
                eventId: c.eventId,
                patch: patchBetween(c.after, c.before),
                options: aim,
              });
            }
          } else if (c.kind === "delete" && c.eventId) {
            await options.source.remove(c.eventId, aim);
            if (c.before && !c.scope)
              undo.push({ kind: "recreate", input: inputOf(c.before, fallback) });
          } else {
            throw new Error("the change is incomplete");
          }
          applied.push(c.id);
        } catch (error) {
          failed.push({
            changeId: c.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      reversals.set(draftId, undo);
      const all = [...entry.applied, ...applied];
      const status: DraftStatus =
        all.length >= entry.draft.changes.length
          ? "applied"
          : all.length > 0
            ? "partial"
            : entry.status;
      replace(draftId, { applied: all, status });
      if (status !== "open") await options.memory.set(draftId, status);
      if (status === "applied" && activeId === draftId) {
        activeId = null;
        emit();
      }
      return { applied, failed, declined: false };
    },
    async undo(draftId) {
      const undo = reversals.get(draftId) ?? [];
      reversals.delete(draftId);
      for (const r of [...undo].reverse()) {
        try {
          if (r.kind === "remove") await options.source.remove(r.eventId);
          else if (r.kind === "restore") await options.source.update(r.eventId, r.patch, r.options);
          else await options.source.create(r.input);
        } catch {
          // What cannot be taken back stays; the calendar shows it.
        }
      }
      replace(draftId, { applied: [], status: "open" });
      await options.memory.set(draftId, "seen");
    },
    async discard(draftId) {
      replace(draftId, { status: "discarded" });
      if (activeId === draftId) {
        activeId = null;
        emit();
      }
      await options.memory.set(draftId, "discarded");
    },
  };
  return store;
}
