/// <reference types="bun-types" />
// The phone form through the DOM (happy-dom), under a StaticShell that says
// "phone": one column at a time. The list opens the reader as a full screen
// with a back arrow, and back (the arrow, the system back as a popstate, a
// swipe in from the left edge on iOS) walks the stack: reader, agent sheet,
// drawer, a screen over the Inbox. Rows take touch: a swipe runs the action
// its direction's Setting names with the usual Undo, a long press starts a
// selection, a pull from the top syncs, and a trailing button opens what a
// hover would show. The sidebar is a drawer; Settings is a list, then a page;
// the Calendar opens on Agenda; a phone or tablet OS hides what is about a
// computer: the window frame, the Config file, the keymap, the Local
// runtimes, the background service, and says which Server it is paired with.

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { PartialSettings } from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { App } from "../App.tsx";
import { formOf, mobileOs, mobileOsOfAgent } from "../platform/form.ts";
import { type WindowFrame as Frame, fakePlatform } from "../platform/tauri.ts";
import { Calendar } from "../screens/Calendar.tsx";
import { fixtureCalendar } from "../screens/calendar/calendar-data.ts";
import { fixtureComposer } from "../screens/compose/composer.ts";
import { Inbox, type InboxProps } from "../screens/Inbox.tsx";
import {
  fixtureInbox,
  type InboxActions,
  type Inbox as InboxData,
} from "../screens/inbox/actions.ts";
import { Settings } from "../screens/Settings.tsx";
import { resetDisclosures } from "../screens/settings/disclosure.tsx";
import { createBackStack, resetBackStack } from "./back.ts";
import { type ShellState, StaticShell, useShell } from "./Shell.tsx";
import { WindowFrame } from "./WindowFrame.tsx";

let createRoot: Awaited<ReturnType<typeof dom>>["createRoot"];
beforeAll(async () => {
  ({ createRoot } = await dom());
});

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
  resetBackStack();
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  resetDisclosures();
  delete document.documentElement.dataset.form;
  delete document.documentElement.dataset.mobile;
});

type ShellOverrides = Partial<Pick<ShellState, "form" | "mobile" | "cloud" | "server">>;

async function render(node: ReactNode, shell: ShellOverrides, settings: PartialSettings = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  await act(async () =>
    r.render(
      <StaticShell shell={shell} settings={{ "ai.level": "automate", ...settings }}>
        {node}
      </StaticShell>,
    ),
  );
  await settle();
}

const settle = () => act(async () => Bun.sleep(10));
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const qa = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const row = (id: string) => q(`.row[data-thread="${id}"]`);
const reader = () => q(".reader")?.dataset.thread ?? null;
const toast = () => q(".toast")?.textContent ?? null;
const picked = () => qa(".row.picked").map((r) => r.dataset.thread);

async function click(el: Element | null | undefined) {
  if (!el) throw new Error("nothing to click");
  await act(async () => (el as HTMLElement).click());
  await settle();
}

/** A finger: down at one point, through the moves, and up at the last. */
async function touch(
  target: Element | Document | null,
  points: ReadonlyArray<readonly [number, number]>,
  holdMs = 0,
) {
  if (!target) throw new Error("nothing to touch");
  const at = (p: readonly [number, number]) => [{ clientX: p[0], clientY: p[1], target }];
  const fire = (type: string, p: readonly [number, number], down: boolean) =>
    target.dispatchEvent(
      new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: (down ? at(p) : []) as unknown as Touch[],
        changedTouches: at(p) as unknown as Touch[],
      }),
    );
  const [first, ...rest] = points;
  if (!first) return;
  await act(async () => {
    fire("touchstart", first, true);
  });
  if (holdMs > 0) await act(async () => Bun.sleep(holdMs));
  for (const p of rest) {
    await act(async () => {
      fire("touchmove", p, true);
    });
  }
  await act(async () => {
    fire("touchend", rest.at(-1) ?? first, false);
  });
  await settle();
}

async function systemBack() {
  await act(async () => {
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
  });
  await settle();
}

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
      ...inbox,
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

