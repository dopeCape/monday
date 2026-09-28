/// <reference types="bun-types" />
// The Filter menu on the screen: chips stack under the list header and
// combine, each removes itself, Escape takes the last one back, they outlive
// a remount in the session; the menu opens from its key and the palette; and
// over a Cache bigger than what the list holds, a Year, a Domain and Unread
// count and page from SQL. Also the list's dates: last year's mail shows the
// year. Mounted under a StaticShell with happy-dom.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { PartialSettings, Thread } from "@monday/shared";
import { threads as fixtureThreads } from "@monday/ui/fixtures";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { StaticShell } from "../shell/Shell.tsx";
import { Inbox, type InboxProps } from "./Inbox.tsx";
import { fixtureInbox } from "./inbox/actions.ts";
import {
  FILTER_NOW,
  FILTER_WINDOW,
  filterExpected,
  openFilterCache,
} from "./inbox/filter-fixture.ts";
import { filterListKey, resolveFilter } from "./inbox/list-filter.ts";

let createRoot: Awaited<ReturnType<typeof dom>>["createRoot"];
beforeAll(async () => {
  ({ createRoot } = await dom());
});

let root: Root | null = null;
let host: HTMLElement | null = null;
async function unmount() {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
}
afterEach(unmount);

const FIXTURE_NOW = new Date(2026, 8, 16, 10, 0);

async function mount(props: Partial<InboxProps> = {}, settings: PartialSettings = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  const data = props.inbox ?? fixtureInbox();
  await act(async () =>
    r.render(
      <StaticShell settings={{ "ai.level": "automate", ...settings }}>
        <Inbox
          now={FIXTURE_NOW}
          initialOpen={null}
          timing={{ collapse: 0, toast: 60_000 }}
          {...props}
          inbox={data}
        />
      </StaticShell>,
    ),
  );
  return data;
}

const tick = (ms = 5) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
async function until(check: () => boolean, what = "the screen") {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await tick();
  }
  throw new Error(`${what} did not settle`);
}

async function press(key: string, mods: Partial<KeyboardEventInit> = {}, on: EventTarget = window) {
  await act(async () => {
    on.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }),
    );
  });
}

async function type(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error("no input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const rowIds = () =>
  [...document.querySelectorAll<HTMLElement>(".list .row")].map((r) => r.dataset.thread ?? "");
const button = () => document.querySelector<HTMLButtonElement>(".list .filter-btn");
const menu = () => [...document.querySelectorAll<HTMLButtonElement>(".filter-pop .pop-item")];
const chips = () =>
  [...document.querySelectorAll<HTMLButtonElement>(".filter-chips .filter-chip")].map(
    (c) => c.textContent,
  );
const count = () => document.querySelector(".list .col-head .count")?.textContent;
const item = (label: string) => menu().find((b) => b.textContent?.startsWith(label));

async function choose(...path: string[]) {
  if (!document.querySelector(".filter-pop")) await act(async () => button()?.click());
  for (const label of path) {
    await until(() => item(label) !== undefined, `the menu item ${label}`);
    await act(async () => item(label)?.click());
  }
}

describe("the Filter menu's chips", () => {
  test("chips stack under the header, combine with AND, and each removes itself", async () => {
    await mount();
    await choose("Unread");
    expect(rowIds()).toEqual(["e1", "e2"]);
    expect(chips()).toEqual(["Unread"]);
    await choose("Starred");
    expect(rowIds()).toEqual(["e2"]);
    expect(chips()).toEqual(["Unread", "Starred"]);
    expect(button()?.textContent?.trim()).toBe("Filter2");
    // Unread is ticked in the menu, and picking it again takes it off.
    await act(async () => button()?.click());
    expect(item("Unread")?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => item("Unread")?.click());
    expect(chips()).toEqual(["Starred"]);
    // Clicking a chip removes it.
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".filter-chips .filter-chip")?.click(),
    );
    expect(chips()).toEqual([]);
    expect(rowIds().length).toBe(11);
  });

  test("Escape takes the last chip back, one at a time", async () => {
    await mount();
    await choose("Unread");
    await choose("Has attachments");
    expect(chips()).toEqual(["Unread", "Has attachments"]);
    await press("Escape");
    expect(chips()).toEqual(["Unread"]);
    await press("Escape");
    expect(chips()).toEqual([]);
    expect(rowIds().length).toBe(11);
  });

  test("Clear all lifts every chip", async () => {
    await mount();
    await choose("Unread");
    await choose("Starred");
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".filter-chips .filter-chips-clear")?.click(),
    );
    expect(chips()).toEqual([]);
  });

  test("the chips outlive a remount in the session, per Workspace", async () => {
    const data = await mount();
    await choose("Unread");
    await unmount();
    await mount({ inbox: data });
    expect(chips()).toEqual(["Unread"]);
    expect(rowIds()).toEqual(["e1", "e2"]);
    // Another lens of the same Workspace keeps them too.
    await unmount();
    await mount({ inbox: data, folder: "starred" });
    expect(chips()).toEqual(["Unread"]);
    // Another Workspace's mailbox starts with none.
    await unmount();
    await mount({ inbox: fixtureInbox() });
    expect(chips()).toEqual([]);
  });

  test("a person from the menu, typed ahead", async () => {
    await mount();
    await choose("Person");
    const search = document.querySelector<HTMLInputElement>(".filter-pop input[type=search]");
    expect(document.activeElement).toBe(search);
    await type(search, "kenji");
    await until(() => menu().length === 2, "the people");
    expect(menu()[1]?.textContent).toMatch(/^Kenji Watanabe\d+$/);
    await act(async () => menu()[1]?.click());
    expect(chips()).toEqual(["From Kenji Watanabe"]);
    expect(rowIds()).toContain("e2");
    expect(rowIds().length).toBeLessThan(11);
  });

  test("Date: this week, this month, or two days picked", async () => {
    await mount();
    await choose("Date", "Pick dates");
    const [from, to] = [
      ...document.querySelectorAll<HTMLInputElement>(".filter-pop .pop-dates input"),
    ];
    await type(from as HTMLInputElement, "2026-09-13");
    await type(to as HTMLInputElement, "2026-09-14");
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".filter-pop .pop-dates .btn")?.click(),
    );
    expect(chips()).toEqual(["Sep 13 to Sep 14"]);
    expect(rowIds()).toEqual(["e6", "e7", "e8", "e9"]);
  });

  test("the Filter key and the palette open the menu", async () => {
    await mount();
    await press("F", { shiftKey: true });
    expect(document.querySelector(".filter-pop")).not.toBeNull();
    await press("Escape", {}, document.querySelector(".filter-pop") as HTMLElement);
    await until(() => document.querySelector(".filter-pop") === null, "the menu closing");
    await press("k", { ctrlKey: true });
    const input = document.querySelector<HTMLInputElement>(".cmdk input");
    await type(input, "Filter the list");
    await press("Enter", {}, input as HTMLInputElement);
    await until(() => document.querySelector(".filter-pop") !== null, "the menu from the palette");
  });
});

