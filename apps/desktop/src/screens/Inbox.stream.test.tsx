/// <reference types="bun-types" />
// The stream under real-mailbox conditions: a read Thread keeps its place,
// a sender with no name still reads as someone, a long list renders only
// what is near the view, the Filter menu narrows the Sections. Mounted under
// a StaticShell over fixtures with happy-dom.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { PartialSettings, Thread } from "@monday/shared";
import { threads as fixtureThreads } from "@monday/ui/fixtures";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { SearchModule } from "../search/index.ts";
import { StaticShell } from "../shell/Shell.tsx";
import { Inbox, type InboxProps } from "./Inbox.tsx";
import { fixtureInbox, type Inbox as InboxData } from "./inbox/actions.ts";

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

const tree = (data: InboxData, props: Partial<InboxProps>, settings: PartialSettings) => (
  <StaticShell settings={{ "ai.level": "automate", ...settings }}>
    <Inbox
      now={new Date(2026, 8, 16, 10, 0)}
      initialOpen={null}
      timing={{ collapse: 0, toast: 60_000 }}
      {...props}
      inbox={data}
    />
  </StaticShell>
);

async function mount(props: Partial<InboxProps> = {}, settings: PartialSettings = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  const data = props.inbox ?? fixtureInbox();
  await act(async () => r.render(tree(data, props, settings)));
  return {
    data,
    rerender: (next: Partial<InboxProps>) =>
      act(async () => r.render(tree(data, { ...props, ...next }, settings))),
  };
}

async function type(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error("no input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(key: string, mods: Partial<KeyboardEventInit> = {}) {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }),
    );
  });
}

const rowIds = () =>
  [...document.querySelectorAll<HTMLElement>(".list .row")].map((r) => r.dataset.thread);
const reader = () => document.querySelector<HTMLElement>(".reader")?.dataset.thread ?? null;

/**
 * The fixtures behind a seam that re-sections on read, as the old shipped
 * rule did: a read Thread in Needs your reply drops to For your information.
 */
function resectioning(base: InboxData): InboxData {
  const view = (t: Thread): Thread =>
    t.section === "needs-reply" && !t.unread ? { ...t, section: "fyi" } : t;
  let source: readonly Thread[] | null = null;
  let out: readonly Thread[] = [];
  return {
    ...base,
    threads: () => {
      const now = base.threads();
      if (now !== source) {
        source = now;
        out = now.map(view);
      }
      return out;
    },
    thread: (id) => {
      const t = base.thread(id);
      return t ? view(t) : undefined;
    },
  };
}

describe("a Thread keeps its place while the user reads it", () => {
  // The old shipped rule, through the seam: a read Thread leaves Needs your reply.
  const rules = {
    "sections.rules": [
      { id: "needs-reply", name: "Needs your reply", when: {} },
      { id: "fyi", name: "For your information", when: {} },
    ],
  };

  test("opening a Thread in a Section lens reads it, drops its unread look, and leaves it where it was", async () => {
    const inbox = resectioning(fixtureInbox());
    await mount({ inbox, section: "needs-reply" }, rules);
    expect(rowIds()).toEqual(["e1", "e2"]);
    await act(async () => document.querySelector<HTMLElement>(".row[data-thread=e1]")?.click());
    expect(reader()).toBe("e1");
    // The seam now puts e1 under For your information; the lens holds it.
    expect(inbox.thread("e1")?.section).toBe("fyi");
    expect(rowIds()).toEqual(["e1", "e2"]);
    const row = document.querySelector(".row[data-thread=e1]");
    expect(row?.classList.contains("unread")).toBe(false);
    expect(row?.classList.contains("on")).toBe(true);
    // Moving on and closing the reader does not move it either.
    await press("Escape");
    await press("j");
    expect(rowIds()).toEqual(["e1", "e2"]);
  });

  test("a rebuilt list (a new mount) takes the Sections the rules give now", async () => {
    const inbox = resectioning(fixtureInbox());
    await inbox.markRead(["e1"]);
    await mount({ inbox, section: "needs-reply" }, rules);
    expect(rowIds()).toEqual(["e2"]);
  });

  test("in the Inbox a read Thread keeps its row, and archive still removes it", async () => {
    const inbox = resectioning(fixtureInbox());
    await mount({ inbox });
    const before = rowIds();
    await act(async () => document.querySelector<HTMLElement>(".row[data-thread=e1]")?.click());
    expect(rowIds()).toEqual(before);
    await press("e");
    expect(rowIds()).not.toContain("e1");
  });
});

