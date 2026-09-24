/// <reference types="bun-types" />
// The Calendar screen, the invite bar and the reminders through the calendar
// seam (slice 18, docs/spec/calendar.md): Week, Month and Agenda over
// fixture Events with a recurring master expanded on the client, the
// detail with the answers and Join, the quick create asking before guests
// are emailed, a repeating Event's "this one", a drag that moves an Event
// and its Undo, the keys, search, an Account whose Calendar API is off, the
// Today panel, the calendar list, the Schedule handoff, the invite bar's
// Accept as an Outbox intent with the overlap line, and reminders.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { CalendarEvent, Calendar as CalendarRow, Invite } from "@monday/shared";
import { defaultSettings } from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { nextReminder, scheduleReminders } from "../calendar/reminders.ts";
import { StaticShell } from "../shell/Shell.tsx";
import { Calendar } from "./Calendar.tsx";
import { fixtureCalendar, occurrencesIn } from "./calendar/calendar-data.ts";
import { InviteBar, ThreadInviteBar } from "./inbox/InviteBar.tsx";

let createRoot: Awaited<ReturnType<typeof dom>>["createRoot"];
beforeAll(async () => {
  ({ createRoot } = await dom());
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

// A Thursday at 14:20 local.
const NOW = new Date(2026, 8, 17, 14, 20);
const at = (day: number, h: number, m = 0) => new Date(2026, 8, day, h, m).toISOString();

const calendars: CalendarRow[] = [
  {
    id: "cal-1",
    workspaceId: "ws",
    source: "google",
    providerId: "primary",
    name: "tejas@genai-labs.io",
    primary: true,
    writable: true,
    visible: true,
    color: null,
  },
  {
    id: "cal-2",
    workspaceId: "ws",
    source: "google",
    providerId: "team",
    name: "Team (shared)",
    primary: false,
    writable: false,
    visible: true,
    color: "#4a7",
  },
];

function event(
  over: Partial<CalendarEvent> & { id: string; title: string; start: string; end: string },
): CalendarEvent {
  return {
    workspaceId: "ws",
    calendarId: "cal-1",
    providerId: over.id,
    uid: null,
    description: "",
    location: "",
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
    updatedAt: NOW.toISOString(),
    ...over,
  };
}

const events: CalendarEvent[] = [
  // A daily standup master from Monday: the client expands it.
  event({
    id: "standup",
    title: "Standup",
    start: at(14, 9),
    end: at(14, 9, 30),
    recurrence: "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR",
  }),
  event({ id: "focus", title: "Focus", start: at(17, 13), end: at(17, 15) }),
  event({
    id: "aoife",
    title: "Aoife Brennan, take-home",
    start: at(17, 15),
    end: at(17, 15, 45),
    link: "https://meet.genai-labs.io/aoife",
    createdByAgent: true,
    attendees: [
      {
        name: "Tejas",
        email: "tejas@genai-labs.io",
        response: "accepted",
        self: true,
        organizer: true,
      },
      { name: "Aoife Brennan", email: "aoife@northwind.test", response: "needs-action" },
    ],
  }),
  event({
    id: "podcast",
    title: "Podcast recording",
    start: at(18, 13),
    end: at(18, 14),
    status: "tentative",
    response: "needs-action",
    organizer: { name: "Sofia Lindqvist", email: "sofia@lindqvist.test" },
    attendees: [
      {
        name: "Sofia Lindqvist",
        email: "sofia@lindqvist.test",
        response: "accepted",
        organizer: true,
      },
      { name: "Tejas", email: "tejas@genai-labs.io", response: "needs-action", self: true },
    ],
  }),
  event({
    id: "team-offsite",
    title: "Offsite",
    calendarId: "cal-2",
    start: at(19, 0),
    end: at(20, 0),
    allDay: true,
  }),
];

const podcastInvite: Invite = {
  id: "inv-1",
  workspaceId: "ws",
  messageId: "m-podcast",
  threadId: "t-podcast",
  eventId: "podcast",
  method: "REQUEST",
  uid: "podcast@lindqvist",
  sequence: 0,
  title: "Podcast recording",
  start: at(18, 13),
  end: at(18, 14),
  allDay: false,
  organizer: { name: "Sofia Lindqvist", email: "sofia@lindqvist.test" },
  attendees: [],
  response: "needs-action",
  byMail: true,
  senderMismatch: false,
  receivedAt: NOW.toISOString(),
};
const invites: Invite[] = [podcastInvite];

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const S = defaultSettings();

async function mount(element: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <StaticShell
        settings={{
          "calendar.day_start_hour": 8,
          "calendar.day_end_hour": 18,
          "ai.level": "assist",
        }}
      >
        {element}
      </StaticShell>,
    );
  });
  await act(tick);
}

