/// <reference types="bun-types" />
// The Calendar's second batch through the screen: monday's own dropdown,
// date and time fields in the quick create, guest suggestions from the mail
// and earlier Events, the calendar list's groups with shared calendars and
// its hover actions, and a calendar draft from the Agent laid over the week
// with its bar, the review list, apply some with the ask before guests are
// emailed, and Undo; and the draft card in the conversation.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { CalendarDraft, CalendarEvent, Calendar as CalendarRow } from "@monday/shared";
import { defaultSettings } from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { CalendarDraftPreview } from "../calendar/DraftCard.tsx";
import { CalendarDraftsProvider } from "../calendar/DraftsContext.tsx";
import { createDraftStore, type DraftStore, memoryDraftMemory } from "../calendar/drafts.ts";
import { StaticShell } from "../shell/Shell.tsx";
import { Calendar } from "./Calendar.tsx";
import { type CalendarSource, fixtureCalendar } from "./calendar/calendar-data.ts";

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
  for (const el of [
    ...document.body.querySelectorAll(".cal-pop, .cal-float, .cal-dialog-scrim, .cal-editor-scrim"),
  ])
    el.remove();
});

const NOW = new Date(2026, 8, 17, 14, 20); // Thursday
const at = (day: number, h: number, m = 0) => new Date(2026, 8, day, h, m).toISOString();
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const cal = (id: string, over: Partial<CalendarRow> = {}): CalendarRow => ({
  id,
  workspaceId: "ws-genai",
  source: "google",
  providerId: id,
  name: id,
  primary: false,
  writable: true,
  visible: true,
  color: null,
  ...over,
});

const calendars = [
  cal("work", { name: "Work", primary: true }),
  cal("side", { name: "Side project" }),
  cal("team", {
    name: "Team",
    writable: false,
    access: "reader",
    sharedBy: { name: "Kenji", email: "kenji@northwind.test" },
  }),
  cal("broken", { name: "Holidays", error: "403 forbidden" }),
];

function event(
  id: string,
  title: string,
  start: string,
  end: string,
  over: Partial<CalendarEvent> = {},
): CalendarEvent {
  return {
    id,
    workspaceId: "ws-genai",
    calendarId: "work",
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
    ...over,
  };
}

const events = [
  event("review", "Design review", at(15, 13), at(15, 14), {
    attendees: [
      {
        name: "Tejas",
        email: "tejas@genai-labs.io",
        response: "accepted",
        self: true,
        organizer: true,
      },
      { name: "Mateus Silva", email: "mateus@genai-labs.io", response: "accepted" },
    ],
  }),
  event("sync", "Weekly sync", at(16, 10), at(16, 10, 30)),
  event("offsite", "Offsite", at(18, 9), at(18, 17), { calendarId: "team" }),
];