describe("a sender with no name", () => {
  test("the row reads the address's local part, prettified, or the local part as written", async () => {
    const [a, b] = fixtureThreads as [Thread, Thread];
    const inbox = fixtureInbox([
      { ...a, id: "n1", messageCount: 1, participants: [{ name: "", email: "aoife.byrne@x.dev" }] },
      {
        ...b,
        id: "n2",
        messageCount: 1,
        participants: [{ name: "", email: "noreply@github.com" }],
      },
    ]);
    await mount({ inbox });
    const from = (id: string) =>
      document.querySelector(`.row[data-thread=${id}] .from`)?.textContent?.trim();
    expect(from("n1")).toBe("Aoife Byrne");
    expect(from("n2")).toBe("noreply");
  });
});

/**
 * Layout for happy-dom, which has none: a 600px list, 44px rows, 40px
 * Section headings. Restored after each test that installs it.
 */
function fakeLayout(): () => void {
  const proto = HTMLElement.prototype;
  const saved = {
    offsetHeight: Object.getOwnPropertyDescriptor(proto, "offsetHeight"),
    clientHeight: Object.getOwnPropertyDescriptor(proto, "clientHeight"),
  };
  Object.defineProperty(proto, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("row") ? 44 : this.classList.contains("sec") ? 40 : 0;
    },
  });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("vlist") ? 600 : 0;
    },
  });
  return () => {
    for (const [k, d] of Object.entries(saved)) if (d) Object.defineProperty(proto, k, d);
  };
}

/** Many Threads over the four shipped Sections, newest first. */
function bigInbox(n = 2000): InboxData {
  const base = fixtureThreads[0] as Thread;
  const sectionsFor = ["needs-reply", "waiting", "fyi", "newsletters"];
  const seed: Thread[] = Array.from({ length: n }, (_, i) => ({
    ...base,
    id: `t${i}`,
    subject: `Thread number ${i}`,
    section: sectionsFor[Math.floor((i * 4) / n)] ?? "fyi",
    lastActivity: new Date(Date.UTC(2026, 8, 16, 9) - i * 60_000).toISOString(),
    unread: i % 3 === 0,
  }));
  return fixtureInbox(seed);
}

