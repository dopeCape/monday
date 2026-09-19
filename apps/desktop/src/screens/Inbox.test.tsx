/// <reference types="bun-types" />
// The Inbox screen through its interface: keys in, InboxActions calls and
// DOM out. Mounted under a StaticShell over the fixtures with happy-dom.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { PartialSettings, Thread } from "@monday/shared";
import { threads as fixtureThreads } from "@monday/ui/fixtures";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { StaticShell } from "../shell/Shell.tsx";
import { Inbox, type InboxProps } from "./Inbox.tsx";
import { fixtureInbox, type InboxActions, type Inbox as InboxData } from "./inbox/actions.ts";

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

/** Wraps an inbox so tests can see which actions ran. */
function spy(inbox: InboxData): { inbox: InboxData; calls: string[] } {
  const calls: string[] = [];
  const wrap =
    <K extends keyof InboxActions>(name: K) =>
    (...args: Parameters<InboxActions[K]>) => {
      calls.push(`${name}:${JSON.stringify(args[0])}`);
      // biome-ignore lint/suspicious/noExplicitAny: forwarding to the same signature
      return (inbox[name] as any)(...args);
    };
  return {
    calls,
    inbox: {
      threads: inbox.threads,
      thread: inbox.thread,
      groups: inbox.groups,
      tags: inbox.tags,
      subscribe: inbox.subscribe,
      messages: inbox.messages,
      watchMessages: inbox.watchMessages,
      openThread: inbox.openThread,
      brief: inbox.brief,
      requestBrief: inbox.requestBrief,
      attachmentBytes: inbox.attachmentBytes,
      archive: wrap("archive"),
      unarchive: wrap("unarchive"),
      snooze: wrap("snooze"),
      star: wrap("star"),
      unstar: wrap("unstar"),
      markRead: wrap("markRead"),
      markUnread: wrap("markUnread"),
      moveToGroup: wrap("moveToGroup"),
      delete: wrap("delete"),
      undo: wrap("undo"),
    },
  };
}

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
          now={new Date(2026, 8, 16, 10, 0)}
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

async function press(key: string, mods: Partial<KeyboardEventInit> = {}, target?: EventTarget) {
  await act(async () => {
    (target ?? window).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }),
    );
  });
}

const rows = () => [...document.querySelectorAll<HTMLElement>(".row")];
const rowIds = () => rows().map((r) => r.dataset.thread);
const focusRow = () => document.querySelector<HTMLElement>(".row.on")?.dataset.thread ?? null;
const picked = () =>
  [...document.querySelectorAll<HTMLElement>(".row.picked")].map((r) => r.dataset.thread);
const toast = () => document.querySelector(".toast")?.textContent ?? null;
const reader = () => document.querySelector<HTMLElement>(".reader")?.dataset.thread ?? null;