describe("the Filter menu over a Cache bigger than the list holds", () => {
  test("a Year counts and pages from SQL, Unread narrows it further", async () => {
    const { inbox } = await openFilterCache();
    try {
      await mount({ inbox, now: FILTER_NOW });
      expect(rowIds().length).toBeLessThanOrEqual(FILTER_WINDOW);
      await choose("Year");
      await until(() => menu().length === 4, "the years");
      expect(menu().map((b) => b.textContent)).toEqual(["Back", "202630", "202530", "202430"]);
      await choose("2025");
      await until(() => count() === "30", "the year's total");
      expect(chips()).toEqual(["2025"]);
      const in2025 = filterExpected((i) => i >= 30 && i < 60);
      await until(() => rowIds()[0] === in2025[0], "the year's rows");
      expect(rowIds().every((id) => in2025.includes(id))).toBe(true);
      // The list holds a window; walking down reads the next one.
      const key = filterListKey(
        "inbox",
        resolveFilter([{ kind: "year", year: 2025 }], FILTER_NOW, true),
      );
      expect(inbox.list(key)).toHaveLength(FILTER_WINDOW);
      await press("j");
      await until(() => inbox.list(key).length === 2 * FILTER_WINDOW, "the next page");
      expect(inbox.list(key).map((t) => t.id)).toEqual(in2025.slice(0, 2 * FILTER_WINDOW));
      await choose("Unread");
      await until(() => count() === "15", "the year's unread");
      expect(chips()).toEqual(["2025", "Unread"]);
    } finally {
      await unmount();
      inbox.close();
    }
  });

  test("a Domain typed ahead, with its count over the whole Cache", async () => {
    const { inbox } = await openFilterCache();
    try {
      await mount({ inbox, now: FILTER_NOW });
      await choose("Domain");
      await type(
        document.querySelector<HTMLInputElement>(".filter-pop input[type=search]"),
        "glob",
      );
      await until(
        () => menu().length === 2 && menu()[1]?.textContent === "globex.io30",
        "the domain",
      );
      await act(async () => menu()[1]?.click());
      await until(() => count() === "30", "the domain's total");
      expect(chips()).toEqual(["From @globex.io"]);
      const carol = filterExpected((i) => i % 3 === 2);
      await until(() => rowIds()[0] === carol[0], "the domain's rows");
      expect(rowIds().every((id) => carol.includes(id))).toBe(true);
    } finally {
      await unmount();
      inbox.close();
    }
  });
});

describe("the list's dates", () => {
  test("mail from an earlier year shows its year; this year's does not", async () => {
    const base = fixtureThreads[10] as Thread;
    const old: Thread = {
      ...base,
      id: "old",
      lastActivity: new Date(2025, 2, 12, 9).toISOString(),
    };
    const spring: Thread = {
      ...base,
      id: "spring",
      lastActivity: new Date(2026, 2, 12, 9).toISOString(),
    };
    await mount({ inbox: fixtureInbox([...fixtureThreads, spring, old]) });
    const time = (id: string) =>
      document.querySelector(`.row[data-thread=${id}] .time`)?.textContent;
    expect(time("old")).toBe("Mar 12, 2025");
    expect(time("spring")).toBe("Mar 12");
    expect(time("e1")).toBe("09:41");
  });
});