describe("a long stream renders only what is near the view", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });
  const scroller = () => document.querySelector<HTMLElement>(".list .vlist");

  test("2,000 Threads put far fewer rows in the DOM, and the overscan is a Setting", async () => {
    restore = fakeLayout();
    await mount({ inbox: bigInbox() });
    const count = rowIds().length;
    // 600px of 44px rows is 14 on screen, plus 10 below (the default overscan).
    expect(count).toBeLessThan(40);
    expect(count).toBeGreaterThan(14);
    expect(rowIds()[0]).toBe("t0");
    await act(async () => root?.unmount());
    root = null;
    await mount({ inbox: bigInbox() }, { "inbox.overscan_rows": 2 });
    expect(rowIds().length).toBeLessThan(count);
    // Scrolling moves the window: the top rows go, rows further down come.
    const el = scroller();
    if (!el) throw new Error("no scroller");
    el.scrollTop = 44 * 1000;
    await act(async () => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(rowIds()).not.toContain("t0");
    expect(rowIds().length).toBeLessThan(40);
    const at = rowIds().map((id) => Number(id?.slice(1)));
    expect(Math.min(...at)).toBeGreaterThan(900);
    expect(Math.max(...at)).toBeLessThan(1100);
  });

  test("a list mounted hidden (a Workspace kept behind the one on show) stays windowed", async () => {
    // Styled (the --row-h token is there) but no height: display none.
    restore = fakeLayout();
    const proto = HTMLElement.prototype;
    const client = Object.getOwnPropertyDescriptor(proto, "clientHeight");
    Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 0 });
    document.documentElement.style.setProperty("--row-h", "44px");
    try {
      await mount({ inbox: bigInbox() });
      expect(rowIds().length).toBeLessThan(40);
      expect(rowIds()[0]).toBe("t0");
    } finally {
      if (client) Object.defineProperty(proto, "clientHeight", client);
      document.documentElement.style.removeProperty("--row-h");
    }
  });

  test("a missing overscan Setting (a stale settings object) still renders rows", async () => {
    restore = fakeLayout();
    await mount({ inbox: bigInbox() }, { "inbox.overscan_rows": undefined as unknown as number });
    expect(rowIds().length).toBeGreaterThan(14);
    expect(rowIds()[0]).toBe("t0");
  });

  test("J walks to the last Thread, which ends in view", async () => {
    restore = fakeLayout();
    // From row 1,900 (opened, then the sheet closed) J walks the rest of the way.
    await mount({ inbox: bigInbox(), initialOpen: "t1900" });
    await press("Escape");
    for (let i = 0; i < 120; i++) await press("j");
    const focused = document.querySelector<HTMLElement>(".row.on");
    expect(focused?.dataset.thread).toBe("t1999");
    expect(rowIds().length).toBeLessThan(40);
    expect(scroller()?.scrollTop ?? 0).toBeGreaterThan(44 * 1980);
  }, 120_000);

  test("a list held in part asks for more when a scroll or J nears its end, not before", async () => {
    restore = fakeLayout();
    const asked: string[] = [];
    const data: InboxData = { ...bigInbox(300), more: (list) => asked.push(list) };
    await mount({ inbox: data }, { "inbox.memory_grow_rows": 20 });
    const el = scroller();
    if (!el) throw new Error("no scroller");
    // Near the top: nothing asked.
    el.scrollTop = 44 * 50;
    await act(async () => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(asked).toEqual([]);
    // Within 20 rows of the end.
    el.scrollTop = 44 * 270;
    await act(async () => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(asked).toContain("inbox");
    asked.length = 0;
    await act(async () => root?.unmount());
    root = null;
    await mount({ inbox: data, initialOpen: "t295" }, { "inbox.memory_grow_rows": 20 });
    await press("Escape");
    await press("j");
    expect(asked).toEqual(["inbox"]);
  });

  test("opening a Thread 500 rows down scrolls it into view", async () => {
    restore = fakeLayout();
    await mount({ inbox: bigInbox(), initialOpen: "t500" });
    expect(reader()).toBe("t500");
    const row = document.querySelector<HTMLElement>(".row[data-thread=t500]");
    expect(row?.classList.contains("on")).toBe(true);
    const top = scroller()?.scrollTop ?? 0;
    // Row 500 sits 500 rows and a heading or two down, at the bottom edge of the view.
    expect(top).toBeGreaterThan(44 * 480);
    expect(top).toBeLessThan(44 * 510);
    expect(rowIds().length).toBeLessThan(40);
  });
});

describe("the Filter menu", () => {
  const button = () => document.querySelector<HTMLButtonElement>(".list .filter-btn");
  const menu = () => [...document.querySelectorAll<HTMLButtonElement>(".filter-pop .pop-item")];
  const pick = async (label: string) => {
    await act(async () => button()?.click());
    await act(async () =>
      menu()
        .find((b) => b.textContent?.startsWith(label))
        ?.click(),
    );
  };

  test("Unread keeps the unread Threads, shows on the button, and Esc clears it", async () => {
    await mount();
    await act(async () => button()?.click());
    expect(menu().map((b) => b.textContent)).toEqual([
      "Unread",
      "Starred",
      "Has attachments",
      "Needs a reply",
    ]);
    await act(async () => menu()[0]?.click());
    expect(rowIds()).toEqual(["e1", "e2"]);
    expect(button()?.textContent).toContain("Unread");
    expect(button()?.classList.contains("on")).toBe(true);
    await press("Escape");
    expect(rowIds().length).toBe(11);
    expect(button()?.textContent).toContain("Filter");
  });

  test("Needs a reply and Starred narrow the list; Clear lifts the filter", async () => {
    await mount();
    await pick("Needs a reply");
    expect(rowIds()).toEqual(["e1", "e2", "e3"]);
    await pick("Starred");
    expect(rowIds()).toEqual(["e2"]);
    await pick("Clear");
    expect(rowIds().length).toBe(11);
  });

  test("a Thread read under Unread stays until the filter changes", async () => {
    await mount();
    await pick("Unread");
    await act(async () => document.querySelector<HTMLElement>(".row[data-thread=e1]")?.click());
    expect(reader()).toBe("e1");
    expect(rowIds()).toEqual(["e1", "e2"]);
    await pick("Clear");
  });
});

