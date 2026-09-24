/// <reference types="bun-types" />
// Calendar drafts through the store's interface over the fixture calendar
// seam: a draft seen for the first time becomes the active one and is
// handed on once; one remembered is only listed; apply asks once before
// guests are emailed and writes nothing on a no; apply some; a failure
// kept apart; Undo takes the applied changes back; discard remembers.
// Plus the pure pieces the views and the card use.

import { describe, expect, test } from "bun:test";
import type { Calendar, CalendarDraft, CalendarEvent } from "@monday/shared";
import { fixtureCalendar } from "../screens/calendar/calendar-data.ts";
import {
  createDraftStore,
  draftCounts,
  guestsOfChanges,
  memoryDraftMemory,
  patchBetween,
} from "./drafts.ts";

const cal: Calendar = {
  id: "cal-1",
  workspaceId: "ws",
  source: "google",
  providerId: "primary",
  name: "me",
  primary: true,
  writable: true,
  visible: true,
  color: null,
};

function event(id: string, title: string, start: string, end: string): CalendarEvent {
  return {
    id,
    workspaceId: "ws",
    calendarId: "cal-1",
    providerId: id,
    uid: null,
    title,
    description: "",
    location: "",
    start,
    end,
    allDay: false,
    timeZone: null,
    organizer: null,
    attendees: [],
    link: null,
    status: "confirmed",
    recurrence: null,
    recurringEventId: null,
    response: "accepted",
    createdByAgent: false,
    etag: null,
    updatedAt: "",
  };
}

const kenji = { name: "Kenji", email: "kenji@meridian.test" };

function draft(): CalendarDraft {
  return {
    id: "d1",
    workspaceId: "ws",
    title: "Plan for the week",
    summary: "Focus blocks and the review",
    from: "2026-09-21T00:00:00.000Z",
    to: "2026-09-26T00:00:00.000Z",
    createdAt: "2026-09-20T10:00:00.000Z",
    changes: [
      {
        id: "c1",
        kind: "create",
        before: null,
        after: {
          title: "Focus",
          start: "2026-09-21T09:00:00.000Z",
          end: "2026-09-21T11:00:00.000Z",
          allDay: false,
        },
        guests: [],
      },
      {
        id: "c2",
        kind: "update",
        eventId: "review",
        before: {
          title: "Review",
          start: "2026-09-22T13:00:00.000Z",
          end: "2026-09-22T14:00:00.000Z",
          allDay: false,
        },
        after: {
          title: "Review",
          start: "2026-09-22T15:00:00.000Z",
          end: "2026-09-22T16:00:00.000Z",
          allDay: false,
        },
        guests: [kenji],
        reason: "Clears the afternoon for focus",
      },
      {
        id: "c3",
        kind: "delete",
        eventId: "sync",
        before: {
          title: "Sync",
          start: "2026-09-23T10:00:00.000Z",
          end: "2026-09-23T10:30:00.000Z",
          allDay: false,
        },
        after: null,
        guests: [],
      },
    ],
  };
}

function world() {
  const source = fixtureCalendar({
    calendars: [cal],
    events: [
      event("review", "Review", "2026-09-22T13:00:00.000Z", "2026-09-22T14:00:00.000Z"),
      event("sync", "Sync", "2026-09-23T10:00:00.000Z", "2026-09-23T10:30:00.000Z"),
    ],
  });
  const memory = memoryDraftMemory();
  const fresh: string[] = [];
  const store = createDraftStore({
    source,
    memory,
    onFresh: (d) => fresh.push(d.id),
    defaultCalendar: () => "cal-1",
  });
  return { source, memory, fresh, store };
}

describe("the draft store", () => {
  test("a draft seen for the first time becomes active and is handed on once; a remembered one is only listed", async () => {
    const w = world();
    await w.store.offer(draft());
    await w.store.offer(draft());
    expect(w.fresh).toEqual(["d1"]);
    expect(w.store.active()).toBe("d1");
    expect(await w.memory.get("d1")).toBe("seen");
    // Reloaded from a Session's history on another launch: listed, not focused.
    const again = createDraftStore({
      source: w.source,
      memory: w.memory,
      onFresh: (d) => w.fresh.push(d.id),
    });
    await again.offer(draft());
    expect(w.fresh).toEqual(["d1"]);
    expect(again.active()).toBeNull();
    expect(again.list()).toHaveLength(1);
  });

  test("apply asks once before guests are emailed; no writes nothing", async () => {
    const w = world();
    await w.store.offer(draft());
    const asked: string[][] = [];
    const r = await w.store.apply("d1", async (g) => {
      asked.push(g.map((p) => p.email));
      return false;
    });
    expect(asked).toEqual([["kenji@meridian.test"]]);
    expect(r.declined).toBe(true);
    expect(w.source.log).toEqual([]);
  });

  test("apply all runs each change through the seam; Undo takes them back", async () => {
    const w = world();
    await w.store.offer(draft());
    const r = await w.store.apply("d1", async () => true);
    expect(r.applied).toEqual(["c1", "c2", "c3"]);
    expect(w.source.log).toEqual(["create Focus", "update review end,start", "remove sync"]);
    expect(w.store.get("d1")?.status).toBe("applied");
    expect(await w.memory.get("d1")).toBe("applied");
    expect(w.store.active()).toBeNull();
    await w.store.undo("d1");
    // In reverse: the removed one made again, the moved one back, the made one removed.
    expect(w.source.log.slice(3)).toEqual([
      "create Sync",
      "update review end,start",
      "remove ev-3",
    ]);
    expect(w.source.events().find((e) => e.id === "review")?.start).toBe(
      "2026-09-22T13:00:00.000Z",
    );
    expect(w.store.get("d1")?.status).toBe("open");
  });

  test("apply some leaves the rest open; a failing change is kept apart", async () => {
    const w = world();
    await w.store.offer(draft());
    const r = await w.store.apply("d1", async () => true, ["c1"]);
    expect(r.applied).toEqual(["c1"]);
    expect(w.store.get("d1")?.status).toBe("partial");
    const failing = fixtureCalendar({
      calendars: [cal],
      events: [],
      fail: { remove: "gone already" },
    });
    const store = createDraftStore({ source: failing, memory: memoryDraftMemory() });
    await store.offer(draft());
    const out = await store.apply("d1", async () => true, ["c3"]);
    expect(out.failed).toEqual([{ changeId: "c3", message: "gone already" }]);
    expect(store.get("d1")?.status).toBe("open");
  });

  test("discard is remembered and clears the overlay", async () => {
    const w = world();
    await w.store.offer(draft());
    await w.store.discard("d1");
    expect(w.store.active()).toBeNull();
    expect(await w.memory.get("d1")).toBe("discarded");
  });

  test("the pieces: counts, guests once each, the patch between two versions", () => {
    expect(draftCounts(draft())).toEqual({ create: 1, update: 1, delete: 1 });
    expect(guestsOfChanges([...draft().changes, ...draft().changes]).map((p) => p.email)).toEqual([
      "kenji@meridian.test",
    ]);
    const c2 = draft().changes[1];
    expect(Object.keys(patchBetween(c2?.before ?? null, c2?.after as never)).sort()).toEqual([
      "end",
      "start",
    ]);
  });
});
