/// <reference types="bun-types" />
// monday's Select through the DOM (happy-dom): a button that opens a listbox
// in a portal with the current option selected and focused; arrows, Home and
// End move, Enter or Space picks, typing jumps, Escape closes and gives the
// focus back; a press outside closes without picking; on the closed button
// the arrows open the list and typing picks as a native select does.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { Select, type SelectOption, typeaheadIndex } from "./components/select.tsx";
import { dom } from "./test-dom.ts";

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

const FRUIT: SelectOption<string>[] = [
  { value: "apple", label: "Apple" },
  { value: "apricot", label: "Apricot" },
  { value: "banana", label: "Banana" },
  { value: "cherry", label: "Cherry", detail: "red" },
  { value: "blueberry", label: "Blueberry", group: "Berries" },
];

let changes: string[] = [];
function Harness({ initial = "banana" }: { initial?: string | undefined }) {
  const [value, setValue] = useState(initial);
  return (
    <Select
      label="Fruit"
      value={value}
      options={FRUIT}
      onChange={(v) => {
        changes.push(v);
        setValue(v);
      }}
    />
  );
}

async function mount(initial?: string) {
  changes = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  await act(async () => r.render(<Harness initial={initial} />));
}

const button = () => document.querySelector<HTMLButtonElement>("button.dd") as HTMLButtonElement;
const listbox = () => document.querySelector<HTMLElement>("[role='listbox']");
const options = () => [...document.querySelectorAll<HTMLElement>("[role='option']")];
const focused = () => (document.activeElement as HTMLElement | null)?.textContent ?? "";

async function key(target: Element | null, k: string) {
  if (!target) throw new Error("no target");
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}
async function click(el: Element | null | undefined) {
  if (!el) throw new Error("nothing to click");
  await act(async () => (el as HTMLElement).click());
}

describe("Select", () => {
  test("the button names the choice and says it opens a listbox", async () => {
    await mount();
    const b = button();
    expect(b.getAttribute("aria-haspopup")).toBe("listbox");
    expect(b.getAttribute("aria-expanded")).toBe("false");
    expect(b.getAttribute("aria-label")).toBe("Fruit");
    expect(b.querySelector(".dd-value")?.textContent).toBe("Banana");
    expect(listbox()).toBeNull();
  });

  test("a click opens the list in a portal, the current option selected and focused", async () => {
    await mount();
    await click(button());
    expect(button().getAttribute("aria-expanded")).toBe("true");
    const list = listbox();
    expect(list?.getAttribute("aria-label")).toBe("Fruit");
    // In the body, not inside the host that holds the button.
    expect(host?.contains(list ?? null)).toBe(false);
    expect(button().getAttribute("aria-controls")).toBe(list?.id ?? "x");
    expect(options().map((o) => o.getAttribute("aria-selected"))).toEqual([
      "false",
      "false",
      "true",
      "false",
      "false",
    ]);
    expect(focused()).toContain("Banana");
    expect(document.querySelector(".dd-float .pop-h")?.textContent).toBe("Berries");
    expect(options()[3]?.querySelector(".when")?.textContent).toBe("red");
  });

  test("arrows, Home and End move; Enter picks, closes and gives the focus back", async () => {
    await mount();
    await click(button());
    await key(document.activeElement, "ArrowDown");
    expect(focused()).toContain("Cherry");
    await key(document.activeElement, "ArrowUp");
    await key(document.activeElement, "ArrowUp");
    expect(focused()).toContain("Apricot");
    await key(document.activeElement, "End");
    expect(focused()).toContain("Blueberry");
    await key(document.activeElement, "Home");
    expect(focused()).toContain("Apple");
    await key(document.activeElement, "Enter");
    expect(changes).toEqual(["apple"]);
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(button());
    expect(button().textContent).toBe("Apple");
  });

  test("Space picks too; picking the current option changes nothing", async () => {
    await mount();
    await click(button());
    await key(document.activeElement, " ");
    expect(changes).toEqual([]);
    expect(listbox()).toBeNull();
  });

  test("typing jumps to the option that starts with it, again to the next one", async () => {
    await mount();
    await click(button());
    await key(document.activeElement, "a");
    expect(focused()).toContain("Apple");
    await key(document.activeElement, "a");
    expect(focused()).toContain("Apricot");
    await key(document.activeElement, "c");
    // "aac" matches nothing; the focus stays.
    expect(focused()).toContain("Apricot");
  });

  test("Escape closes without picking and gives the focus back; it goes no further", async () => {
    await mount();
    let reached = false;
    const spy = (e: KeyboardEvent) => {
      if (e.key === "Escape") reached = true;
    };
    document.addEventListener("keydown", spy);
    await click(button());
    await key(document.activeElement, "ArrowDown");
    await key(document.activeElement, "Escape");
    document.removeEventListener("keydown", spy);
    expect(reached).toBe(false);
    expect(listbox()).toBeNull();
    expect(changes).toEqual([]);
    expect(document.activeElement).toBe(button());
  });

  test("a press outside closes it without picking", async () => {
    await mount();
    await click(button());
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(listbox()).toBeNull();
    expect(changes).toEqual([]);
  });

  test("a click on an option picks it", async () => {
    await mount();
    await click(button());
    await click(options()[3]);
    expect(changes).toEqual(["cherry"]);
    expect(button().textContent).toBe("Cherry");
  });

  test("on the closed button ArrowDown opens the list, and typing picks without opening", async () => {
    await mount();
    await key(button(), "c");
    expect(changes).toEqual(["cherry"]);
    expect(listbox()).toBeNull();
    await key(button(), "ArrowDown");
    expect(listbox()).not.toBeNull();
    expect(focused()).toContain("Cherry");
  });
});

describe("typeaheadIndex", () => {
  const labels = FRUIT.map((f) => f.label);
  test("a letter finds the next match after the current one and wraps", () => {
    expect(typeaheadIndex(labels, "a", 2)).toBe(0);
    expect(typeaheadIndex(labels, "a", 0)).toBe(1);
    expect(typeaheadIndex(labels, "b", 2)).toBe(4);
  });
  test("a longer query matches from the current option on", () => {
    expect(typeaheadIndex(labels, "ban", 2)).toBe(2);
    expect(typeaheadIndex(labels, "blu", 0)).toBe(4);
  });
  test("one letter repeated cycles through that letter", () => {
    expect(typeaheadIndex(labels, "aa", 0)).toBe(1);
  });
  test("no match is null", () => {
    expect(typeaheadIndex(labels, "z", 0)).toBeNull();
    expect(typeaheadIndex(labels, "", 0)).toBeNull();
  });
});
