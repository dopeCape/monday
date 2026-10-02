/// <reference types="bun-types" />
// The Inbox screen through its interface: keys in, InboxActions calls and
// DOM out. Mounted under a StaticShell over the fixtures with happy-dom.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Message, PartialSettings, Recommendation, Thread } from "@monday/shared";
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
      ...(inbox.recommendations ? { recommendations: inbox.recommendations } : {}),
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
  test("renders one plain list, newest activity first, with a focus row on the first Thread", async () => {
    await mount();
    // No Section headings: the Inbox is never divided (docs/spec/inbox.md, Stream).
    expect(document.querySelectorAll(".list .sec").length).toBe(0);
    expect(rowIds()).toEqual(["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "e10", "e11"]);
    expect(focusRow()).toBe("e1");
    expect(reader()).toBeNull();
  });

  test("the Section order, hidden rules and placements never split or reorder the Inbox", async () => {
    const custom = fixtureInbox([
      { ...fixtureThreads[0], id: "p1", section: "projects" } as Thread,
      { ...fixtureThreads[3], id: "w1", section: "waiting" } as Thread,
      { ...fixtureThreads[9], id: "n1", section: "reading" } as Thread,
    ]);
    await mount(
      { inbox: custom },
      {
        "sections.order": ["reading", "waiting", "projects"],
        "sections.rules": [
          { id: "projects", when: { groups: ["hiring"] } },
          { id: "waiting", when: { lastFrom: "others" }, hidden: true },
          { id: "reading", name: "Reading", when: { bulk: true }, placement: "stream" },
        ],
      },
    );
    expect(document.querySelectorAll(".list .sec").length).toBe(0);
    expect(rowIds()).toEqual(["p1", "w1", "n1"]);
  });

  test("the list is newest activity first whatever order the seam gives", async () => {
    const [a, b, c] = fixtureThreads as [Thread, Thread, Thread];
    const custom = fixtureInbox([
      { ...a, id: "old", lastActivity: "2026-09-01T09:00:00Z" },
      { ...b, id: "new", lastActivity: "2026-09-16T09:00:00Z" },
      { ...c, id: "mid", lastActivity: "2026-09-10T09:00:00Z" },
    ]);
    await mount({ inbox: custom });
    expect(rowIds()).toEqual(["new", "mid", "old"]);
  });

  test("a Group lens shows only that Group's Threads under the Group's name", async () => {
    await mount({ group: "hiring" });
    expect(document.querySelector(".col-head h2")?.textContent).toBe("Hiring");
    expect(rowIds()).toEqual(["e1", "e3"]);
    expect(document.querySelector(".col-head .count")?.textContent).toBe("2");
  });

  test("a Section created a moment ago shows in the nav without a reload, and the Inbox stays one list", async () => {
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
    expect(navText()).not.toContain("Reading");
    // Every Inbox Thread is in the one list, whatever Section holds it.
    expect(rowIds()).toEqual(["e1", "e2", "e3", "r1", "r2"]);

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
    expect(document.querySelectorAll(".list .sec").length).toBe(0);
    expect(rowIds()).toEqual(["e1", "e2", "e3", "r1", "r2"]);
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
    expect(document.querySelectorAll(".list .sec").length).toBe(0);
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
    expect(document.querySelectorAll(".list .sec").length).toBe(0);
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
    expect(document.querySelector("[name=ask]")?.getAttribute("placeholder")).toBe(
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
    const input = document.querySelector<HTMLTextAreaElement>("[name=ask]");
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
    // The row's hover actions name the same keys; its one suggestion names the chip key.
    expect(
      [...(rows()[0]?.querySelectorAll<HTMLElement>(".actions .btn") ?? [])].map((b) => b.title),
    ).toEqual(["Reply (Alt+1)", "Archive (Y)", "Snooze (B)", "Ask"]);
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
    expect(document.querySelector(".list .sel-bar h2")?.textContent).toBe("3 selected");
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
});

/** Clicks an element, with modifier keys. */
async function click(el: Element | null | undefined, mods: Partial<MouseEventInit> = {}) {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...mods }));
  });
}
const check = (id: string) => document.querySelector(`.row[data-thread="${id}"] .check`);
const bar = () => document.querySelector<HTMLElement>(".list .sel-bar");
const barAction = (key: string) => bar()?.querySelector(`[data-action="${key}"]`);