describe("Inbox rendering", () => {
  test("renders the Sections in order with a focus row on the first Thread", async () => {
    await mount();
    expect([...document.querySelectorAll(".sec")].map((s) => s.textContent)).toEqual([
      "Needs your reply",
      "Waiting on you",
      "For your information",
      "Newsletters",
    ]);
    expect(rowIds()).toEqual(["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "e10", "e11"]);
    expect(focusRow()).toBe("e1");
    expect(reader()).toBeNull();
  });

  test("Section names and order come from Settings, and an empty Section is not rendered", async () => {
    await mount(
      {},
      { "sections.order": ["newsletters", "waiting"], "strings.section.waiting": "Pending" },
    );
    expect([...document.querySelectorAll(".sec")].map((s) => s.textContent)).toEqual([
      "Newsletters",
      "Pending",
    ]);
    expect(rowIds()).toEqual(["e10", "e11", "e4", "e5"]);
  });

  test("a user-defined Section renders from its rule; a hidden rule hides its Section", async () => {
    const custom = fixtureInbox([
      { ...fixtureThreads[0], id: "p1", section: "projects" } as Thread,
      { ...fixtureThreads[3], id: "w1", section: "waiting" } as Thread,
    ]);
    await mount(
      { inbox: custom },
      {
        "sections.order": ["projects", "waiting"],
        "sections.rules": [
          { id: "projects", when: { groups: ["hiring"] } },
          { id: "waiting", when: { lastFrom: "others" }, hidden: true },
        ],
      },
    );
    // No strings.section.projects Setting: the id reads as a heading.
    expect([...document.querySelectorAll(".sec")].map((s) => s.textContent)).toEqual(["Projects"]);
    expect(rowIds()).toEqual(["p1"]);
  });

  test("a Group lens shows only that Group's Threads under the Group's name", async () => {
    await mount({ group: "hiring" });
    expect(document.querySelector(".col-head h2")?.textContent).toBe("Hiring");
    expect(rowIds()).toEqual(["e1", "e3"]);
    expect(document.querySelector(".col-head .count")?.textContent).toBe("2");
  });

  test("row labels and the move picker come from the seam's Tags and Groups, not the fixtures", async () => {
    const custom = fixtureInbox([{ ...fixtureThreads[0], tags: ["t-mine"] } as Thread], {
      tags: [{ id: "t-mine", workspaceId: "ws", name: "Mine" }],
      groups: [
        {
          id: "g-only",
          workspaceId: "ws",
          parentId: null,
          name: "Only group",
          rule: { sentence: "", predicate: {}, prompt: "" },
          threshold: null,
          briefPolicy: null,
        },
      ],
    });
    await mount({ inbox: custom });
    expect(document.querySelector(".row .lbl")?.textContent).toBe("Mine");
    await press("m");
    expect(
      [...document.querySelectorAll(".pop-item span:first-child")].map((s) => s.textContent),
    ).toEqual(["Only group", "No group"]);
  });

  test("without a pinned clock the rows read the Workspace's clock, the design fixture's here", async () => {
    await mount({ now: undefined });
    // e1 was written at 09:41 on the fixtures' day, which the fixture Workspace's clock makes today.
    expect(document.querySelector(".row .time")?.textContent).toBe("09:41");
  });

  test("an empty Inbox shows one line from Settings and nothing else", async () => {
    await mount({ inbox: fixtureInbox([]) }, { "strings.inbox.empty": "All clear" });
    expect(document.querySelector(".empty-line")?.textContent).toBe("All clear");
    expect(document.querySelectorAll(".sec").length).toBe(0);
    expect(rows().length).toBe(0);
  });

  test("first sync shows the thin progress line with the counts", async () => {
    await mount({ inbox: fixtureInbox([]), syncing: { done: 1204, total: 12418 } });
    const line = document.querySelector<HTMLElement>(".sync");
    expect(line?.textContent).toBe("Syncing, 1,204 of 12,418");
    expect(document.querySelector<HTMLElement>(".sync .bar")?.style.width).toBe("9.70%");
    expect(document.querySelector(".empty-line")).toBeNull();
  });

  test("offline changes the agent bar's line", async () => {
    await mount({ online: false });
    expect(document.querySelector("input[name=ask]")?.getAttribute("placeholder")).toBe(
      "Offline, hosted work paused",
    );
  });

  test("row fields from Settings reach the list as a data attribute", async () => {
    await mount(
      {},
      {
        "inbox.rows": {
          compact: { stream: ["dot", "sender", "subject"], split: ["dot"] },
          comfortable: { stream: ["dot", "sender", "subject", "time"], split: ["dot"] },
          spacious: { stream: ["dot"], split: ["dot"] },
        },
      },
    );
    expect(document.querySelector(".list")?.getAttribute("data-fields")).toBe(
      "dot sender subject time",
    );
  });
});

describe("keyboard triage", () => {
  test("J and K move the focus row; Enter opens the reader; Escape closes it", async () => {
    await mount();
    await press("j");
    expect(focusRow()).toBe("e2");
    await press("j");
    expect(focusRow()).toBe("e3");
    await press("k");
    expect(focusRow()).toBe("e2");
    await press("Enter");
    expect(reader()).toBe("e2");
    await press("Escape");
    expect(reader()).toBeNull();
  });

  test("E archives the focus row, advances to the next and shows an undo toast", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    await mount({ inbox });
    await press("e");
    expect(calls).toEqual(['archive:["e1"]']);
    expect(rowIds()).not.toContain("e1");
    expect(focusRow()).toBe("e2");
    expect(toast()).toContain("Archived");
    expect(toast()).toContain("Undo");
  });

  test("the direction Setting moves the focus to the previous row", async () => {
    await mount({}, { "inbox.after_action.direction": "previous" });
    await press("j");
    await press("j");
    expect(focusRow()).toBe("e3");
    await press("#", { shiftKey: true });
    expect(rowIds()).not.toContain("e3");
    expect(focusRow()).toBe("e2");
  });

  test("Z undoes the last action and the row comes back", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    await mount({ inbox });
    await press("e");
    expect(rowIds()).not.toContain("e1");
    await press("z");
    expect(calls[1]).toMatch(/^undo:/);
    expect(rowIds()[0]).toBe("e1");
    expect(toast()).toBe("Undone");
  });

  test("the toast's Undo button undoes too", async () => {
    await mount();
    await press("e");
    await act(async () => document.querySelector<HTMLButtonElement>(".toast .btn")?.click());
    expect(rowIds()[0]).toBe("e1");
  });

  test("a row collapses with a transition before it leaves the list", async () => {
    await mount({ timing: { collapse: 30, toast: 60_000 } });
    await press("e");
    expect(rows()[0]?.classList.contains("leaving")).toBe(true);
    expect(rowIds()).toContain("e1");
    await act(async () => Bun.sleep(60));
    expect(rowIds()).not.toContain("e1");
  });

  test("S stars the focus row and again unstars it", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    await mount({ inbox });
    await press("s");
    expect(calls).toEqual(['star:["e1"]']);
    expect(toast()).toContain("Starred");
    await press("s");
    expect(calls[1]).toBe('unstar:["e1"]');
  });

  test("H opens the snooze picker with the presets, and Enter snoozes to the first", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    await mount({ inbox });
    await press("h");
    const items = [...document.querySelectorAll(".pop .pop-item")].map((i) => i.textContent);
    expect(items).toEqual([
      "Later today13:00",
      "Tomorrow morningTomorrow 08:00",
      "Next weekMon 08:00",
      "Pick a time",
    ]);
    await press("Enter", {}, document.querySelector(".pop") ?? window);
    expect(calls[0]).toMatch(/^snooze:\["e1"\]/);
    expect(rowIds()).not.toContain("e1");
    expect(toast()).toBe("Snoozed until 13:00Undo Z");
  });

  test("the snooze picker only offers the presets in Settings and pick a time takes a date", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    await mount({ inbox }, { "inbox.snooze_presets": ["pick-a-time", "next-week"] });
    await press("h");
    expect(
      [...document.querySelectorAll(".pop .pop-item span:first-child")].map((i) => i.textContent),
    ).toEqual(["Pick a time", "Next week"]);
    await act(async () => document.querySelector<HTMLButtonElement>(".pop .pop-item")?.click());
    const input = document.querySelector<HTMLInputElement>(".pop input");
    expect(input?.value).toBe("2026-09-17T08:00");
    if (input) input.value = "2026-09-18T15:30";
    await act(async () => document.querySelector<HTMLButtonElement>(".pop .btn")?.click());
    expect(calls[0]).toMatch(/^snooze:\["e1"\]/);
    expect(inbox.thread("e1")?.snoozedUntil).toBe(new Date(2026, 8, 18, 15, 30).toISOString());
  });

  test("M moves the focus row to a Group", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    await mount({ inbox });
    await press("m");
    const finance = [...document.querySelectorAll<HTMLButtonElement>(".pop .pop-item")].find((b) =>
      b.textContent?.includes("Finance"),
    );
    await act(async () => finance?.click());
    expect(calls).toEqual(['moveToGroup:["e1"]']);
    expect(inbox.thread("e1")?.group).toBe("finance");
    expect(toast()).toContain("Moved to Finance");
  });

  test("keys are ignored while typing in an input", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    await mount({ inbox });
    const input = document.querySelector<HTMLInputElement>("input[name=ask]");
    expect(input).not.toBeNull();
    await act(async () => input?.focus());
    await press("e", {}, input ?? window);
    await press("j", {}, input ?? window);
    await press("#", { shiftKey: true }, input ?? window);
    expect(calls).toEqual([]);
    expect(focusRow()).toBe("e1");
    expect(rowIds()).toContain("e1");
  });

  test("the keymap Setting and bindings change what a key does", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    await mount(
      { inbox },
      { "keyboard.keymap": "gmail", "keyboard.bindings": { "thread.archive": "y" } },
    );
    await press("e");
    expect(calls).toEqual([]);
    await press("y");
    expect(calls).toEqual(['archive:["e1"]']);
    await press("b");
    expect(document.querySelector(".pop")).not.toBeNull();
  });

  test("Cmd-K toggles the palette and Cmd-N applies a saved View", async () => {
    await mount(
      {},
      {
        "views.list": [
          {
            id: "v1",
            name: "Focus",
            shortcut: "mod+1",
            layout: { nav: "hidden", agent: "right", list: "split" },
          },
        ],
      },
    );
    await press("k", { metaKey: true });
    expect(document.querySelector(".cmdk")).not.toBeNull();
    await press("Escape");
    expect(document.querySelector(".cmdk")).toBeNull();
    await press("1", { ctrlKey: true });
    // Split list: the reader is always shown.
    expect(reader()).toBe("e1");
    expect(document.querySelector(".reader.sheet")).toBeNull();
  });
});