const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(tick);
};

describe("occurrencesIn", () => {
  test("expands a recurring master inside the window, keeps single Events, drops hidden calendars", () => {
    const week = { from: new Date(2026, 8, 14), to: new Date(2026, 8, 21) };
    const out = occurrencesIn(events, calendars, week);
    expect(out.filter((o) => o.title === "Standup")).toHaveLength(5);
    expect(out.find((o) => o.title === "Standup")?.key).toBe(`standup@${at(14, 9)}`);
    expect(out.some((o) => o.title === "Offsite")).toBe(true);
    const hidden = occurrencesIn(
      events,
      calendars.map((c) => (c.id === "cal-2" ? { ...c, visible: false } : c)),
      week,
    );
    expect(hidden.some((o) => o.title === "Offsite")).toBe(false);
  });
});

const typeInto = async (input: Element | null | undefined, value: string) => {
  if (!input) throw new Error("no input");
  const proto =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(tick);
};

const press = async (key: string, init: KeyboardEventInit = {}) => {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
  await act(tick);
};

const pointer = async (el: Element | Window, type: string, x: number, y: number) => {
  await act(async () => {
    const e = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
    });
    el.dispatchEvent(e);
  });
  await act(tick);
};

const button = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) ?? null;

/** The Event detail's popover, once open. */
const popover = () => document.querySelector(".cal-pop");