/**
 * The fixtures behind a seam that holds only the newest `held` Inbox Threads,
 * like the Store's over a large Cache: the total and the ids come from "the
 * Cache" (every fixture Thread).
 */
function windowed(held: number) {
  const base = fixtureInbox();
  const { inbox, calls } = spy(base);
  let from: readonly Thread[] | null = null;
  let shown: readonly Thread[] = [];
  const threads = () => {
    const all = base.threads();
    if (all !== from) {
      from = all;
      shown = all.slice(0, held);
    }
    return shown;
  };
  const data: InboxData = {
    ...inbox,
    threads,
    listTotal: (key) => (key === "inbox" ? base.threads().length : null),
    listIds: async (key) => (key === "inbox" ? base.threads().map((t) => t.id) : []),
  };
  return { inbox: data, calls, base };
}

describe("the selection bar", () => {
  test("the list header has no More button and no Mark all read", async () => {
    await mount();
    const head = document.querySelector(".list .col-head");
    expect(head?.querySelector(".btn[title='More']")).toBeNull();
    expect(head?.textContent).not.toContain("Mark all read");
    expect(Object.keys(defaultSettings)).not.toContain("strings.inbox.mark_all_read");
  });

  test("a row's checkbox toggles it without opening it; every checkbox shows while any row is selected", async () => {
    await mount();
    expect(document.querySelector(".list.selecting")).toBeNull();
    expect(rows().every((r) => r.querySelector(".check"))).toBe(true);
    await click(check("e2"));
    expect(picked()).toEqual(["e2"]);
    expect(check("e2")?.getAttribute("aria-pressed")).toBe("true");
    expect(check("e3")?.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector(".list.selecting")).not.toBeNull();
    expect(reader()).toBeNull();
    expect(check("e2")?.getAttribute("title")).toBe("Select (X)");
    await click(check("e2"));
    expect(picked()).toEqual([]);
    expect(document.querySelector(".list.selecting")).toBeNull();
    expect(bar()).toBeNull();
  });

  test("a shift-click selects every row from the last one toggled", async () => {
    await mount();
    await click(check("e2"));
    await click(check("e5"), { shiftKey: true });
    expect(picked()).toEqual(["e2", "e3", "e4", "e5"]);
    // Upwards from the last one toggled, keeping the rest.
    await click(check("e8"));
    await click(check("e7"), { shiftKey: true });
    expect(picked()).toEqual(["e2", "e3", "e4", "e5", "e7", "e8"]);
  });

  test("X and Shift-J show in the checkboxes", async () => {
    await mount();
    await press("x");
    await press("J", { shiftKey: true });
    expect(check("e1")?.getAttribute("aria-pressed")).toBe("true");
    expect(check("e2")?.getAttribute("aria-pressed")).toBe("true");
    expect(check("e3")?.getAttribute("aria-pressed")).toBe("false");
    // A shift-click ranges from the row X toggled last.
    await press("j");
    await press("x");
    await click(check("e5"), { shiftKey: true });
    expect(picked()).toEqual(["e1", "e2", "e3", "e4", "e5"]);
  });

  test("the bar replaces the header with the count, and each action applies to every selected Thread", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    await mount({ inbox });
    await click(check("e1"));
    await click(check("e3"), { shiftKey: true });
    expect(document.querySelector(".list-search")).toBeNull();
    expect(bar()?.querySelector("h2")?.textContent).toBe("3 selected");
    // Two of the three are unread: Mark read shows, Mark unread waits under More.
    expect(barAction("read")?.getAttribute("title")).toBe("Mark read (U)");
    expect(barAction("unread")).toBeFalsy();
    expect(barAction("archive")?.getAttribute("title")).toBe("Archive (E)");
    expect(barAction("delete")?.getAttribute("title")).toBe("Delete (#)");
    await click(barAction("read"));
    expect(calls).toEqual(['markRead:["e1","e2","e3"]']);
    expect(toast()).toBe("Marked read, 3 threadsUndo Z");
    // A flag keeps the selection; now all read, the bar offers Mark unread.
    expect(picked()).toEqual(["e1", "e2", "e3"]);
    expect(barAction("unread")).toBeTruthy();
    await click(barAction("star"));
    expect(calls.at(-1)).toBe('star:["e1","e2","e3"]');
    expect(barAction("unstar")).toBeTruthy();
    await click(barAction("snooze"));
    expect(document.querySelector(".pop")).not.toBeNull();
    await press("Enter", {}, document.querySelector(".pop") ?? window);
    expect(calls.at(-1)?.startsWith('snooze:["e1","e2","e3"]')).toBe(true);
    expect(rowIds()).not.toContain("e2");
    expect(bar()).toBeNull();
    expect(toast()?.startsWith("Snoozed until")).toBe(true);
    expect(toast()).toContain(", 3 threads");
  });

  test("move, delete and the More menu go the same way", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    await mount({ inbox });
    await click(check("e4"));
    await click(check("e5"));
    await click(barAction("move"));
    const target = document.querySelector<HTMLElement>(".pop .pop-item");
    const name = target?.textContent;
    await click(target);
    expect(calls.at(-1)?.startsWith('moveToGroup:["e4","e5"]')).toBe(true);
    expect(toast()).toBe(`Moved to ${name}, 2 threadsUndo Z`);
    await click(barAction("more"));
    const items = [...document.querySelectorAll<HTMLElement>(".pop .pop-item")];
    // Both read: Mark unread is on the bar, Mark read under More.
    expect(barAction("unread")).toBeTruthy();
    expect(items.map((i) => i.textContent)).toEqual(["Mark read", "Unstar", "LabelL"]);
    await click(items[0]);
    expect(calls.at(-1)).toBe('markRead:["e4","e5"]');
    await click(barAction("delete"));
    expect(calls.at(-1)).toBe('delete:["e4","e5"]');
    expect(toast()).toBe("Deleted, 2 threadsUndo Z");
    await press("z");
    expect(rowIds()).toContain("e4");
  });

  test("above the Setting a bar action previews first, with the same undo", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    await mount({ inbox }, { "inbox.batch_preview_above": 2 });
    await click(check("e1"));
    await click(check("e3"), { shiftKey: true });
    await click(barAction("star"));
    expect(calls).toEqual([]);
    expect(document.querySelector(".batch .batch-h")?.textContent).toBe("Star 3 threads?");
    await click(document.querySelector(".batch .btn.primary"));
    expect(calls).toEqual(['star:["e1","e2","e3"]']);
    await click(barAction("archive"));
    expect(document.querySelector(".batch .batch-h")?.textContent).toBe("Archive 3 threads?");
    await click(document.querySelector(".batch .btn.primary"));
    expect(calls.at(-1)).toBe('archive:["e1","e2","e3"]');
    expect(toast()).toBe("Archived, 3 threadsUndo Z");
    await press("z");
    expect(rowIds().slice(0, 3)).toEqual(["e1", "e2", "e3"]);
  });

  test("Esc and the Clear button end the selection and bring the header back", async () => {
    await mount();
    await click(check("e1"));
    await click(check("e2"));
    await press("Escape");
    expect(picked()).toEqual([]);
    expect(bar()).toBeNull();
    expect(document.querySelector(".list-search")).not.toBeNull();
    await click(check("e1"));
    expect(barAction("clear")?.getAttribute("title")).toBe("Clear selection (Esc)");
    await click(barAction("clear"));
    expect(picked()).toEqual([]);
  });

  test("the bar's checkbox selects every row shown, or none once all are", async () => {
    await mount();
    await click(check("e3"));
    const all = () => bar()?.querySelector(".check");
    expect(all()?.getAttribute("aria-pressed")).toBe("mixed");
    await click(all());
    expect(picked()).toEqual(["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "e10", "e11"]);
    expect(all()?.getAttribute("aria-pressed")).toBe("true");
    // The fixtures hold the whole list: nothing more to offer.
    expect(bar()?.querySelector(".sel-all")).toBeNull();
    await click(all());
    expect(picked()).toEqual([]);
  });

  test("Select all N reaches the Threads past the rows held, counts them, and acts on them all", async () => {
    const { inbox, calls } = windowed(5);
    await mount({ inbox });
    expect(rowIds()).toEqual(["e1", "e2", "e3", "e4", "e5"]);
    await click(check("e1"));
    await click(bar()?.querySelector(".check"));
    expect(picked()).toEqual(["e1", "e2", "e3", "e4", "e5"]);
    const offer = bar()?.querySelector(".sel-all");
    expect(offer?.textContent).toBe("Select all 11 in Inbox");
    await click(offer);
    expect(bar()?.querySelector("h2")?.textContent).toBe("All 11 in Inbox selected");
    expect(bar()?.querySelector(".sel-all")).toBeNull();
    // Eleven is above the Setting's ten: the preview counts all, lists the ones held.
    await click(barAction("archive"));
    await act(async () => {});
    expect(document.querySelector(".batch .batch-h")?.textContent).toBe("Archive 11 threads?");
    expect(document.querySelectorAll(".batch .batch-row").length).toBe(5);
    await click(document.querySelector(".batch .btn.primary"));
    expect(calls).toEqual(['archive:["e1","e2","e3","e4","e5","e6","e7","e8","e9","e10","e11"]']);
    expect(toast()).toBe("Archived, 11 threadsUndo Z");
    expect(bar()).toBeNull();
  });

  test("under Select all N a key applies to the whole list too; unchecking a row falls back to the rows shown", async () => {
    const { inbox, calls } = windowed(5);
    await mount({ inbox }, { "inbox.batch_preview_above": 100 });
    await click(check("e1"));
    await click(bar()?.querySelector(".check"));
    await click(bar()?.querySelector(".sel-all"));
    await press("s");
    await act(async () => {});
    expect(calls).toEqual(['star:["e1","e2","e3","e4","e5","e6","e7","e8","e9","e10","e11"]']);
    await click(check("e2"));
    expect(bar()?.querySelector("h2")?.textContent).toBe("4 selected");
    expect(picked()).toEqual(["e1", "e3", "e4", "e5"]);
  });

  test("More offers the custom actions every selected Thread carries, with their Tier and one Undo", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    await mount(
      { inbox },
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
          { id: "pay", label: "Pay", on: { group: "finance" }, tool: "archive_threads", args: {} },
        ],
      },
    );
    const labels = () =>
      [...document.querySelectorAll<HTMLElement>(".pop .pop-item")].map((i) => i.textContent);
    // e1 and e3 are both in Hiring; e7 is in Finance.
    await click(check("e1"));
    await click(check("e7"));
    await click(barAction("more"));
    expect(labels()).not.toContain("File it");
    await press("Escape", {}, document.querySelector(".pop") ?? window);
    await click(check("e7"));
    await click(check("e3"));
    await click(barAction("more"));
    expect(labels().slice(3)).toEqual(["File it", "Bin itasks first"]);
    // Trash asks first: the first pick only asks.
    await click([...document.querySelectorAll(".pop .pop-item")].at(4));
    expect(calls).toEqual([]);
    expect(toast()).toContain("Bin it");
    await click(barAction("more"));
    await click([...document.querySelectorAll(".pop .pop-item")].at(3));
    expect(calls).toEqual(['archive:["e1"]', 'archive:["e3"]']);
    expect(toast()).toBe("File it: done, 2 threadsUndo Z");
    expect(rowIds()).not.toContain("e1");
    await press("z");
    expect(rowIds()).toContain("e1");
    expect(rowIds()).toContain("e3");
  });

  test("in Archive the bar offers Unarchive instead of Archive", async () => {
    const archived = fixtureThreads.map((th, i) => (i < 3 ? { ...th, archived: true } : th));
    const base = fixtureInbox(archived);
    const { inbox, calls } = spy(base);
    await mount({
      inbox: { ...inbox, ...(base.folder ? { folder: base.folder } : {}) },
      folder: "archive",
    });
    const first = rowIds()[0] as string;
    await click(check(first));
    expect(barAction("archive")).toBeFalsy();
    expect(barAction("unarchive")?.getAttribute("title")).toBe("Unarchive");
    await click(barAction("unarchive"));
    expect(calls).toEqual([`unarchive:["${first}"]`]);
    expect(toast()).toBe("Back in InboxUndo Z");
    expect(rowIds()).not.toContain(first);
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
    // The read toggle is a button beside Delete now, not in More.
    expect(more).toBeDefined();
    const item = document.querySelector<HTMLButtonElement>(
      '.reader .col-head [data-toggle="read"]',
    );
    expect(item?.title).toStartWith("Mark unread");
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
    await mount({ inbox, initialOpen: "e10" }, { "ai.level": "assist" });
    // e10 carries a Recommended archive; a click applies it with Undo and moves on.
    const chip = [
      ...document.querySelectorAll<HTMLButtonElement>(".reader .brief-actions .chip"),
    ].find((b) => b.textContent?.trim() === "Archive");
    expect(chip).not.toBeUndefined();
    await act(async () => chip?.click());
    expect(calls).toContain('archive:["e10"]');
    expect(toast()).toBe("ArchivedUndo Z");
    expect(reader()).toBe("e11");
    expect(focusRow()).toBe("e11");
  });

  test("Recommended chips show before a Brief exists, likeliest first, never more than three with the Custom actions first; the Brief chooses none (acceptance 7, 8)", async () => {
    const base = fixtureInbox();
    let brief = base.brief;
    const priya = { name: "Priya Raman", email: "priya@genai-labs.io" };
    // One object per Thread, so the seam hands out a stable snapshot like the Store does.
    const held = {
      actions: [
        { kind: "reply", fit: 0.74, rank: 0.74 },
        {
          kind: "snooze",
          fit: 0.9,
          rank: 0.9,
          until: "2026-09-21T08:00:00.000Z",
          anchor: "weekday",
        },
        { kind: "forward", fit: 0.88, rank: 0.88, to: priya, confidence: 0.86 },
        { kind: "archive", fit: 0.65, rank: 0.65 },
        {
          kind: "delegate",
          fit: 0.86,
          rank: 0.86,
          to: { name: "Ravi", email: "ravi@x.test" },
          confidence: 0.5,
        },
      ] satisfies Recommendation[],
      messageCount: 3,
      fromDomain: "northlight.dev",
    };
    const inbox: InboxData = {
      ...base,
      brief: (id) => brief(id),
      recommendations: (id) => (id === "e1" ? held : undefined),
    };
    const has = (selector: string) => document.querySelector(selector) !== null;
    const remount = async (open: string, settings: PartialSettings = {}) => {
      if (root) await act(async () => root?.unmount());
      host?.remove();
      await mount(
        { inbox, initialOpen: open },
        { "ai.level": "assist", "actions.recommended.position": "top", ...settings },
      );
    };
    const chips = (selector: string) =>
      [...document.querySelectorAll<HTMLButtonElement>(`${selector} .chip`)].map((b) =>
        b.textContent?.trim(),
      );
    // At the top, with no Brief yet: the chips sit where the Brief will. Archive (0.65 under 0.7)
    // and the unsure Ask (recipient 0.5 under 0.8) are held back; the rest likeliest first.
    brief = () => undefined;
    await remount("e1");
    expect(has(".reader .brief ul")).toBe(false);
    expect(chips(".reader .brief.chips")).toEqual([
      "Snooze until Mon 08:00",
      "Forward to Priya",
      "Reply",
    ]);
    expect(
      document.querySelector<HTMLButtonElement>(".reader .brief.chips .chip")?.title,
    ).toContain("(Alt+1)");
    // The Brief arrives: it keeps its bullets and the same chips sit under them.
    brief = base.brief;
    await remount("e1");
    expect(has(".reader .brief ul")).toBe(true);
    expect(has(".reader .brief.chips")).toBe(false);
    expect(chips(".reader .brief .brief-actions")).toHaveLength(3);
    // A Custom action comes first and the row still holds three.
    await remount("e1", {
      "actions.custom": [
        {
          id: "file-it",
          label: "File it",
          on: { group: "hiring" },
          tool: "archive_threads",
          args: {},
        },
      ],
    });
    expect(chips(".reader .brief .brief-actions")).toEqual([
      "File it",
      "Snooze until Mon 08:00",
      "Forward to Priya",
    ]);
    // The Setting caps the row.
    await remount("e1", { "actions.recommended.max_in_reader": 1 });
    expect(chips(".reader .brief .brief-actions")).toEqual(["Snooze until Mon 08:00"]);
    // A row shows one suggestion, on hover only by default; always keeps it; off shows none.
    const rowChip = () => document.querySelector('.row[data-thread="e1"] .row-chip');
    expect(rowChip()?.textContent?.trim()).toBe("Snooze until Mon 08:00");
    expect(document.querySelectorAll('.row[data-thread="e1"] .row-chip')).toHaveLength(1);
    expect(document.querySelector('.row[data-thread="e1"] .actions.keep')).toBeNull();
    await remount("e1", { "actions.recommended.in_list": "always" });
    expect(document.querySelector('.row[data-thread="e1"] .actions.keep')).not.toBeNull();
    await remount("e1", { "actions.recommended.in_list": "off" });
    expect(rowChip()).toBeNull();
    // A Thread with no Recommended actions and no Brief shows nothing there.
    brief = () => undefined;
    await remount("e2");
    expect(has(".reader .brief")).toBe(false);
    await remount("e2", { "actions.recommended.position": "bottom" });
    expect(has(".reader .reader-suggested")).toBe(false);
  });

  test("by default the chips sit in a Suggested row at the end of the Thread, right above the reply box; both shows them twice", async () => {
    const base = fixtureInbox();
    const held = {
      actions: [
        { kind: "reply", fit: 0.74, rank: 0.74 },
        { kind: "archive", fit: 0.72, rank: 0.72 },
      ] satisfies Recommendation[],
      messageCount: 3,
      fromDomain: "northlight.dev",
    };
    const inbox: InboxData = {
      ...base,
      recommendations: (id) => (id === "e1" ? held : undefined),
    };
    const remount = async (settings: PartialSettings = {}) => {
      if (root) await act(async () => root?.unmount());
      host?.remove();
      await mount({ inbox, initialOpen: "e1" }, { "ai.level": "assist", ...settings });
    };
    const chips = (selector: string) =>
      [...document.querySelectorAll<HTMLButtonElement>(`${selector} .chip`)].map((b) =>
        b.textContent?.trim(),
      );
    await remount();
    expect(chips(".reader .brief .brief-actions")).toEqual([]);
    expect(document.querySelector(".reader .reader-suggested-h")?.textContent).toBe("Suggested");
    expect(chips(".reader .reader-suggested")).toEqual(["Reply", "Archive"]);
    // After the last Message, before the reply box.
    const row = document.querySelector(".reader .reader-suggested") as Element;
    const messages = document.querySelectorAll(".reader .reader-inner > *");
    const order = [...messages];
    const at = order.indexOf(row);
    expect(at).toBeGreaterThan(0);
    expect(
      order
        .slice(at + 1)
        .some((e) => e.querySelector("textarea") || e.matches(".reply, .reply-box")),
    ).toBe(true);
    // The keys still name them in order.
    expect(document.querySelector<HTMLButtonElement>(".reader-suggested .chip")?.title).toContain(
      "(Alt+1)",
    );
    await remount({ "actions.recommended.position": "both" });
    expect(chips(".reader .brief .brief-actions")).toEqual(["Reply", "Archive"]);
    expect(chips(".reader .reader-suggested")).toEqual(["Reply", "Archive"]);
  });

  test("Alt+1 runs the reader's first chip; in the list it runs the selected row's chip", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    await mount({ inbox, initialOpen: "e10" }, { "ai.level": "assist" });
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "¡", code: "Digit1", altKey: true, bubbles: true }),
      );
    });
    expect(calls).toContain('archive:["e10"]');
    expect(toast()).toBe("ArchivedUndo Z");
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

  test("the reader's More menu stars; marking unread is a button beside Delete, and a key", async () => {
    const { inbox, calls } = spy(fixtureInbox());
    await mount({ inbox, initialOpen: "e3" });
    const more = [...document.querySelectorAll<HTMLButtonElement>(".reader .col-head .btn")].find(
      (b) => b.title === "More",
    );
    await act(async () => more?.click());
    const items = [...document.querySelectorAll<HTMLButtonElement>(".reader .pop .pop-item")];
    expect(items.map((i) => i.textContent)).toEqual(["Star"]);
    await act(async () => more?.click());
    const toggle = document.querySelector<HTMLButtonElement>(
      '.reader .col-head [data-toggle="read"]',
    );
    expect(toggle?.title).toBe("Mark unread (U)");
    await act(async () => toggle?.click());
    expect(calls).toEqual(['markUnread:["e3"]']);
    expect(toast()).toBe("Marked unreadUndo Z");
    // The keymap's key toggles it back.
    await press("u");
    expect(calls).toEqual(['markUnread:["e3"]', 'markRead:["e3"]']);
  });
});