async function mount(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<StaticShell settings={{ "ai.level": "assist" }}>{node}</StaticShell>);
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
const pointerDown = async (el: Element | null | undefined) => {
  if (!el) throw new Error("nothing to press");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
  });
  await act(tick);
};
const typeInto = async (input: Element | null | undefined, value: string) => {
  if (!input) throw new Error("no input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(tick);
};
const key = async (el: Element | null | undefined, k: string) => {
  await act(async () => {
    el?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
  await act(tick);
};
const button = (root: ParentNode | null | undefined, text: string) =>
  [...(root ?? document).querySelectorAll("button")].find((b) => b.textContent?.trim() === text) ??
  null;

describe("the quick create's own controls", () => {
  test("the calendar dropdown, the date grid and the time list, never the browser's", async () => {
    const source = fixtureCalendar({ calendars, events });
    await mount(<Calendar source={source} now={NOW} />);
    await click(button(host?.querySelector(".col-head"), "Event"));
    const form = document.querySelector(".cal-quick");
    expect(form?.querySelectorAll("select, input[type='date'], input[type='time']")).toHaveLength(
      0,
    );
    // The calendar: a list of the writable ones only.
    await click(form?.querySelector('button[aria-label="Calendar"]'));
    const options = [...document.querySelectorAll(".cal-float [role='option']")].map(
      (o) => o.textContent,
    );
    expect(options).toEqual(["Work", "Side project", "Holidays"]);
    await click(
      [...document.querySelectorAll(".cal-float [role='option']")].find(
        (o) => o.textContent === "Side project",
      ),
    );
    expect(form?.querySelector('button[aria-label="Calendar"]')?.textContent).toContain(
      "Side project",
    );
    // The date: a month grid; the 18th picked.
    await click(form?.querySelector('button[aria-label="Start date"]'));
    await click(
      document.querySelector(
        `.cal-date-pop button[aria-label="${new Date(2026, 8, 18).toDateString()}"]`,
      ),
    );
    expect(form?.querySelector('button[aria-label="Start date"]')?.textContent).toBe("Fri 18 Sep");
    // The time: the day's times on the snap step; 16:00 picked, the end follows.
    const start = form?.querySelector<HTMLInputElement>('input[aria-label="Start"]');
    await act(async () => {
      start?.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
      start?.focus();
    });
    await act(tick);
    const sixteen = [...document.querySelectorAll(".cal-time-pop [role='option']")].find((o) =>
      o.textContent?.startsWith("16:00"),
    );
    await pointerDown(sixteen);
    expect(start?.value).toBe("16:00");
    expect(form?.querySelector<HTMLInputElement>('input[aria-label="End"]')?.value).toBe("16:30");
  });

  test("guests are suggested from the mail and earlier Events; arrows and Enter pick one", async () => {
    const source = fixtureCalendar({ calendars, events });
    await mount(
      <Calendar
        source={source}
        now={NOW}
        people={[{ name: "Aoife Brennan", email: "aoife@northwind.test" }]}
      />,
    );
    await click(button(host?.querySelector(".col-head"), "Event"));
    const form = document.querySelector(".cal-quick");
    await click(button(form, "Add guests"));
    const input = form?.querySelector<HTMLInputElement>(".cal-people-input");
    await act(async () => {
      input?.dispatchEvent(new FocusEvent("focus"));
      input?.focus();
    });
    await typeInto(input, "a");
    const names = () =>
      [...document.querySelectorAll(".cal-suggest .cal-suggest-name")].map((n) => n.textContent);
    // The person from the mail first, then one from an earlier Event.
    expect(names()).toEqual(["Aoife Brennan", "Mateus Silva"]);
    await key(input, "ArrowDown");
    await key(input, "Enter");
    expect(
      [...(form?.querySelectorAll(".cal-chip") ?? [])].map((c) => c.getAttribute("title")),
    ).toEqual(["mateus@genai-labs.io"]);
  });
});

describe("the calendar list", () => {
  test("mine, then shared with me; a calendar that cannot be read says so; show only this", async () => {
    const source = fixtureCalendar({ calendars, events });
    await mount(<Calendar source={source} now={NOW} />);
    const el = host as HTMLElement;
    const heads = [...el.querySelectorAll(".cal-list-account span:first-child")].map(
      (h) => h.textContent,
    );
    expect(heads).toEqual(["My calendars", "Shared with me"]);
    const team = [...el.querySelectorAll(".cal-list-row")].find((r) =>
      r.textContent?.includes("Team"),
    );
    expect(team?.textContent).toContain("Shared by Kenji");
    const broken = [...el.querySelectorAll(".cal-list-row")].find((r) =>
      r.textContent?.includes("Holidays"),
    );
    expect(broken?.className).toContain("err");
    const titles = () => [...el.querySelectorAll(".cal-block b")].map((b) => b.textContent);
    expect(titles()).toContain("Offsite");
    const work = [...el.querySelectorAll(".cal-list-row")].find((r) =>
      r.textContent?.includes("Work"),
    );
    await click(work?.querySelector('button[title="Show only this"]'));
    expect(titles()).not.toContain("Offsite");
    expect([...el.querySelectorAll(".cal-list-row.off")].length).toBe(3);
    await click(button(el, "Show all"));
    expect(titles()).toContain("Offsite");
  });
});

function planDraft(): CalendarDraft {
  return {
    id: "plan-1",
    workspaceId: "ws-genai",
    title: "Your week, planned",
    summary: "Two focus blocks, the review moved, the sync dropped",
    from: at(14, 0),
    to: at(19, 0),
    createdAt: NOW.toISOString(),
    changes: [
      {
        id: "c1",
        kind: "create",
        before: null,
        after: { title: "Focus: pricing", start: at(17, 9), end: at(17, 11), allDay: false },
        guests: [],
        reason: "Your mornings are free",
      },
      {
        id: "c2",
        kind: "update",
        eventId: "review",
        before: { title: "Design review", start: at(15, 13), end: at(15, 14), allDay: false },
        after: { title: "Design review", start: at(15, 15), end: at(15, 16), allDay: false },
        guests: [{ name: "Mateus Silva", email: "mateus@genai-labs.io" }],
      },
      {
        id: "c3",
        kind: "delete",
        eventId: "sync",
        before: { title: "Weekly sync", start: at(16, 10), end: at(16, 10, 30), allDay: false },
        after: null,
        guests: [],
      },
    ],
  };
}

function withDrafts(source: CalendarSource): {
  store: DraftStore;
  shown: string[];
  wrap: (n: ReactNode) => ReactNode;
} {
  const store = createDraftStore({
    source,
    memory: memoryDraftMemory(),
    defaultCalendar: () => "work",
  });
  const shown: string[] = [];
  return {
    store,
    shown,
    wrap: (n) => (
      <StaticShell settings={{ "ai.level": "assist" }}>
        <CalendarDraftsProvider
          store={store}
          settings={defaultStrings()}
          onShow={(d) => shown.push(d.id)}
        >
          {n}
        </CalendarDraftsProvider>
      </StaticShell>
    ),
  };
}

const defaultStrings = () => defaultSettings();

async function mountWrapped(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(node);
  });
  await act(tick);
}

describe("a calendar draft from the Agent", () => {
  test("laid over the week like a diff; review, leave one out, apply the rest with the ask; Undo", async () => {
    const source = fixtureCalendar({ calendars, events });
    const d = withDrafts(source);
    await d.store.offer(planDraft());
    await mountWrapped(d.wrap(<Calendar source={source} now={NOW} initialView="week" />));
    const el = host as HTMLElement;
    const bar = el.querySelector(".cal-draft-bar");
    expect(bar?.textContent).toContain("Your week, planned");
    expect(bar?.textContent).toContain("1 to add · 1 to change · 1 to remove");
    // The diff on the grid.
    const titled = (cls: string) =>
      [...el.querySelectorAll(`.cal-block.${cls} b`)].map((b) => b.textContent);
    expect(titled("draft-add")).toEqual(["Focus: pricing"]);
    expect(titled("draft-before")).toEqual(["Design review"]);
    expect(titled("draft-after")).toEqual(["Design review"]);
    expect(titled("draft-delete")).toEqual(["Weekly sync"]);
    // Review, and leave the removal out.
    await click(button(bar, "Review"));
    const boxes = [
      ...el.querySelectorAll<HTMLInputElement>(".cal-draft-review input[type='checkbox']"),
    ];
    expect(boxes).toHaveLength(3);
    await click(boxes[2]);
    expect(titled("draft-delete")).toEqual([]);
    await click(button(el.querySelector(".cal-draft-bar"), "Apply 2"));
    // The review moves with a guest: ask first.
    const dialog = document.querySelector(".cal-dialog");
    expect(dialog?.textContent).toContain("Mateus Silva will get an email about this.");
    expect(source.log).toEqual([]);
    await click(button(dialog, "Send"));
    await act(tick);
    expect(source.log).toEqual(["create Focus: pricing", "update review end,start"]);
    expect(d.store.get("plan-1")?.status).toBe("partial");
    expect(document.querySelector(".toast")?.textContent).toContain("Applied 2 changes");
    // Undo takes both back.
    await click(document.querySelector(".toast button"));
    await act(tick);
    expect(source.log.slice(2)).toEqual(["update review end,start", "remove ev-4"]);
  });

  test("the card in the conversation: the counts, the lines, Show on the calendar, Apply all", async () => {
    const source = fixtureCalendar({ calendars, events });
    const d = withDrafts(source);
    await mountWrapped(d.wrap(<CalendarDraftPreview draft={planDraft()} />));
    await act(tick);
    const card = (host as HTMLElement).querySelector(".cal-draft-card");
    expect(card?.textContent).toContain("1 to add · 1 to change · 1 to remove");
    expect(
      [...(card?.querySelectorAll(".cal-draft-lines li") ?? [])].map((l) => l.className),
    ).toEqual(["create", "update", "delete"]);
    // Offered on mount: a fresh draft becomes the active one.
    expect(d.store.active()).toBe("plan-1");
    await click(button(card, "Show on the calendar"));
    expect(d.shown).toEqual(["plan-1"]);
    await click(button(card, "Apply all"));
    await click(button(document.querySelector(".cal-dialog"), "Send"));
    await act(tick);
    expect(source.log).toEqual(["create Focus: pricing", "update review end,start", "remove sync"]);
    expect(card?.textContent).toContain("Applied");
  });
});