describe("the inline search", () => {
  const input = () => document.querySelector<HTMLInputElement>(".list .list-search input");

  test("typing filters the stream to one ranked list with the match marked", async () => {
    await mount();
    await type(input(), "invoice");
    expect(rowIds()).toEqual(["e7"]);
    expect(document.querySelector(".row[data-thread=e7] mark")?.textContent).toBe("Invoice");
    await type(input(), "nothing like this");
    expect(rowIds()).toEqual([]);
    expect(document.querySelector(".empty-line")?.textContent).toBe("Nothing matches");
  });

  test("it composes with the Filter menu", async () => {
    await mount();
    await act(async () => document.querySelector<HTMLButtonElement>(".list .filter-btn")?.click());
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>(".filter-pop .pop-item")][0]?.click(),
    );
    await type(input(), "term sheet");
    expect(rowIds()).toEqual(["e2"]);
    await type(input(), "invoice");
    expect(rowIds()).toEqual([]);
    await type(input(), "");
    await press("Escape");
  });

  test("a result opens the reader", async () => {
    await mount();
    await type(input(), "receipt");
    expect(rowIds()).toEqual(["e9"]);
    await act(async () => document.querySelector<HTMLElement>(".row[data-thread=e9]")?.click());
    expect(reader()).toBe("e9");
  });

  test("the search module ranks the results and gives their passages", async () => {
    const [e9, e7] = ["e9", "e7"].map((id) => fixtureThreads.find((t) => t.id === id) as Thread);
    const asked: string[] = [];
    const hit = (thread: Thread | undefined, snippet: string, score: number) => ({
      thread,
      tags: [],
      workspaceId: "w",
      account: "",
      snippet,
      score,
      pinned: false,
    });
    const search = {
      search: async (text: string) => {
        asked.push(text);
        return { hits: [hit(e9, "paid in full", 2), hit(e7, "", 1)], older: [], elapsedMs: 1 };
      },
      remember: async () => {},
    } as unknown as SearchModule;
    await mount({ search });
    await type(input(), "paid");
    expect(asked).toEqual(["paid"]);
    expect(rowIds()).toEqual(["e9", "e7"]);
    expect(document.querySelector(".row[data-thread=e9] .snip")?.textContent).toBe("paid in full");
  });

  test("Esc puts the stream back where it was, scroll and focus", async () => {
    const restore = fakeLayout();
    try {
      await mount({ inbox: bigInbox(), initialOpen: "t800" });
      await press("Escape");
      const el = document.querySelector<HTMLElement>(".list .vlist");
      const scrolled = el?.scrollTop ?? 0;
      expect(scrolled).toBeGreaterThan(44 * 780);
      await act(async () => input()?.focus());
      await type(input(), "number 12");
      expect(rowIds()[0]).toBe("t12");
      expect(el?.scrollTop).toBe(0);
      await press("Escape");
      expect(input()?.value).toBe("");
      expect(el?.scrollTop).toBe(scrolled);
      expect(document.querySelector<HTMLElement>(".row.on")?.dataset.thread).toBe("t800");
    } finally {
      restore();
    }
  });

  test("searchRequest focuses the field and selects its text", async () => {
    const { rerender } = await mount({ searchRequest: 0 });
    expect(document.activeElement).not.toBe(input());
    await type(input(), "term");
    await act(async () => input()?.blur());
    await rerender({ searchRequest: 1 });
    expect(document.activeElement).toBe(input());
    expect(input()?.selectionStart).toBe(0);
    expect(input()?.selectionEnd).toBe(4);
  });
});
