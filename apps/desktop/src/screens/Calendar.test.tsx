/// <reference types="bun-types" />
// The Calendar screen, the invite bar and the reminders through the calendar
// seam (slice 18): Week and Agenda over fixture Events with a recurring
// master expanded on the client, the Today panel with the current Event
// marked and Join on the linked one, the calendar list's visibility switch,
// an Event added by hand, the Schedule handoff, the invite bar's Accept as
// an Outbox intent with the overlap line, and a reminder fired at the lead.

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

describe("the Calendar screen", () => {
  test("Week shows the week's Events with the Agent's marked, Today lists the current one with Join", async () => {
    const source = fixtureCalendar({ calendars, events, invites });
    const opened: string[] = [];
    await mount(<Calendar source={source} now={NOW} onOpenLink={(h) => opened.push(h)} />);
    const el = host as HTMLElement;
    expect(el.querySelector(".col-head .count")?.textContent).toBe("September 2026");
    expect(el.querySelectorAll(".cal-day")).toHaveLength(7);
    expect(el.querySelectorAll(".cal-day.today")).toHaveLength(1);
    const titles = [...el.querySelectorAll(".cal-col .ev b")].map((b) => b.textContent);
    expect(titles.filter((t) => t === "Standup")).toHaveLength(5);
    expect(titles).toContain("Aoife Brennan, take-home");
    const agentEvent = [...el.querySelectorAll(".cal-col .ev.agent")];
    expect(agentEvent).toHaveLength(1);
    expect(agentEvent[0]?.textContent).toContain("created by monday");
    // The Today panel: Focus is the current one at 14:20; Aoife's has Join.
    const rows = [...el.querySelectorAll(".today-panel .tp-row")];
    expect(rows.map((r) => r.querySelector("b")?.textContent)).toEqual([
      "Standup",
      "Focus",
      "Aoife Brennan, take-home",
    ]);
    expect(rows[1]?.className).toContain("now");
    await click(rows[2]?.querySelector("button"));
    expect(opened).toEqual(["https://meet.genai-labs.io/aoife"]);
  });

  test("Agenda groups by day with answer buttons on the tentative invite; Month opens a day", async () => {
    const source = fixtureCalendar({ calendars, events, invites });
    await mount(<Calendar source={source} now={NOW} initialView="agenda" />);
    const el = host as HTMLElement;
    const headings = [...el.querySelectorAll(".agenda .sec")].map((s) => s.textContent);
    expect(headings[0]).toBe("Today, Thursday 17");
    expect(headings[1]).toBe("Tomorrow, Friday 18");
    const podcast = [...el.querySelectorAll(".ag-row")].find((r) =>
      r.textContent?.includes("Podcast recording"),
    );
    expect(podcast?.textContent).toContain("Sofia Lindqvist");
    expect(podcast?.textContent).toContain("Not answered");
    await click(
      [...(podcast?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Accept"),
    );
    expect(source.log).toEqual(["respond podcast accepted"]);

    await click([...el.querySelectorAll(".seg button")].find((b) => b.textContent === "Month"));
    expect(el.querySelectorAll(".cal-mc")).toHaveLength(42);
    const day18 = [...el.querySelectorAll(".cal-mc")].find(
      (c) => c.querySelector(".cal-md")?.textContent === "18" && !c.className.includes("outside"),
    );
    expect(day18?.textContent).toContain("Podcast recording");
    await click(day18);
    expect(el.querySelectorAll(".cal-day")).toHaveLength(1);
    expect(el.querySelector(".cal-dh")?.textContent).toContain("Fri 18");
  });

  test("the calendar list hides a calendar; the form adds an Event; Schedule hands the composer a sentence", async () => {
    const source = fixtureCalendar({ calendars, events, invites });
    const asked: string[] = [];
    await mount(<Calendar source={source} now={NOW} onAsk={(t) => asked.push(t)} />);
    const el = host as HTMLElement;
    const boxes = [...el.querySelectorAll<HTMLInputElement>(".cal-list input")];
    expect(boxes).toHaveLength(2);
    await click(boxes[1]);
    expect(source.log).toContain("visible cal-2 false");

    await click(
      [...el.querySelectorAll(".col-head button")].find((b) => b.textContent?.trim() === "Event"),
    );
    const form = el.querySelector<HTMLFormElement>("form.cal-form");
    expect(form).not.toBeNull();
    await act(async () => {
      (form?.elements.namedItem("title") as HTMLInputElement).value = "Dentist";
      (form?.elements.namedItem("attendees") as HTMLInputElement).value = "";
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(tick);
    expect(source.log).toContain("create Dentist");
    expect(el.querySelector("form.cal-form")).toBeNull();

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
    // The calendar itself is untouched: the views, Today and the Event form stay.
    expect(el.querySelectorAll(".cal-day")).toHaveLength(7);
    expect(
      [...el.querySelectorAll(".col-head button")].some((b) => b.textContent?.trim() === "Event"),
    ).toBe(true);
    await render("assist");
    await act(tick);
    expect(el.querySelector(".agent-dock")).not.toBeNull();
    expect(
      [...el.querySelectorAll(".col-head button")].some((b) => b.textContent?.includes("Schedule")),
    ).toBe(true);
  });

  test("an Event whose end is not after its start is refused in plain words and nothing is created", async () => {
    const source = fixtureCalendar({ calendars, events, invites });
    await mount(<Calendar source={source} now={NOW} />);
    const el = host as HTMLElement;
    await click(
      [...el.querySelectorAll(".col-head button")].find((b) => b.textContent?.trim() === "Event"),
    );
    const form = el.querySelector<HTMLFormElement>("form.cal-form");
    if (!form) throw new Error("no form");
    await act(async () => {
      (form.elements.namedItem("title") as HTMLInputElement).value = "Backwards";
      (form.elements.namedItem("start") as HTMLInputElement).value = "2026-09-17T16:00";
      (form.elements.namedItem("end") as HTMLInputElement).value = "2026-09-17T15:00";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(tick);
    expect(source.log).toEqual([]);
    expect(el.querySelector(".cal-error")?.textContent).toBe(
      "The end has to come after the start.",
    );
    // Cancel closes the form and forgets the complaint.
    await click(
      [...form.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cancel"),
    );
    expect(el.querySelector("form.cal-form")).toBeNull();
    expect(el.querySelector(".cal-error")).toBeNull();
  });

  test("an answer from the Agenda that the seam refuses shows why, in plain words", async () => {
    const inner = fixtureCalendar({ calendars, events, invites });
    const source = {
      ...inner,
      respond: async () => {
        throw new Error("the Provider is unreachable");
      },
    };
    await mount(<Calendar source={source} now={NOW} initialView="agenda" />);
    const el = host as HTMLElement;
    const podcast = [...el.querySelectorAll(".ag-row")].find((r) =>
      r.textContent?.includes("Podcast recording"),
    );
    await click(
      [...(podcast?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Accept"),
    );
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
});
