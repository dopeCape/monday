/// <reference types="bun-types" />
// The Inbox screen through its interface: keys in, InboxActions calls and
// DOM out. Mounted under a StaticShell over the fixtures with happy-dom.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Message, PartialSettings, Thread } from "@monday/shared";
import { defaultSettings } from "@monday/shared";
import { NavSidebar } from "@monday/ui";
import { threads as fixtureThreads } from "@monday/ui/fixtures";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { navModel } from "../shell/nav.ts";
import { StaticShell, useShell } from "../shell/Shell.tsx";
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
    <K extends Exclude<keyof InboxActions, "setTags">>(name: K) =>
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
      unavailable: inbox.unavailable,
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

  test("a Section created a moment ago renders in the nav and the stream, without a reload", async () => {
    // Two Threads the new rule will hold, beside the fixture's; the seam sections them as the Store would.
    const custom = fixtureInbox([
      ...fixtureThreads.slice(0, 3),
      { ...fixtureThreads[9], id: "r1", section: "reading", unread: true } as Thread,
      { ...fixtureThreads[10], id: "r2", section: "reading", unread: false } as Thread,
    ]);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const r = root;
    let shellRef: ReturnType<typeof useShell> | null = null;
    function Harness() {
      const shell = useShell();
      shellRef = shell;
      const nav = navModel({
        address: "sam@monday.test",
        status: "online",
        threads: custom.threads(),
        groups: custom.groups(),
        sections: shell.settings["sections.rules"],
        sectionOrder: shell.settings["sections.order"],
        strings: shell.settings,
      });
      return (
        <>
          <NavSidebar
            workspace={nav.workspace}
            labels={nav.labels}
            folders={nav.folders}
            groups={custom.groups()}
            counts={nav.counts}
            sections={nav.sections}
            automation={nav.automation}
            active="inbox"
          />
          <Inbox
            now={new Date(2026, 8, 16, 10, 0)}
            initialOpen={null}
            timing={{ collapse: 0, toast: 60_000 }}
            inbox={custom}
          />
        </>
      );
    }
    await act(async () =>
      r.render(
        <StaticShell settings={{ "ai.level": "automate" }}>
          <Harness />
        </StaticShell>,
      ),
    );
    const navText = () =>
      [...document.querySelectorAll(".nav .nav-item span")].map((s) => s.textContent);
    const headings = () => [...document.querySelectorAll(".sec")].map((s) => s.textContent);
    expect(navText()).not.toContain("Reading");
    expect(headings()).not.toContain("Reading");
    expect(rowIds()).not.toContain("r1");

    // The Agent's create_section writes the two Settings; the Shell's refresh hands them to the screens.
    const shell = shellRef as unknown as ReturnType<typeof useShell>;
    await act(async () => {
      await shell.set("sections.rules", [
        ...defaultSettings()["sections.rules"],
        {
          id: "reading",
          name: "Reading",
          when: { bulk: true },
          placement: "both",
          createdBy: "agent",
        },
      ]);
      await shell.set("sections.order", [...defaultSettings()["sections.order"], "reading"]);
    });
    expect([...document.querySelectorAll(".nav .nav-sec")].map((s) => s.textContent)).toContain(
      "Sections",
    );
    const item = [...document.querySelectorAll<HTMLElement>(".nav .nav-item")].find(
      (b) => b.querySelector("span")?.textContent === "Reading",
    );
    expect(item).not.toBeUndefined();
    expect(item?.querySelector(".n")?.textContent).toBe("1");
    expect(headings()).toContain("Reading");
    expect(rowIds()).toEqual(["e1", "e2", "e3", "r1", "r2"]);
  });

  test("a hidden Section keeps its Threads out of the other Sections, and so does one placed only in the nav", async () => {
    const custom = fixtureInbox([
      { ...fixtureThreads[0], id: "h1", section: "hidden-one" } as Thread,
      { ...fixtureThreads[9], id: "n1", section: "reading" } as Thread,
      { ...fixtureThreads[3], id: "w1", section: "waiting" } as Thread,
    ]);
    await mount(
      { inbox: custom },
      {
        "sections.order": ["hidden-one", "reading", "waiting"],
        "sections.rules": [
          { id: "hidden-one", when: { unread: true }, hidden: true },
          { id: "reading", name: "Reading", when: { bulk: true }, placement: "nav" },
          { id: "waiting", when: { lastFrom: "others" } },
        ],
      },
    );
    expect([...document.querySelectorAll(".sec")].map((s) => s.textContent)).toEqual([
      "Waiting on you",
    ]);
    expect(rowIds()).toEqual(["w1"]);
  });

  test("a Section lens shows only that Section's Threads under its name", async () => {
    const custom = fixtureInbox([
      { ...fixtureThreads[9], id: "n1", section: "reading" } as Thread,
      { ...fixtureThreads[3], id: "w1", section: "waiting" } as Thread,
    ]);
    await mount(
      { inbox: custom, section: "reading" },
      {
        "sections.order": ["reading", "waiting"],
        "sections.rules": [
          { id: "reading", name: "Reading", when: { bulk: true }, placement: "nav" },
          { id: "waiting", when: { lastFrom: "others" } },
        ],
      },
    );
    expect(document.querySelector(".col-head h2")?.textContent).toBe("Reading");
    expect([...document.querySelectorAll(".sec")].map((s) => s.textContent)).toEqual(["Reading"]);
    expect(rowIds()).toEqual(["n1"]);
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

  test("the toast fades after the Setting's delay, counted from when it appeared, not from the last render", async () => {
    await mount({ timing: { collapse: 0, toast: 40 } });
    await press("e");
    expect(toast()).toBe("ArchivedUndo Z");
    // Renders keep coming (J moves the focus) inside the window; none restarts the clock.
    await act(async () => Bun.sleep(15));
    await press("j");
    await act(async () => Bun.sleep(15));
    await press("k");
    await act(async () => Bun.sleep(20));
    expect(toast()).toBeNull();
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
    // The row's hover actions name the same keys.
    expect(
      [...(rows()[0]?.querySelectorAll<HTMLElement>(".actions .btn") ?? [])].map((b) => b.title),
    ).toEqual(["Archive (Y)", "Snooze (B)", "Ask"]);
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

  test("the split list with nothing to open shows the empty reader with the move keys", async () => {
    await mount({ inbox: fixtureInbox([]) }, { "layout.list": "split" });
    expect(document.querySelector(".reader .empty h3")?.textContent).toBe("Nothing open");
    expect(document.querySelector(".reader .empty p")?.textContent).toBe(
      "Pick a conversation, or use J and K.",
    );
    expect([...document.querySelectorAll(".reader .empty kbd")].map((k) => k.textContent)).toEqual([
      "J",
      "K",
    ]);
  });

  test("bodies missing for a reason say so in plain words, and come back online", async () => {
    const base = fixtureInbox();
    let why: "offline" | "locked" | "failed" | null = "offline";
    let opened = 0;
    // Stable snapshots, as the seam promises: the same array until something changes.
    const bare = new Map<string, readonly Message[]>();
    const inbox: InboxData = {
      ...base,
      messages: (id) => {
        let list = bare.get(id);
        if (!list) {
          list = base.messages(id).map(({ bodyText: _b, ...m }) => m);
          bare.set(id, list);
        }
        return list;
      },
      unavailable: () => why,
      openThread: async () => {
        opened += 1;
      },
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const r = root;
    const render = (online: boolean) =>
      act(async () =>
        r.render(
          <StaticShell settings={{ "ai.level": "automate" }}>
            <Inbox
              inbox={inbox}
              now={new Date(2026, 8, 16, 10, 0)}
              initialOpen="e1"
              online={online}
              timing={{ collapse: 0, toast: 60_000 }}
            />
          </StaticShell>,
        ),
      );
    await render(false);
    const line = () => document.querySelector(".reader .msg-body .faint")?.textContent;
    expect(line()).toBe("Message text will load when you are back online");
    // Back online: the screen opens the Thread again for what the Cache lacks.
    const before = opened;
    await render(true);
    expect(opened).toBe(before + 1);
    why = "locked";
    await render(true);
    expect(line()).toBe("Message text is unavailable while the server is locked");
    why = "failed";
    await render(false);
    expect(line()).toBe("Message text could not be loaded. Open the thread again to retry");
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
    // Opening e2 read it (the Setting); the toolbar then acts on the open Thread.
    expect(calls).toEqual(['markRead:["e2"]']);
    await act(async () => byTitle("Delete")?.click());
    expect(calls).toEqual(['markRead:["e2"]', 'delete:["e2"]']);
    expect(toast()).toBe("DeletedUndo Z");
    expect(reader()).toBe("e3");
    await act(async () => byTitle("Archive")?.click());
    expect(calls[2]).toBe('archive:["e3"]');
    expect(toast()).toBe("ArchivedUndo Z");
    expect(reader()).toBe("e4");
  });

  test("opening marks the Thread read once (a Setting); mark unread from the menu holds", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    await mount({ inbox, initialOpen: null });
    expect(inbox.thread("e1")?.unread).toBe(true);
    await press("Enter");
    expect(reader()).toBe("e1");
    expect(calls).toEqual(['markRead:["e1"]']);
    expect(document.querySelector(".row[data-thread=e1]")?.classList.contains("unread")).toBe(
      false,
    );
    // The More menu offers Mark unread, and the open Thread stays unread afterwards.
    const more = [...document.querySelectorAll<HTMLButtonElement>(".reader .col-head .btn")].find(
      (b) => b.title === "More",
    );
    await act(async () => more?.click());
    const item = [...document.querySelectorAll<HTMLButtonElement>(".reader .pop-item")].find((b) =>
      b.textContent?.includes("Mark unread"),
    );
    await act(async () => item?.click());
    expect(calls).toEqual(['markRead:["e1"]', 'markUnread:["e1"]']);
    expect(inbox.thread("e1")?.unread).toBe(true);
    // The next unread Thread reads on its own open.
    await press("Escape");
    await press("j");
    await press("Enter");
    expect(calls.length).toBe(3);
    expect(calls[2]).toBe('markRead:["e2"]');
  });

  test("with reader.mark_read_on_open off, opening leaves the Thread unread", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    await mount({ inbox, initialOpen: "e1" }, { "reader.mark_read_on_open": false });
    expect(reader()).toBe("e1");
    expect(calls).toEqual([]);
    expect(inbox.thread("e1")?.unread).toBe(true);
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

  test("a Brief chip that archives advances the reader like the toolbar does", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    await mount({ inbox, initialOpen: "e10" });
    // e10's Brief carries an archive chip; a click applies it with Undo and moves on.
    const chip = [
      ...document.querySelectorAll<HTMLButtonElement>(".reader .brief-actions .chip"),
    ].find((b) => b.textContent === "Archive");
    expect(chip).not.toBeUndefined();
    await act(async () => chip?.click());
    expect(calls).toContain('archive:["e10"]');
    expect(toast()).toBe("ArchivedUndo Z");
    expect(reader()).toBe("e11");
    expect(focusRow()).toBe("e11");
  });

  test("judged chips show before a Brief exists, likeliest first; a call chip hands the agent bar its sentence; the Brief's own chips win once it arrives", async () => {
    const base = fixtureInbox();
    let brief = base.brief;
    // One object, so the seam hands out a stable snapshot like the Store does.
    const judged = {
      threadId: "e1",
      needsReply: 0.64,
      waitingOnOthers: 0.2,
      newsletter: 0.07,
      automated: 0.05,
      briefWorth: 1,
      urgency: 1.2,
      chips: {
        reply: 0.84,
        call: 0.86,
        review_link: 0.1,
        open_attachment: 0.2,
        pay_or_file: 0.05,
        snooze: 0.3,
      },
      model: "jev-1.13.0",
      judgedAt: "2026-09-16T09:00:00.000Z",
    };
    const inbox: InboxData = {
      ...base,
      brief: (id) => brief(id),
      judgments: (id) => (id === "e1" ? judged : undefined),
    };
    const has = (selector: string) => document.querySelector(selector) !== null;
    const remount = async (open: string) => {
      if (root) await act(async () => root?.unmount());
      host?.remove();
      await mount({ inbox, initialOpen: open });
    };
    // No Brief yet: the judged chips sit where the Brief will, above the threshold, likeliest first.
    brief = () => undefined;
    await remount("e1");
    expect(has(".reader .brief ul")).toBe(false);
    const chips = () =>
      [...document.querySelectorAll<HTMLButtonElement>(".reader .brief.chips .chip")].map(
        (b) => b.textContent,
      );
    expect(chips()).toEqual(["Set up a call", "Reply"]);
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".reader .brief.chips .chip")?.click(),
    );
    expect(document.querySelector<HTMLInputElement>(".agent-bar input")?.value).toBe(
      "Set up a call with the sender of this thread",
    );
    // The Brief arrives: its own chips replace the judged ones.
    brief = base.brief;
    await remount("e1");
    expect(has(".reader .brief ul")).toBe(true);
    expect(has(".reader .brief.chips")).toBe(false);
    // A Thread with no Judgments and no Brief shows nothing there.
    brief = () => undefined;
    await remount("e2");
    expect(has(".reader .brief")).toBe(false);
  });

  test("a custom action on the open Thread's Group runs with its Tier: archive with Undo, trash asks first", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    // e1 sits in Hiring; the actions are defined for Hiring and for Finance.
    await mount(
      { inbox, initialOpen: "e1" },
      {
        "actions.custom": [
          {
            id: "file-it",
            label: "File it",
            on: { group: "hiring" },
            tool: "archive_threads",
            args: {},
          },
          {
            id: "bin-it",
            label: "Bin it",
            on: { group: "hiring" },
            tool: "trash_threads",
            args: {},
          },
          {
            id: "pay",
            label: "Pay",
            on: { group: "finance" },
            tool: "archive_threads",
            args: {},
          },
        ],
      },
    );
    const buttons = () =>
      [...document.querySelectorAll<HTMLElement>(".reader .col-head [data-action]")].map((b) => [
        b.dataset.action,
        b.dataset.tier,
      ]);
    expect(buttons()).toEqual([
      ["file-it", "reversible"],
      ["bin-it", "always-ask"],
    ]);
    // The chip row under the Brief carries the same two.
    expect(
      [...document.querySelectorAll<HTMLElement>(".reader .brief-actions .chip.custom-action")].map(
        (c) => c.textContent,
      ),
    ).toEqual(["File it", "Bin it"]);
    // Trash asks first: the first click only confirms, nothing ran.
    const bin = document.querySelector<HTMLButtonElement>('.reader [data-action="bin-it"]');
    await act(async () => bin?.click());
    // Opening marked the Thread read; nothing else ran.
    expect(calls.filter((c) => !c.startsWith("markRead:"))).toEqual([]);
    expect(toast()).toContain("Bin it asks first");
    // Archive runs with Undo and the reader moves on.
    const file = document.querySelector<HTMLButtonElement>('.reader [data-action="file-it"]');
    await act(async () => file?.click());
    expect(calls).toContain('archive:["e1"]');
    expect(toast()).toBe("File it: doneUndo Z");
    expect(reader()).toBe("e2");
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