describe("dragging rows into the Agent", () => {
  function drag(id: string) {
    const set: Record<string, string> = {};
    const event = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: {
        setData: (type: string, value: string) => {
          set[type] = value;
        },
        effectAllowed: "none",
      },
    });
    act(() => {
      document.querySelector(`.row[data-thread=${id}]`)?.dispatchEvent(event);
    });
    return set;
  }

  test("a row carries its Thread; a row in the selection carries the whole selection", async () => {
    await mount();
    const row = document.querySelector<HTMLElement>(".row[data-thread=e2]");
    expect(row?.getAttribute("draggable")).toBe("true");
    const one = drag("e2");
    expect(
      JSON.parse(one["application/x-monday-threads"] ?? "[]").map((t: { id: string }) => t.id),
    ).toEqual(["e2"]);
    expect(document.documentElement.getAttribute("data-dragging")).toBe("threads");
    await act(async () => {
      document
        .querySelector(".row[data-thread=e2]")
        ?.dispatchEvent(new Event("dragend", { bubbles: true }));
    });
    expect(document.documentElement.getAttribute("data-dragging")).toBeNull();

    await press("x");
    await press("J", { shiftKey: true });
    const many = drag("e1");
    const carried = JSON.parse(many["application/x-monday-threads"] ?? "[]") as {
      id: string;
      subject: string;
    }[];
    expect(carried.map((t) => t.id)).toEqual(["e1", "e2"]);
    expect(carried[0]?.subject.length).toBeGreaterThan(0);
    // Outside the selection, a row carries only itself.
    expect(
      JSON.parse(drag("e4")["application/x-monday-threads"] ?? "[]").map(
        (t: { id: string }) => t.id,
      ),
    ).toEqual(["e4"]);
  });
});