describe("multi-select and batches", () => {
  test("X toggles rows into the selection and Shift-J extends it", async () => {
    await mount();
    await press("x");
    expect(picked()).toEqual(["e1"]);
    await press("J", { shiftKey: true });
    await press("J", { shiftKey: true });
    expect(picked()).toEqual(["e1", "e2", "e3"]);
    expect(focusRow()).toBe("e3");
    expect(document.querySelector(".col-head .count")?.textContent).toBe("3 selected");
    await press("x");
    expect(picked()).toEqual(["e1", "e2"]);
    await press("Escape");
    expect(picked()).toEqual([]);
  });

  test("an action applies to every selected Thread and clears the selection", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    await mount({ inbox });
    await press("x");
    await press("J", { shiftKey: true });
    await press("J", { shiftKey: true });
    await press("e");
    expect(calls).toEqual(['archive:["e1","e2","e3"]']);
    expect(rowIds()).toEqual(["e4", "e5", "e6", "e7", "e8", "e9", "e10", "e11"]);
    expect(focusRow()).toBe("e4");
    expect(picked()).toEqual([]);
    expect(toast()).toBe("Archived, 3 threadsUndo Z");
  });

  test("a batch above the Setting previews first, and Apply runs it", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    await mount({ inbox }, { "inbox.batch_preview_above": 2 });
    await press("x");
    await press("J", { shiftKey: true });
    await press("J", { shiftKey: true });
    await press("e");
    expect(calls).toEqual([]);
    const dialog = document.querySelector(".batch");
    expect(dialog?.querySelector(".batch-h")?.textContent).toBe("Archive 3 threads?");
    expect(dialog?.querySelectorAll(".batch-row").length).toBe(3);
    await press("Escape");
    expect(document.querySelector(".batch")).toBeNull();
    expect(calls).toEqual([]);
    await press("e");
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".batch .btn.primary")?.click(),
    );
    expect(calls).toEqual(['archive:["e1","e2","e3"]']);
    expect(rowIds()).not.toContain("e3");
  });

  test("a batch at the threshold runs without a preview", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    await mount({ inbox }, { "inbox.batch_preview_above": 3 });
    await press("x");
    await press("J", { shiftKey: true });
    await press("J", { shiftKey: true });
    await press("e");
    expect(document.querySelector(".batch")).toBeNull();
    expect(calls).toEqual(['archive:["e1","e2","e3"]']);
  });

  test("mark-all-read from the More menu is one undoable action", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    await mount({ inbox });
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".list .col-head .btn.icon")?.click(),
    );
    await act(async () => document.querySelector<HTMLButtonElement>(".pop .pop-item")?.click());
    expect(calls).toEqual(['markRead:["e1","e2"]']);
    expect(document.querySelectorAll(".row.unread").length).toBe(0);
    expect(toast()).toBe("Marked read, 2 threadsUndo Z");
    await press("z");
    expect(document.querySelectorAll(".row.unread").length).toBe(2);
  });
});

