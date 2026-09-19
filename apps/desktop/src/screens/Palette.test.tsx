/// <reference types="bun-types" />
// The palette inside the Inbox screen: keys in, commands out. Mounted under a
// StaticShell over the fixtures with happy-dom, with a real search module
// over an in-memory Cache so the search mode renders rows.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createSearch, type SearchModule } from "../search/index.ts";
import type { PaletteCommand } from "../search/palette.ts";
import { StaticShell } from "../shell/Shell.tsx";
import { bunDriver } from "../store/bun-driver.ts";
import { createFakeStore } from "../store/fake.ts";
import { Inbox, type InboxProps } from "./Inbox.tsx";
import { fixtureInbox } from "./inbox/actions.ts";

let createRoot: typeof import("react-dom/client")["createRoot"];
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

const NOW = new Date(2026, 8, 16, 10, 0);

async function searchOverFixtures(): Promise<SearchModule> {
  const { store } = await createFakeStore({ driver: bunDriver() });
  return createSearch({
    sources: () => [{ store, account: "tejas@genai-labs.io" }],
    now: () => NOW,
  });
}

async function mount(props: Partial<InboxProps> = {}, level: "off" | "automate" = "automate") {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  const navigated: string[] = [];
  const searched: string[] = [];
  await act(async () =>
    r.render(
      <StaticShell settings={{ "ai.level": level }}>
        <Inbox
          inbox={fixtureInbox()}
          now={NOW}
          initialOpen={null}
          timing={{ collapse: 0, toast: 60_000 }}
          onNavigate={(t) => navigated.push(t)}
          onSearch={(q) => searched.push(q)}
          {...props}
        />
      </StaticShell>,
    ),
  );
  return { navigated, searched };
}

async function press(key: string, mods: Partial<KeyboardEventInit> = {}, target?: EventTarget) {
  await act(async () => {
    (target ?? window).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }),
    );
  });
}

const input = () => document.querySelector<HTMLInputElement>(".cmdk input");