async function inbox(
  shell: ShellOverrides = { form: "phone" },
  settings: PartialSettings = {},
  props: Partial<InboxProps> = {},
) {
  const s = spy(fixtureInbox());
  await render(
    <Inbox
      now={new Date(2026, 8, 16, 10, 0)}
      initialOpen={null}
      timing={{ collapse: 0, toast: 60_000 }}
      {...props}
      inbox={s.inbox}
    />,
    shell,
    settings,
  );
  return s;
}

describe("the form", () => {
  test("phone under the breakpoint; on a mobile OS the shorter side counts; 0 never switches", () => {
    expect(formOf({ width: 500, height: 900 }, 720, null)).toBe("phone");
    expect(formOf({ width: 1024, height: 700 }, 720, null)).toBe("desktop");
    // A phone turned sideways stays one column.
    expect(formOf({ width: 900, height: 420 }, 720, "android")).toBe("phone");
    expect(formOf({ width: 400, height: 800 }, 0, "ios")).toBe("desktop");
  });

  test("the platform's word wins over the user agent, which decides otherwise", () => {
    expect(mobileOs({ kind: "android" })).toBe("android");
    expect(mobileOs({ os: "ios" })).toBe("ios");
    expect(mobileOs({ kind: "desktop" })).toBeNull();
    expect(mobileOsOfAgent("Mozilla/5.0 (Linux; Android 15; Pixel 9)")).toBe("android");
    expect(mobileOsOfAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("ios");
    // iPadOS asks for the desktop site; its touch points give it away.
    expect(mobileOsOfAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe("ios");
    expect(mobileOsOfAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBeNull();
    expect(mobileOsOfAgent("Mozilla/5.0 (X11; Linux x86_64)")).toBeNull();
  });

  test("the shell writes the form on the root and lays the phone out one column at a time", async () => {
    await inbox({ form: "phone" }, { "layout.list": "split", "layout.nav": "full" });
    expect(document.documentElement.dataset.form).toBe("phone");
    // The split knob gives way: the stream, with the reader over it.
    expect(q(".reader")).toBeNull();
  });
});

describe("the back stack", () => {
  test("back closes the newest layer first; a layer closed on screen leaves the stack", () => {
    const stack = createBackStack(null);
    const closed: string[] = [];
    const releaseA = stack.push(() => closed.push("a"));
    stack.push(() => closed.push("b"));
    expect(stack.back()).toBe(true);
    expect(closed).toEqual(["b"]);
    releaseA();
    expect(stack.depth()).toBe(1);
  });
});

describe("the list and the reader on a phone", () => {
  test("list, then the reader full screen with a back arrow, then back to the list", async () => {
    await inbox();
    expect(reader()).toBeNull();
    await click(row("e1"));
    expect(reader()).toBe("e1");
    expect(q(".reader.sheet")).not.toBeNull();
    const back = q(".reader .phone-back");
    expect(back?.getAttribute("aria-label")).toBe("Back");
    await click(back);
    expect(reader()).toBeNull();
    expect(row("e1")).not.toBeNull();
  });

  test("the system back (a popstate) closes the reader", async () => {
    await inbox();
    await click(row("e2"));
    expect(reader()).toBe("e2");
    await systemBack();
    expect(reader()).toBeNull();
  });

  test("the reader's header keeps archive, snooze, delete and Ask; move and read sit under More", async () => {
    await inbox();
    await click(row("e1"));
    const head = qa(".reader .col-head .btn").map(
      (b) => b.getAttribute("aria-label") ?? b.getAttribute("title"),
    );
    expect(head).toEqual(["Back", "Archive", "Snooze", "Delete", "Ask", "More"]);
    await click(q('.reader .col-head .btn[title="More"]'));
    const items = qa(".reader .pop .pop-item").map((b) => b.textContent);
    expect(items).toContain("Move");
    expect(items.some((t) => t === "Mark read" || t === "Mark unread")).toBe(true);
  });

  test("a desktop keeps its header and no back arrow", async () => {
    await inbox({ form: "desktop" });
    await click(row("e1"));
    expect(q(".reader .phone-back")).toBeNull();
    expect(q(".row .row-more")).toBeNull();
  });
});

describe("touch on the rows", () => {
  test("a swipe right archives, with the usual Undo", async () => {
    const { calls } = await inbox();
    await touch(row("e1"), [
      [40, 20],
      [80, 22],
      [200, 24],
    ]);
    expect(calls).toEqual(['archive:["e1"]']);
    expect(toast()).toContain("Archived");
    expect(toast()).toContain("Undo");
    // The swipe's click never opens the row.
    expect(reader()).toBeNull();
  });

  test("a swipe left opens the snooze choices for that row", async () => {
    const { calls } = await inbox();
    await touch(row("e2"), [
      [300, 20],
      [260, 22],
      [120, 24],
    ]);
    expect(calls).toEqual([]);
    expect(q(".pop")?.getAttribute("aria-label")).toBe("Snooze until");
  });

  test("a swipe that stops short does nothing", async () => {
    const { calls } = await inbox();
    await touch(row("e1"), [
      [40, 20],
      [60, 21],
      [90, 22],
    ]);
    expect(calls).toEqual([]);
    expect(q(".pop")).toBeNull();
  });

  test("each direction does what its Setting names", async () => {
    const { calls } = await inbox(
      { form: "phone" },
      { "inbox.swipe.right": "delete", "inbox.swipe.left": "star" },
    );
    await touch(row("e1"), [
      [40, 20],
      [80, 22],
      [200, 24],
    ]);
    await touch(row("e2"), [
      [300, 20],
      [260, 22],
      [120, 24],
    ]);
    expect(calls[0]).toBe('delete:["e1"]');
    expect(calls[1]).toMatch(/^(un)?star:\["e2"\]$/);
  });

  test("a long press starts a selection; then a tap picks rows instead of opening them", async () => {
    await inbox({ form: "phone" }, { "inbox.long_press_ms": 200 });
    await touch(row("e2"), [[100, 30]], 260);
    expect(picked()).toEqual(["e2"]);
    expect(q(".sel-bar")).not.toBeNull();
    // A tap: the finger, then the click the browser makes of it.
    await touch(row("e3"), [[100, 30]]);
    await click(row("e3"));
    expect(picked()).toEqual(["e2", "e3"]);
    expect(reader()).toBeNull();
  });

  test("a pull from the top syncs, and says so while it does", async () => {
    let synced = 0;
    let finish: () => void = () => {};
    await inbox(
      { form: "phone" },
      { "inbox.pull_refresh_px": 72 },
      {
        onRefresh: () => {
          synced++;
          return new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
      },
    );
    await touch(row("e1"), [
      [100, 10],
      [102, 40],
      [104, 220],
    ]);
    expect(synced).toBe(1);
    expect(q(".pull")?.dataset.state).toBe("syncing");
    expect(q(".pull")?.textContent).toBe("Syncing");
    await act(async () => finish());
    await settle();
    expect(q(".pull")).toBeNull();
  });

  test("a pull released early does not sync", async () => {
    let synced = 0;
    await inbox(
      { form: "phone" },
      {},
      {
        onRefresh: async () => {
          synced++;
        },
      },
    );
    await touch(row("e1"), [
      [100, 10],
      [101, 40],
      [102, 70],
    ]);
    expect(synced).toBe(0);
    expect(q(".pull")).toBeNull();
  });

  test("every row has an actions button, where a hover would show them; it runs them by tap", async () => {
    const { calls } = await inbox();
    const rows = qa(".row");
    expect(qa(".row .row-more")).toHaveLength(rows.length);
    expect(q(".row .row-more")?.getAttribute("aria-label")).toBe("Actions");
    await click(row("e1")?.querySelector(".row-more"));
    const items = qa(".col.list .pop .pop-item").map((b) => b.textContent);
    expect(items).toEqual(
      expect.arrayContaining(["Archive", "Snooze", "Delete", "Move to", "Select"]),
    );
    await click(qa(".col.list .pop .pop-item").find((b) => b.textContent === "Archive"));
    expect(calls).toEqual(['archive:["e1"]']);
    expect(reader()).toBeNull();
  });
});

describe("the agent on a phone", () => {
  test("its bar sits at the bottom; it opens as a sheet, and back closes the sheet", async () => {
    await inbox();
    const bar = q<HTMLTextAreaElement>(".agent-dock .agent-bar textarea");
    expect(bar).not.toBeNull();
    expect(q(".agent-panel")).toBeNull();
    await act(async () => bar?.focus());
    await settle();
    expect(q(".agent-dock .agent-panel")).not.toBeNull();
    await systemBack();
    expect(q(".agent-dock .agent-panel")).toBeNull();
  });
});

async function app(shell: ShellOverrides, settings: PartialSettings = {}) {
  const NOW = new Date("2026-09-16T10:00:00");
  await render(
    <App
      inbox={fixtureInbox()}
      composer={fixtureComposer({ drafts: [], now: () => NOW })}
      agentClient={null}
      accounts={null}
      keys={null}
      now={NOW}
      calendar={fixtureCalendar({})}
    />,
    shell,
    settings,
  );
}

const navItem = (label: string) =>
  qa(".nav .nav-item").find((b) => b.querySelector("span")?.textContent?.trim() === label);
const listTitle = () => q(".col.list .col-head h2")?.textContent;

describe("the drawer", () => {
  test("no sidebar column; the menu button opens it, a pick goes there and closes it", async () => {
    await app({ form: "phone" });
    expect(q(".app > .nav")).toBeNull();
    expect(q(".phone-drawer")).toBeNull();
    await click(q(".col.list .phone-menu"));
    expect(q(".phone-drawer .nav")).not.toBeNull();
    await click(navItem("Starred"));
    expect(q(".phone-drawer")).toBeNull();
    expect(listTitle()).toBe("Starred");
  });

  test("back closes the drawer, then takes a screen back to the Inbox", async () => {
    await app({ form: "phone" });
    await click(q(".col.list .phone-menu"));
    await click(navItem("Calendar"));
    expect(q(".cal-view")).not.toBeNull();
    await click(q(".phone-menu"));
    expect(q(".phone-drawer")).not.toBeNull();
    await systemBack();
    expect(q(".phone-drawer")).toBeNull();
    expect(q(".cal-view")).not.toBeNull();
    await systemBack();
    expect(listTitle()).toBe("Inbox");
  });

  test("on iOS a swipe in from the left edge goes back; on Android only when the Setting says on", async () => {
    await app({ form: "phone", mobile: "ios" });
    await click(q(".col.list .phone-menu"));
    expect(q(".phone-drawer")).not.toBeNull();
    await touch(document, [
      [6, 300],
      [60, 302],
      [180, 305],
    ]);
    expect(q(".phone-drawer")).toBeNull();
    await act(async () => root?.unmount());
    root = null;
    host?.remove();

    await app({ form: "phone", mobile: "android" });
    await click(q(".col.list .phone-menu"));
    await touch(document, [
      [6, 300],
      [60, 302],
      [180, 305],
    ]);
    expect(q(".phone-drawer")).not.toBeNull();
  });

  test("a desktop shows the sidebar and no menu button", async () => {
    await app({ form: "desktop" });
    expect(q(".app > .nav")).not.toBeNull();
    expect(q(".phone-menu")).toBeNull();
  });
});

describe("the Calendar on a phone", () => {
  test("opens on calendar.phone_view, Agenda by default, where a week does not fit", async () => {
    const now = new Date("2026-09-16T10:00:00");
    await render(<Calendar source={fixtureCalendar({})} now={now} />, { form: "phone" });
    expect(q(".seg .on")?.textContent).toBe("Agenda");
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    await render(
      <Calendar source={fixtureCalendar({})} now={now} />,
      { form: "phone" },
      {
        "calendar.phone_view": "day",
      },
    );
    expect(q(".seg .on")?.textContent).toBe("Day");
  });
});

const sectionButton = (name: string) =>
  qa(".settings-nav .nav-item").find((b) => b.textContent?.trim() === name);

describe("Settings on a phone", () => {
  test("the sections as a list, then one as a page with a back arrow", async () => {
    await render(<Settings workspaceId="ws-1" />, { form: "phone" });
    expect(q(".settings")?.dataset.phone).toBe("list");
    await click(sectionButton("Appearance"));
    expect(q(".settings")?.dataset.phone).toBe("page");
    expect(q(".settings-head h1")?.textContent).toBe("Appearance");
    await click(q(".settings-search .phone-back"));
    expect(q(".settings")?.dataset.phone).toBe("list");
    await click(sectionButton("AI and agent") ?? sectionButton("AI"));
    await systemBack();
    expect(q(".settings")?.dataset.phone).toBe("list");
  });

  test("a section asked for by name opens on its page", async () => {
    await render(<Settings workspaceId="ws-1" initialSection="server" />, { form: "phone" });
    expect(q(".settings")?.dataset.phone).toBe("page");
  });
});

describe("a phone or tablet OS hides what is about a computer", () => {
  const paired: ShellOverrides = {
    form: "phone",
    mobile: "android",
    cloud: { baseUrl: "https://mail.example.com", token: "t", deviceId: "d" },
    server: { kind: "cloud", target: { baseUrl: "https://mail.example.com", token: "t" } },
  };

  test("AI: only the Server's Hosted runtime, no Local runtime choices", async () => {
    await render(<Settings workspaceId="ws-1" initialSection="ai" />, paired);
    expect(q('[data-setting="ai.mode"]')).toBeNull();
    expect(qa('[data-setting^="ai.local."]')).toHaveLength(0);
    // The desktop shows the choice.
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    await render(<Settings workspaceId="ws-1" initialSection="ai" />, { form: "phone" });
    expect(q('[data-setting="ai.mode"]')).not.toBeNull();
  });

  test("Appearance has no Config file and Shortcuts no keymap", async () => {
    await render(<Settings workspaceId="ws-1" initialSection="appearance" />, paired);
    expect(q('[data-panel="config"]')).toBeNull();
    await click(q(".settings-search .phone-back"));
    await click(sectionButton("Shortcuts"));
    expect(q('[data-setting="keyboard.keymap"]')).toBeNull();
  });

  test("Server says which Server it is paired with, and has no background service", async () => {
    await render(<Settings workspaceId="ws-1" initialSection="server" />, paired);
    const card = q('[data-panel="paired-server"]');
    expect(card?.textContent).toContain("Connected to mail.example.com");
    expect(card?.dataset.state).toBe("online");
    expect(q('[data-setting="server.sidecar.start_at_login"]')).toBeNull();
    expect(q('[data-setting="server.prefer"]')).toBeNull();
    // The summary's offers are about a computer that stays on.
    expect(q(".settings-in")?.textContent).not.toContain("Keep syncing while this computer is off");
  });

  test("Server, unreachable: it says it is looking for the paired one", async () => {
    await render(<Settings workspaceId="ws-1" initialSection="server" />, {
      ...paired,
      server: null,
    });
    expect(q('[data-panel="paired-server"]')?.textContent).toContain(
      "Not connected. monday is looking for mail.example.com.",
    );
  });

  test("search finds nothing it leaves off", async () => {
    await render(<Settings workspaceId="ws-1" />, paired);
    const input = q<HTMLInputElement>(".settings-search input");
    await act(async () => {
      if (!input) return;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      set?.call(input, "monday.toml");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    expect(q(".settings-results")?.textContent ?? "").not.toContain("Config file");
  });

  test("the window frame never shows, even where the host offers one", async () => {
    const frame: Frame = {
      minimize: async () => {},
      toggleMaximize: async () => {},
      close: async () => {},
      startDragging: async () => {},
      isMaximized: async () => false,
      onResized: () => () => {},
    };
    const p = fakePlatform("", { frame });
    await render(<WindowFrame load={async () => p} />, { mobile: "ios" });
    expect(q(".titlebar")).toBeNull();
    expect(document.documentElement.dataset.titlebar).toBeUndefined();
  });

  test("the agent runs Hosted on a mobile OS whatever the stored mode", async () => {
    let seen: string | null = null;
    function Read() {
      seen = useShell().settings["ai.mode"];
      return null;
    }
    await render(<Read />, { mobile: "android" }, { "ai.mode": "local" });
    expect(seen as string | null).toBe("hosted");
  });
});