describe("the reader", () => {
  test("opens the next Thread after an action in the sheet when the Setting is on", async () => {
    await mount({ initialOpen: "e1" });
    expect(reader()).toBe("e1");
    await press("e");
    expect(reader()).toBe("e2");
    expect(toast()).toContain("Archived");
  });

  test("closes the sheet after an action when open-next is off", async () => {
    await mount({ initialOpen: "e1" }, { "inbox.after_action.open_next": false });
    await press("e");
    expect(reader()).toBeNull();
    expect(focusRow()).toBe("e2");
  });

  test("toolbar buttons dispatch through InboxActions with the same toasts", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    await mount({ inbox, initialOpen: "e2" });
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".reader .col-head .btn")];
    const byTitle = (t: string) => buttons.find((b) => b.title.startsWith(t));
    await act(async () => byTitle("Delete")?.click());
    expect(calls).toEqual(['delete:["e2"]']);
    expect(toast()).toBe("DeletedUndo Z");
    expect(reader()).toBe("e3");
    await act(async () => byTitle("Archive")?.click());
    expect(calls[1]).toBe('archive:["e3"]');
    expect(toast()).toBe("ArchivedUndo Z");
    expect(reader()).toBe("e4");
  });

  test("the reader's Archive button acts on the open Thread", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    await mount({ inbox, initialOpen: "e3" });
    const archive = [
      ...document.querySelectorAll<HTMLButtonElement>(".reader .col-head .btn"),
    ].find((b) => b.title.startsWith("Archive"));
    await act(async () => archive?.click());
    expect(calls).toEqual(['archive:["e3"]']);
  });

  test("collapsed history expands on click", async () => {
    await mount({ initialOpen: "e1" });
    expect(document.querySelectorAll(".reader .msg.collapsed").length).toBe(2);
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".reader .msg.collapsed")?.click(),
    );
    expect(document.querySelectorAll(".reader .msg.collapsed").length).toBe(1);
  });

  test("the reader's More menu stars and marks unread", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    await mount({ inbox, initialOpen: "e3" });
    const more = [...document.querySelectorAll<HTMLButtonElement>(".reader .col-head .btn")].find(
      (b) => b.title === "More",
    );
    await act(async () => more?.click());
    const items = [...document.querySelectorAll<HTMLButtonElement>(".reader .pop .pop-item")];
    expect(items.map((i) => i.textContent)).toEqual(["Star", "Mark unread"]);
    await act(async () => items[1]?.click());
    expect(calls).toEqual(['markUnread:["e3"]']);
    expect(toast()).toBe("Marked unreadUndo Z");
  });
});

describe("strings", () => {
  test("nothing user-visible carries an em-dash", async () => {
    await mount({ initialOpen: "e1" });
    await press("e");
    expect(document.body.textContent).not.toContain(String.fromCharCode(0x2014));
  });
});
