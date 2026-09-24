/// <reference types="bun-types" />
// The Store-backed calendar seam over bun:sqlite with the API faked at its
// seam: the other Accounts' calendars joining the open Workspace's for the
// window on screen (and leaving when the Setting is off), a change written
// to the Cache at once, an instance of a master left out with an EXDATE,
// statuses per Account, and an older Cache gaining the reminders column.

import { describe, expect, test } from "bun:test";
import type {
  Calendar,
  CalendarEvent,
  CalendarStatus,
  EventPatch,
  EventWriteOptions,
} from "@monday/shared";
import type { Api } from "../../platform/api.ts";
import { bunDriver } from "../../store/bun-driver.ts";
import { createFakeStore } from "../../store/fake.ts";
import { applySchema } from "../../store/store.ts";
import { createStoreCalendar, occurrencesIn } from "./calendar-data.ts";

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 2_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await tick();
  }
  throw new Error("condition not met");
}

function event(
  over: Partial<CalendarEvent> & { id: string; workspaceId: string; calendarId: string },
): CalendarEvent {
  return {
    providerId: over.id,
    uid: null,
    title: over.id,
    description: "",
    location: "",
    start: "2026-09-17T09:00:00.000Z",
    end: "2026-09-17T10:00:00.000Z",
    allDay: false,
    timeZone: null,
    organizer: null,
    attendees: [],
    link: null,
    status: "confirmed",
    recurrence: null,
    recurringEventId: null,
    response: null,
    createdByAgent: false,
    etag: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

const home: Calendar = {
  id: "c-home",
  workspaceId: "ws-home",
  source: "caldav",
  providerId: "home",
  name: "Personal",
  primary: true,
  writable: true,
  visible: true,
  color: null,
};

function fakeApi(log: string[]) {
  const statuses: Record<string, CalendarStatus> = {
    "ws-genai": {
      workspaceId: "ws-genai",
      accountId: "a1",
      source: "google",
      problem: null,
      lastSync: null,
      checkedAt: "",
    },
    "ws-home": {
      workspaceId: "ws-home",
      accountId: "a2",
      source: "caldav",
      problem: { kind: "auth", message: "401", fixUrl: null },
      lastSync: null,
      checkedAt: "",
    },
  };
  const api = {
    accounts: {
      list: async () => ({
        accounts: [
          { id: "a1", workspaceId: "ws-genai", address: "tejas@genai-labs.io" },
          { id: "a2", workspaceId: "ws-home", address: "tejas@home.test" },
        ],
      }),
    },
    calendar: {
      calendars: async (ws: string) => (ws === "ws-home" ? [home] : []),
      events: async (ws: string, from: string, to: string) => {
        log.push(`events ${ws} ${from.slice(0, 10)} ${to.slice(0, 10)}`);
        return ws === "ws-home"
          ? [event({ id: "gym", workspaceId: "ws-home", calendarId: "c-home" })]
          : [];
      },
      update: async (id: string, patch: EventPatch, opts: EventWriteOptions) => {
        log.push(`update ${id} ${Object.keys(patch).sort().join(",")} ${opts.scope ?? ""}`);
        return event({
          id,
          workspaceId: "ws-genai",
          calendarId: "c-work",
          title: "Moved",
          ...(patch as object),
        });
      },
      remove: async (id: string, opts: EventWriteOptions) => {
        log.push(`remove ${id} ${opts.scope ?? ""} ${opts.occurrence ?? ""}`);
      },
      status: async (ws: string) => statuses[ws] as CalendarStatus,
      sync: async (ws: string) => ({ ...(statuses[ws] as CalendarStatus), problem: null }),
    },
  };
  return api as unknown as Api;
}

describe("the Store calendar seam", () => {
  test("other Accounts join for the window on screen; off, they leave", async () => {
    const { store } = await createFakeStore({ driver: bunDriver(), seed: null });
    const log: string[] = [];
    let others = true;
    const source = await createStoreCalendar(store, fakeApi(log), { otherAccounts: () => others });
    await until(() => source.accounts().length === 2);
    expect(source.accounts().map((a) => [a.address, a.current])).toEqual([
      ["tejas@genai-labs.io", true],
      ["tejas@home.test", false],
    ]);
    source.cover(new Date("2026-09-14T00:00:00Z"), new Date("2026-09-21T00:00:00Z"));
    await until(() => source.events().some((e) => e.id === "gym"));
    expect(source.calendars().map((c) => c.id)).toContain("c-home");
    expect(log.filter((l) => l.startsWith("events"))).toEqual([
      "events ws-home 2026-08-14 2026-10-22",
    ]);
    // Inside the window already fetched: no second request.
    source.cover(new Date("2026-09-15T00:00:00Z"), new Date("2026-09-16T00:00:00Z"));
    await tick(20);
    expect(log.filter((l) => l.startsWith("events"))).toHaveLength(1);
    // Statuses for both, and Try again on one.
    const statuses = await source.status();
    expect(statuses.map((s) => s.problem?.kind ?? "ok")).toEqual(["ok", "auth"]);
    expect((await source.retry("ws-home")).problem).toBeNull();
    others = false;
    source.cover(new Date("2027-01-01T00:00:00Z"), new Date("2027-01-08T00:00:00Z"));
    await until(() => !source.events().some((e) => e.id === "gym"));
    source.close();
  });

  test("a change lands in the Cache at once; one instance of a master is left out with an EXDATE", async () => {
    const { store } = await createFakeStore({ driver: bunDriver(), seed: null });
    await store.write([
      {
        sql: `insert into events (id, calendar_id, start, "end", recurrence, title, content_stale) values (?, ?, ?, ?, ?, ?, 0)`,
        params: [
          "standup",
          "c-work",
          "2026-09-14T09:00:00.000Z",
          "2026-09-14T09:15:00.000Z",
          "FREQ=DAILY",
          "Standup",
        ],
      },
      {
        sql: `insert into events (id, calendar_id, start, "end", title, content_stale) values (?, ?, ?, ?, ?, 0)`,
        params: [
          "focus",
          "c-work",
          "2026-09-17T13:00:00.000Z",
          "2026-09-17T15:00:00.000Z",
          "Focus",
        ],
      },
    ]);
    const log: string[] = [];
    const source = await createStoreCalendar(store, fakeApi(log), { otherAccounts: () => false });
    await until(() => source.events().length === 2);
    await source.update("focus", {
      start: "2026-09-18T13:00:00.000Z",
      end: "2026-09-18T15:00:00.000Z",
    });
    await until(
      () => source.events().find((e) => e.id === "focus")?.start === "2026-09-18T13:00:00.000Z",
    );
    expect(log).toContain("update focus end,start ");
    await source.remove("standup", { scope: "this", occurrence: "2026-09-16T09:00:00.000Z" });
    await until(() =>
      (source.events().find((e) => e.id === "standup")?.recurrence ?? "").includes("EXDATE"),
    );
    const week = occurrencesIn(source.events(), source.calendars(), {
      from: new Date("2026-09-14T00:00:00Z"),
      to: new Date("2026-09-19T00:00:00Z"),
    }).filter((o) => o.id === "standup");
    expect(week.map((o) => o.start.slice(8, 10))).toEqual(["14", "15", "17", "18"]);
    source.close();
  });

  test("an older Cache gains the reminders column in place", async () => {
    const driver = bunDriver();
    await applySchema(driver);
    // The Cache as it was before per-Event reminders.
    await driver.exec("alter table events drop column reminders");
    expect(
      (await driver.query("pragma table_info(events)")).some((c) => c.name === "reminders"),
    ).toBe(false);
    await applySchema(driver);
    const columns = await driver.query("pragma table_info(events)");
    expect(columns.some((c) => c.name === "reminders")).toBe(true);
  });
});