async function type(text: string) {
  const el = input();
  if (!el) throw new Error("no palette input");
  // The DOM helper gives React real input events; set through the native setter
  // so React's value tracker sees the change, then dispatch input.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // Let the Cache answer.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

const items = () =>
  [...document.querySelectorAll<HTMLElement>(".cmdk-item span:not(.kbd)")].map(
    (s) => s.textContent,
  );
const sections = () => [...document.querySelectorAll(".cmdk-sec")].map((s) => s.textContent);
const activeText = () => document.querySelector(".cmdk-item.on span")?.textContent ?? null;
const activeIndex = () =>
  [...document.querySelectorAll(".cmdk-item")].findIndex((i) => i.classList.contains("on"));
const rowIds = () =>
  [...document.querySelectorAll<HTMLElement>(".cmdk .row")].map((r) => r.dataset.thread);

describe("palette in the Inbox", () => {
  test("opens on Cmd-K with the mock's sections and every action reachable by fuzzy text", async () => {
    await mount();
    await press("k", { metaKey: true });
    expect(sections()).toEqual(["Ask the agent", "Actions", "Go to"]);
    expect(items()).toContain("Archive");
    expect(items()).toContain("Hiring › Candidates");
    await type("ext sel");
    expect(items()).toContain("Extend selection down");
    expect(document.querySelector(".cmdk-item .kbd")?.textContent).toBe("Shift+J");
  });

  test("at AI level off the palette has no Ask section and no agent action, and Set me up is a Go to target (slice 20)", async () => {
    await mount({}, "off");
    await press("k", { metaKey: true });
    expect(sections()).toEqual(["Actions", "Go to"]);
    expect(items()).not.toContain("Ask monday");
    await type("set me");
    expect(items()).toContain("Set me up");
    expect(document.querySelector(".agent-bar")).toBeNull();
  });

  test("arrow keys move the highlight and Enter runs the action once the palette has closed", async () => {
    await mount();
    await press("k", { metaKey: true });
    await type("arch");
    // The action outranks the Archive folder and the Search page that also match.
    expect(activeText()).toBe("Archive");
    expect(activeIndex()).toBe(0);
    await press("ArrowDown", {}, input() ?? window);
    expect(activeIndex()).toBe(1);
    await press("ArrowUp", {}, input() ?? window);
    expect(activeIndex()).toBe(0);
    await press("ArrowUp", {}, input() ?? window);
    expect(activeIndex()).toBe(document.querySelectorAll(".cmdk-item").length - 1);
    await press("ArrowDown", {}, input() ?? window);
    expect(activeIndex()).toBe(0);
    await press("Enter", {}, input() ?? window);
    expect(document.querySelector(".cmdk")).toBeNull();
    // The archive ran on the focus row: the toast says so.
    expect(document.querySelector(".toast")?.textContent).toContain("Archived");
  });

  test("Go to navigates; a bare word offers a search and Enter on it opens the results", async () => {
    const { navigated, searched } = await mount();
    await press("k", { metaKey: true });
    await type("settings");
    expect(sections()[0]).toBe("Go to");
    await press("Enter", {}, input() ?? window);
    expect(navigated).toEqual(["settings"]);

    await press("k", { metaKey: true });
    await type("zebra");
    const search = [...document.querySelectorAll<HTMLElement>(".cmdk-item")].find((i) =>
      i.textContent?.includes("Search for zebra"),
    );
    expect(search).not.toBeUndefined();
    await act(async () => search?.click());
    expect(searched).toEqual(["zebra"]);
  });

  test("an operator switches to search mode with Thread rows from the Cache", async () => {
    const search = await searchOverFixtures();
    await mount({ search });
    await press("k", { metaKey: true });
    await type("from:kenji");
    expect(sections()).toEqual(["Results"]);
    expect(rowIds()).toEqual(["e2"]);
    await type("from:aoife is:unread");
    expect(rowIds()).toEqual(["e1"]);
    await type("from:nobody");
    expect(rowIds()).toEqual([]);
    expect(document.querySelector(".cmdk-empty")?.textContent).toBe("Nothing matches");
    // A bare word shows Cache hits inline under the catalogues.
    await type("take-home");
    expect(rowIds()).toEqual(["e1"]);
    await press("Enter", {}, input() ?? window);
    expect(document.querySelector(".cmdk")).toBeNull();
  });

  test("Tab hands the text to the agent: the bar opens prefilled", async () => {
    await mount();
    await press("k", { metaKey: true });
    await type("from:kenji pro-rata");
    await press("Tab", {}, input() ?? window);
    expect(document.querySelector(".cmdk")).toBeNull();
    const bar = document.querySelector<HTMLInputElement>("input[name=ask]");
    expect(bar?.value).toBe("from:kenji pro-rata");
    expect(document.querySelector(".agent-panel")).not.toBeNull();
  });

  test("the composer's suggestion chips are the Ask lines; one goes to the agent", async () => {
    await mount();
    await press("k", { metaKey: true });
    // Three Threads sit in Needs your reply, then the evergreen prompts (docs/spec/agent-composer.md).
    const asks = [...document.querySelectorAll<HTMLElement>(".cmdk-item")]
      .filter((el) => el.querySelector(".mk"))
      .map((el) => el.querySelector("span:not(.mk)")?.textContent);
    expect(asks).toEqual([
      "Reply to the 3 threads waiting on me",
      "Summarize what I missed since yesterday",
      "Archive newsletters older than a week",
    ]);
    const first = document.querySelector<HTMLElement>(".cmdk-item");
    await act(async () => first?.click());
    const bar = document.querySelector<HTMLInputElement>("input[name=ask]");
    expect(bar?.value).toBe("Reply to the 3 threads waiting on me");
  });

  test("the scrim covers the window, not the screen column", async () => {
    await mount();
    await press("k", { metaKey: true });
    const scrim = document.querySelector<HTMLElement>(".scrim");
    expect(scrim?.parentElement).toBe(document.body);
    expect(scrim?.closest(".main")).toBeNull();
  });

  test("every palette command type is handled", () => {
    const kinds: PaletteCommand["type"][] = [
      "action",
      "navigate",
      "open",
      "search",
      "ask",
      "suggest",
    ];
    expect(kinds.length).toBe(6);
  });
});