/** Lays the grid's day columns out side by side (happy-dom has no layout): 100px wide, the day from y = 0. */
function layOut(el: HTMLElement) {
  const cols = [...el.querySelectorAll<HTMLElement>(".cal-tg-col")];
  cols.forEach((c, i) => {
    c.getBoundingClientRect = () =>
      ({
        left: 100 + i * 100,
        right: 200 + i * 100,
        top: 0,
        bottom: 24 * 48,
        width: 100,
        height: 24 * 48,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
  });
}

describe("the Calendar screen", () => {
  test("Week: every day of the week, the Events side by side, the Agent's marked, all-day ones on their row, Today with Join", async () => {
    const source = fixtureCalendar({ calendars, events, invites });
    const opened: string[] = [];
    await mount(<Calendar source={source} now={NOW} onOpenLink={(h) => opened.push(h)} />);
    const el = host as HTMLElement;
    expect(el.querySelector(".col-head .count")?.textContent).toBe("September 2026");
    expect(el.querySelectorAll(".cal-tg-dh")).toHaveLength(7);
    expect(el.querySelectorAll(".cal-tg-dh.today")).toHaveLength(1);
    const titles = [...el.querySelectorAll(".cal-tg-col .cal-block b")].map((b) => b.textContent);
    expect(titles.filter((t) => t === "Standup")).toHaveLength(5);
    expect(titles).toContain("Aoife Brennan, take-home");
    expect(el.querySelectorAll(".cal-tg-col .cal-block.agent")).toHaveLength(1);
    // The current time is drawn once, in today's column.
    expect(el.querySelectorAll(".cal-tg-col.today .cal-now")).toHaveLength(1);
    // The all-day Offsite sits on the all-day row, not in the grid.
    expect(el.querySelector(".cal-allday-cells .cal-bar")?.textContent).toContain("Offsite");
    expect(titles).not.toContain("Offsite");
    // Saturday and Sunday are shaded as days off; the working hours of a weekday are clear.
    expect(el.querySelectorAll(".cal-tg-col.off")).toHaveLength(2);
    // The Today panel: Focus is the current one at 14:20; Aoife's has Join.
    const rows = [...el.querySelectorAll(".today-panel .tp-row")];
    expect(rows.map((r) => r.querySelector("b")?.textContent)).toEqual([
      "Standup",
      "Focus",
      "Aoife Brennan, take-home",
    ]);
    expect(rows[1]?.className).toContain("now");
    await click(button(rows[2] as Element, "Join"));
    expect(opened).toEqual(["https://meet.genai-labs.io/aoife"]);
    // The invite still waiting for an answer is listed beside the week.
    expect(el.querySelector(".cal-waiting")?.textContent).toContain("Podcast recording");
  });

  test("an Event's detail: when, the guests and their answers, Join, and Yes, Maybe, No on an invite", async () => {
    const source = fixtureCalendar({ calendars, events, invites });
    const opened: string[] = [];
    await mount(<Calendar source={source} now={NOW} onOpenLink={(h) => opened.push(h)} />);
    const el = host as HTMLElement;
    const podcast = [...el.querySelectorAll<HTMLElement>(".cal-block")].find((b) =>
      b.textContent?.includes("Podcast recording"),
    );
    await pointer(podcast as Element, "pointerdown", 10, 10);
    await pointer(window, "pointerup", 10, 10);
    const pop = popover();
    expect(pop?.querySelector("h3")?.textContent).toBe("Podcast recording");
    expect(pop?.textContent).toContain("Fri 18 Sep, 13:00 to 14:00");
    expect(pop?.textContent).toContain("Sofia Lindqvist");
    expect(pop?.textContent).toContain("organizer");
    expect(pop?.textContent).toContain("tejas@genai-labs.io");
    // Not the user's own: no Edit, but an answer row.
    expect(pop?.querySelector('button[title="Edit"]')).toBeNull();
    await click(button(pop as Element, "Maybe"));
    expect(source.log).toEqual(["respond podcast tentative"]);
    await press("Escape");
    expect(popover()).toBeNull();

    // Aoife's is the user's own, with a link: Join, and Edit.
    const aoife = [...el.querySelectorAll<HTMLElement>(".cal-block")].find((b) =>
      b.textContent?.includes("Aoife"),
    );
    await act(async () => {
      aoife?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await act(tick);
    expect(popover()?.textContent).toContain("meet.genai-labs.io");
    expect(popover()?.querySelector('button[title="Edit"]')).not.toBeNull();
    await click(button(popover() as Element, "Join"));
    expect(opened).toEqual(["https://meet.genai-labs.io/aoife"]);
  });

  test("a new Event from the header: the quick create, a guest, the ask before invitations go, then the Event", async () => {
    const source = fixtureCalendar({ calendars, events, invites });
    await mount(<Calendar source={source} now={NOW} />);
    const el = host as HTMLElement;
    await click(button(el.querySelector(".col-head") as Element, "Event"));
    const form = document.querySelector<HTMLFormElement>(".cal-quick");
    expect(form).not.toBeNull();
    await typeInto(form?.querySelector(".cal-quick-title"), "Dentist");
    await typeInto(form?.querySelector(".cal-people-input"), "Kenji <kenji@meridian.test>,");
    expect(form?.querySelector(".cal-chip")?.textContent).toContain("Kenji");
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(tick);
    // Guests are emailed: ask first (ADR 0002).
    const dialog = document.querySelector(".cal-dialog");
    expect(dialog?.textContent).toContain("Send invitations?");
    expect(dialog?.textContent).toContain("Kenji will get an email about this.");
    expect(source.log).toEqual([]);
    await click(button(dialog as Element, "Send"));
    await act(tick);
    expect(source.log).toEqual(["create Dentist"]);
    expect(document.querySelector(".cal-quick")).toBeNull();
    const made = source.events().find((e) => e.title === "Dentist");
    expect(made?.attendees.map((a) => a.email)).toEqual(["kenji@meridian.test"]);
    // The default length from Settings, on the next slot after 14:20.
    expect(new Date(made?.start ?? "").getHours()).toBe(14);
    expect(new Date(made?.start ?? "").getMinutes()).toBe(30);
    expect((Date.parse(made?.end ?? "") - Date.parse(made?.start ?? "")) / 60_000).toBe(30);
  });

  test("an end before the start is refused in plain words and nothing is made; More options opens the editor", async () => {
    const source = fixtureCalendar({ calendars, events, invites });
    await mount(<Calendar source={source} now={NOW} />);
    const el = host as HTMLElement;
    await click(button(el.querySelector(".col-head") as Element, "Event"));
    const form = document.querySelector<HTMLFormElement>(".cal-quick");
    await typeInto(form?.querySelector('input[aria-label="End"]'), "09:00");
    expect(form?.querySelector(".cal-error")?.textContent).toBe(
      "The end has to come after the start.",
    );
    expect((button(form as Element, "Add") as HTMLButtonElement).disabled).toBe(true);
    await click(button(form as Element, "More options"));
    expect(document.querySelector(".cal-quick")).toBeNull();
    const editor = document.querySelector(".cal-editor");
    expect(editor).not.toBeNull();
    expect(editor?.querySelector('select[aria-label="Repeat"]')).not.toBeNull();
    expect(editor?.querySelector('textarea[aria-label="Notes"]')).not.toBeNull();
    await click(button(editor as Element, "Cancel"));
    expect(document.querySelector(".cal-editor")).toBeNull();
    expect(source.log).toEqual([]);
  });

  test("a repeating Event asks which instances: this one leaves the others in place", async () => {
    const source = fixtureCalendar({ calendars, events, invites });
    await mount(<Calendar source={source} now={NOW} />);
    const el = host as HTMLElement;
    const standups = () =>
      [...el.querySelectorAll<HTMLElement>(".cal-block")].filter((b) =>
        b.textContent?.includes("Standup"),
      );
    expect(standups()).toHaveLength(5);
    await pointer(standups()[2] as Element, "pointerdown", 10, 10);
    await pointer(window, "pointerup", 10, 10);
    expect(popover()?.textContent).toContain("Every weekday");
    await click(popover()?.querySelector('button[title="Delete"]'));
    const dialog = document.querySelector(".cal-dialog");
    expect(dialog?.querySelector("h3")?.textContent).toBe("Delete a repeating Event");
    await click(button(dialog as Element, "OK"));
    await act(tick);
    expect(source.log).toEqual(["remove standup this"]);
    expect(standups()).toHaveLength(4);
  });

  test("dragging an Event moves it on the grid, snapped; Undo puts it back", async () => {
    const source = fixtureCalendar({ calendars, events, invites });
    await mount(<Calendar source={source} now={NOW} />);
    const el = host as HTMLElement;
    layOut(el);
    const focus = [...el.querySelectorAll<HTMLElement>(".cal-block")].find((b) =>
      b.textContent?.includes("Focus"),
    );
    // Focus is Thursday 13:00; the grid's Thursday column is the fourth (Monday first).
    await pointer(focus as Element, "pointerdown", 450, 13 * 48);
    await pointer(window, "pointermove", 550, 13 * 48 + 50);
    await pointer(window, "pointerup", 550, 13 * 48 + 50);
    await act(tick);
    expect(source.log[0]).toBe("update focus end,start");
    const moved = source.events().find((e) => e.id === "focus");
    // One day on, an hour later (50px at 48px an hour, snapped to 15 minutes).
    expect(new Date(moved?.start ?? "").getDate()).toBe(18);
    expect(new Date(moved?.start ?? "").getHours()).toBe(14);
    expect(new Date(moved?.start ?? "").getMinutes()).toBe(0);
    expect(document.querySelector(".toast")?.textContent).toContain("Event changed");
    await press("z");
    expect(source.log[1]).toBe("update focus end,start");
    expect(source.events().find((e) => e.id === "focus")?.start).toBe(at(17, 13));
  });

  test("keys switch views and move through time; the palette's date opens a day", async () => {
    const source = fixtureCalendar({ calendars, events, invites });
    await mount(<Calendar source={source} now={NOW} />);
    const el = host as HTMLElement;
    const heading = () => el.querySelector(".col-head .count")?.textContent;
    await press("m");
    expect(el.querySelector(".cal-month")).not.toBeNull();
    expect(heading()).toBe("September 2026");
    await press("j");
    expect(heading()).toBe("October 2026");
    await press("t");
    expect(heading()).toBe("September 2026");
    await press("d");
    expect(heading()).toBe("Thursday 17 September 2026");
    await press("k");
    expect(heading()).toBe("Wednesday 16 September 2026");
    await press("a");
    expect(el.querySelector(".cal-agenda")).not.toBeNull();
    await press("w");
    expect(el.querySelectorAll(".cal-tg-dh")).toHaveLength(7);
    // "m" in the Inbox moves a Thread; here it is only the Month view.
    await press("k", { metaKey: true });
    const input = document.querySelector<HTMLInputElement>(".cmdk input");
    expect(input).not.toBeNull();
    await typeInto(input, "3 oct");
    const jump = [...document.querySelectorAll(".cmdk *")].find(
      (n) => n.children.length === 0 && n.textContent === "Calendar: go to Sat 3 Oct 2026",
    );
    expect(jump).not.toBeUndefined();
    await click(jump?.closest("button, [role='option']") ?? jump);
    await act(tick);
    expect(heading()).toBe("September to October 2026");
  });

  test("Agenda groups by day with answer buttons on the invite; Month opens a day", async () => {
    const source = fixtureCalendar({ calendars, events, invites });
    await mount(<Calendar source={source} now={NOW} initialView="agenda" />);
    const el = host as HTMLElement;
    const headings = [...el.querySelectorAll(".cal-ag-day")].map((s) => s.textContent);
    expect(headings[0]).toBe("Today, Thursday 17");
    expect(headings[1]).toBe("Tomorrow, Friday 18");
    const podcast = [...el.querySelectorAll(".cal-ag-row")].find((r) =>
      r.textContent?.includes("Podcast recording"),
    );
    expect(podcast?.textContent).toContain("Sofia Lindqvist");
    await click(button(podcast as Element, "Accept"));
    expect(source.log).toEqual(["respond podcast accepted"]);

    await click(button(el.querySelector(".seg") as Element, "Month"));
    const cells = [...el.querySelectorAll(".cal-mc")];
    expect(cells.length % 7).toBe(0);
    const day18 = cells.find(
      (c) => c.querySelector(".cal-md")?.textContent === "18" && !c.className.includes("outside"),
    );
    expect(day18?.textContent).toContain("Podcast recording");
    await click(day18?.querySelector(".cal-md"));
    expect(el.querySelectorAll(".cal-tg-dh")).toHaveLength(1);
    expect(el.querySelector(".col-head .count")?.textContent).toBe("Friday 18 September 2026");
  });

  test("an Account whose Calendar API is off says so, with the fix and Try again", async () => {
    const source = fixtureCalendar({
      calendars,
      events,
      invites,
      accounts: [
        { workspaceId: "ws", accountId: "acct", address: "tejas@genai-labs.io", current: true },
      ],
      statuses: [
        {
          workspaceId: "ws",
          accountId: "acct",
          source: "google",
          problem: {
            kind: "api-disabled",
            message:
              "Google Calendar API has not been used in project 123 before or it is disabled.",
            fixUrl:
              "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=123",
          },
          lastSync: null,
          checkedAt: NOW.toISOString(),
        },
      ],
    });
    const opened: string[] = [];
    await mount(<Calendar source={source} now={NOW} onOpenLink={(h) => opened.push(h)} />);
    await act(tick);
    const el = host as HTMLElement;
    const banner = el.querySelector(".cal-banner");
    expect(banner?.textContent).toContain("The calendar of tejas@genai-labs.io is turned off");
    expect(banner?.textContent).toContain("The Google Calendar API is not enabled");
    await click(button(banner as Element, "Enable Calendar API"));
    expect(opened).toEqual([
      "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=123",
    ]);
    await click(button(banner as Element, "Try again"));
    await act(tick);
    expect(source.log).toContain("retry ws");
    expect(el.querySelector(".cal-banner")).toBeNull();
  });

  test("search looks through titles, places and people", async () => {
    const source = fixtureCalendar({ calendars, events, invites });
    await mount(<Calendar source={source} now={NOW} />);
    const el = host as HTMLElement;
    await press("f", { ctrlKey: true });
    const input = el.querySelector<HTMLInputElement>(".cal-search input");
    expect(input).not.toBeNull();
    await typeInto(input, "sofia");
    const rows = [...el.querySelectorAll(".cal-results .cal-ag-row")];
    expect(rows.map((r) => r.querySelector("b")?.textContent)).toEqual(["Podcast recording"]);
    await typeInto(input, "nothing like it");
    expect(el.querySelector(".cal-results .cal-empty")?.textContent).toContain("Nothing matches");
  });

  test("the calendar list hides a calendar; Schedule hands the composer a sentence", async () => {
    const source = fixtureCalendar({ calendars, events, invites });
    const asked: string[] = [];
    await mount(<Calendar source={source} now={NOW} onAsk={(t) => asked.push(t)} />);
    const el = host as HTMLElement;
    const boxes = [...el.querySelectorAll<HTMLInputElement>(".cal-list input")];
    expect(boxes).toHaveLength(2);
    await click(boxes[1]);
    expect(source.log).toContain("visible cal-2 false");
    expect(el.querySelector(".cal-allday-cells .cal-bar")).toBeNull();
    await click(
      [...el.querySelectorAll(".col-head button")].find((b) => b.textContent?.includes("Schedule")),
    );
    expect(asked).toEqual(["Set up a call with "]);
  });

  test("Just mail: no agent bar and no Schedule handoff on the Calendar; both are back at assist", async () => {
    const source = fixtureCalendar({ calendars, events, invites });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const render = (level: "off" | "assist") =>
      act(async () => {
        root?.render(
          <StaticShell settings={{ "ai.level": level, "layout.agent": "bottom" }}>
            <Calendar source={source} now={NOW} onAsk={() => {}} />
          </StaticShell>,
        );
      });
    await render("off");
    await act(tick);
    const el = host as HTMLElement;
    expect(el.querySelector(".agent-dock")).toBeNull();
    expect(
      [...el.querySelectorAll(".col-head button")].some((b) => b.textContent?.includes("Schedule")),
    ).toBe(false);
    // The calendar itself is untouched: the views and the new Event button stay.
    expect(el.querySelectorAll(".cal-tg-dh")).toHaveLength(7);
    expect(button(el.querySelector(".col-head") as Element, "Event")).not.toBeNull();
    await render("assist");
    await act(tick);
    expect(el.querySelector(".agent-dock")).not.toBeNull();
    expect(
      [...el.querySelectorAll(".col-head button")].some((b) => b.textContent?.includes("Schedule")),
    ).toBe(true);
  });

  test("an answer the seam refuses shows why, in plain words", async () => {
    const source = fixtureCalendar({
      calendars,
      events,
      invites,
      fail: { respond: "the Provider is unreachable" },
    });
    await mount(<Calendar source={source} now={NOW} initialView="agenda" />);
    const el = host as HTMLElement;
    const podcast = [...el.querySelectorAll(".cal-ag-row")].find((r) =>
      r.textContent?.includes("Podcast recording"),
    );
    await click(button(podcast as Element, "Accept"));
    expect(el.querySelector(".cal-answer-error")?.textContent).toBe(
      "Could not send your answer: the Provider is unreachable",
    );
  });
});

describe("the invite bar", () => {
  test("shows the slot, the organizer, the overlap with Focus, and answers through the seam as an intent", async () => {
    const source = fixtureCalendar({
      calendars,
      events: [
        ...events,
        event({ id: "clash", title: "Focus block", start: at(18, 13, 30), end: at(18, 14, 30) }),
      ],
      invites,
    });
    await mount(<ThreadInviteBar calendar={source} threadId="t-podcast" settings={S} />);
    const el = host as HTMLElement;
    const bar = el.querySelector(".invite");
    expect(bar?.textContent).toContain("Podcast recording");
    expect(bar?.textContent).toContain("Fri 18 Sep, 13:00 to 14:00");
    expect(bar?.textContent).toContain("Sofia Lindqvist");
    expect(bar?.querySelector(".inv-c")?.textContent).toContain("Overlaps Focus block");
    expect(bar?.textContent).toContain("Your answer goes to Sofia Lindqvist by mail.");
    await click(
      [...(bar?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Accept"),
    );
    expect(source.log).toEqual(["rsvp inv-1 accepted"]);
    expect(el.querySelector(".invite .tag")?.textContent).toBe("Accepted");
  });

  test("the invite's own Event, not yet linked but holding the same uid, is not an overlap", async () => {
    // The Provider added the meeting to the calendar before the Server linked the Invite to it.
    const unlinked: Invite = {
      ...podcastInvite,
      id: "inv-4",
      threadId: "t-unlinked",
      eventId: null,
    };
    const source = fixtureCalendar({
      calendars,
      events: events.map((e) => (e.id === "podcast" ? { ...e, uid: "podcast@lindqvist" } : e)),
      invites: [unlinked],
    });
    await mount(<ThreadInviteBar calendar={source} threadId="t-unlinked" settings={S} />);
    const bar = (host as HTMLElement).querySelector(".invite");
    expect(bar?.textContent).toContain("Podcast recording");
    expect(bar?.querySelector(".inv-c")).toBeNull();
  });

  test("the invite's own Event, not yet linked but holding the same uid, is not an overlap", async () => {
    // The Provider added the meeting to the calendar before the Server linked the Invite to it.
    const unlinked: Invite = {
      ...podcastInvite,
      id: "inv-4",
      threadId: "t-unlinked",
      eventId: null,
    };
    const source = fixtureCalendar({
      calendars,
      events: events.map((e) => (e.id === "podcast" ? { ...e, uid: "podcast@lindqvist" } : e)),
      invites: [unlinked],
    });
    await mount(<ThreadInviteBar calendar={source} threadId="t-unlinked" settings={S} />);
    const bar = (host as HTMLElement).querySelector(".invite");
    expect(bar?.textContent).toContain("Podcast recording");
    expect(bar?.querySelector(".inv-c")).toBeNull();
  });

  test("a forged sender gets the warning and no buttons; a CANCEL shows cancelled", async () => {
    const forged: Invite = {
      ...podcastInvite,
      id: "inv-2",
      threadId: "t-forged",
      senderMismatch: true,
      eventId: null,
    };
    const cancel: Invite = {
      ...podcastInvite,
      id: "inv-3",
      threadId: "t-cancel",
      method: "CANCEL",
      receivedAt: new Date(NOW.getTime() + 1000).toISOString(),
    };
    await mount(
      <>
        <InviteBar invites={[forged]} overlaps={[]} strings={S} onRsvp={() => {}} />
        <InviteBar invites={[podcastInvite, cancel]} overlaps={[]} strings={S} onRsvp={() => {}} />
      </>,
    );
    const bars = [...(host as HTMLElement).querySelectorAll(".invite")];
    expect(bars[0]?.textContent).toContain("not the organizer");
    expect(bars[0]?.querySelectorAll("button")).toHaveLength(0);
    expect(bars[1]?.querySelector(".tag")?.textContent).toBe("Cancelled");
    expect(bars[1]?.querySelectorAll("button")).toHaveLength(0);
  });
});

describe("reminders", () => {
  test("the next reminder is the earliest Event start minus the lead, skipping declined and all-day ones", () => {
    const source = fixtureCalendar({ calendars, events });
    const next = nextReminder(
      source,
      10,
      new Date(2026, 8, 17, 14, 30),
      new Set(),
      (t, time) => `${t} at ${time}`,
    );
    expect(next?.title).toBe("Aoife Brennan, take-home");
    expect(next?.at.toISOString()).toBe(new Date(2026, 8, 17, 14, 50).toISOString());
    const later = nextReminder(source, 10, new Date(2026, 8, 17, 16, 0), new Set(), (t) => t);
    expect(later?.title).toBe("Standup");
  });

  test("an Event's own reminders replace the lead: each fires once, the earliest first", () => {
    const own = events.map((e) => (e.id === "aoife" ? { ...e, reminders: [60, 5] } : e));
    const source = fixtureCalendar({ calendars, events: own });
    const now = new Date(2026, 8, 17, 13, 50);
    const first = nextReminder(source, 10, now, new Set(), (t) => t);
    expect(first?.key).toBe("aoife#60");
    expect(first?.at.toISOString()).toBe(new Date(2026, 8, 17, 14, 0).toISOString());
    const second = nextReminder(source, 10, now, new Set(["aoife#60"]), (t) => t);
    expect(second?.key).toBe("aoife#5");
    expect(second?.at.toISOString()).toBe(new Date(2026, 8, 17, 14, 55).toISOString());
  });

  test("scheduleReminders fires the notification at the lead and re-arms", async () => {
    const source = fixtureCalendar({ calendars, events });
    const fired: string[] = [];
    let clock = new Date(2026, 8, 17, 14, 49, 59, 950);
    const stop = scheduleReminders(
      source,
      () => ({
        "notifications.enabled": true,
        "notifications.calendar_lead_minutes": 10,
        "strings.calendar.reminder": "{title} starts at {time}",
      }),
      { notify: async (title, body) => void fired.push(`${title}|${body}`) },
      () => clock,
    );
    await new Promise((r) => setTimeout(r, 80));
    clock = new Date(2026, 8, 17, 14, 50, 1);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatch(/^Aoife Brennan, take-home\|Aoife Brennan, take-home starts at /);
    stop();
  });

  test("an Event removed or declined before its reminder is not announced; the next one is armed instead; stop cancels all", async () => {
    const source = fixtureCalendar({ calendars, events });
    const fired: string[] = [];
    const clock = new Date(2026, 8, 17, 14, 49, 59, 950);
    const stop = scheduleReminders(
      source,
      () => ({
        "notifications.enabled": true,
        "notifications.calendar_lead_minutes": 10,
        "strings.calendar.reminder": "{title} starts at {time}",
      }),
      { notify: async (title) => void fired.push(title) },
      () => clock,
    );
    // Aoife's meeting at 15:00 is armed for 14:50; the user removes it first.
    await source.remove("aoife");
    await new Promise((r) => setTimeout(r, 80));
    expect(fired).toEqual([]);
    // The next candidate is tomorrow's podcast; declining it re-arms past it too.
    await source.respond("podcast", "declined");
    await new Promise((r) => setTimeout(r, 20));
    expect(fired).toEqual([]);
    stop();
    // After stop nothing fires, whatever the source does.
    await source.create({
      title: "Right away",
      start: new Date(2026, 8, 17, 14, 59).toISOString(),
      end: new Date(2026, 8, 17, 15, 30).toISOString(),
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(fired).toEqual([]);
  });
});