describe("strings", () => {
  test("nothing user-visible carries an em-dash", async () => {
    await mount({ initialOpen: "e1" });
    await press("e");
    expect(document.body.textContent).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("Recommended actions II in the reader (docs/spec/actions.md)", () => {
  const later = "2026-10-01T10:00:00.000Z";
  test("Unsubscribe asks first with the exact request; approving sends exactly that, then offers to archive the list", async () => {
    const base = fixtureInbox();
    const events: unknown[] = [];
    const approved: unknown[] = [];
    const held = {
      actions: [
        {
          kind: "unsubscribe",
          fit: 1,
          rank: 1,
          listId: "<weekly.rust.test>",
          listName: "Weekly Rust",
          method: "one_click",
          target: "https://rust.test/u/abc",
          issues: 3,
        },
      ] satisfies Recommendation[],
      messageCount: 1,
      fromDomain: "rust.test",
    };
    const inbox: InboxData = {
      ...base,
      recommendations: (id) => (id === "e11" ? held : undefined),
      recommendationEvents: (body) => events.push(body),
      listExit: async () => ({
        method: "one_click",
        target: "https://rust.test/u/abc",
        listId: "<weekly.rust.test>",
        listName: "Weekly Rust",
        issues: 3,
      }),
      unsubscribe: async (threadId, request) => {
        approved.push({ threadId, ...request });
        return { ok: true, text: "done" };
      },
    };
    await mount({ inbox, initialOpen: "e11" }, { "ai.level": "assist" });
    const chip = document.querySelector<HTMLButtonElement>(
      '.reader .chip[data-chip="unsubscribe"]',
    );
    expect(chip?.textContent?.trim()).toBe("Unsubscribe");
    await act(async () => chip?.click());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    const card = document.querySelector(".reader [data-card='unsubscribe']");
    expect(card?.textContent).toContain("Leave Weekly Rust?");
    expect(card?.textContent).toContain("https://rust.test/u/abc");
    // Nothing reaches the list before the user approves.
    expect(approved).toEqual([]);
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-approve='unsubscribe']")?.click(),
    );
    expect(approved).toEqual([
      { threadId: "e11", method: "one_click", target: "https://rust.test/u/abc" },
    ]);
    expect(card?.textContent).toContain("Archive the 3 issues from this list");
    expect(events).toContainEqual({
      threadId: "e11",
      outcome: { kind: "unsubscribe", outcome: "used" },
    });
  });

  test("Not this hides a chip on the Thread; Not for mail from a domain mutes the action for the sender", async () => {
    const base = fixtureInbox();
    const events: unknown[] = [];
    const held = {
      actions: [
        { kind: "reply", fit: 0.9, rank: 0.9 },
        { kind: "snooze", fit: 0.8, rank: 0.8, until: later, anchor: "weekday" },
      ] satisfies Recommendation[],
      messageCount: 3,
      fromDomain: "northlight.dev",
    };
    const inbox: InboxData = {
      ...base,
      recommendations: (id) => (id === "e1" ? held : undefined),
      recommendationEvents: (body) => events.push(body),
    };
    await mount({ inbox, initialOpen: "e1" }, { "ai.level": "assist" });
    const labels = () =>
      [...document.querySelectorAll<HTMLElement>(".reader .brief-actions .recommended-chip")].map(
        (c) => c.textContent?.trim(),
      );
    expect(labels()).toEqual(["Reply", "Snooze until Oct 1 10:00"]);
    const menu = () =>
      document.querySelector<HTMLButtonElement>('.reader .chip[data-chip="snooze"] + .chip-menu');
    await act(async () => menu()?.click());
    const items = [...document.querySelectorAll<HTMLButtonElement>(".reader .pop .pop-item")];
    expect(items.map((b) => b.textContent)).toEqual([
      "Not this",
      "Not for mail from northlight.dev",
    ]);
    await act(async () => items[0]?.click());
    expect(labels()).toEqual(["Reply"]);
    expect(events).toContainEqual({
      threadId: "e1",
      outcome: { kind: "snooze", outcome: "dismissed", args: { until: later } },
    });
  });
});
