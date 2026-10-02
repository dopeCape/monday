/// <reference types="bun-types" />
// The phone form's sheets through the DOM (happy-dom): with data-form="phone"
// on the root, the Select's list opens as a sheet along the bottom, named by
// its label and with no position of its own; on a desktop it is placed under
// its button as before. The command palette shows a back arrow that closes
// it when it is given one (a phone has no Escape key).

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { CommandPalette } from "./components/command-palette.tsx";
import { Select } from "./components/select.tsx";
import { anchoredStyle, opensAsSheet } from "./placement.ts";
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
  delete document.documentElement.dataset.form;
});

async function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  await act(async () => r.render(node));
}

function Fruit() {
  const [value, setValue] = useState("apple");
  return (
    <Select
      label="Fruit"
      value={value}
      options={[
        { value: "apple", label: "Apple" },
        { value: "pear", label: "Pear" },
      ]}
      onChange={setValue}
    />
  );
}

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

async function open() {
  await act(async () => q<HTMLButtonElement>("button.dd")?.click());
}

describe("menus as sheets", () => {
  test("only the phone form opens menus as sheets", () => {
    expect(opensAsSheet()).toBe(false);
    document.documentElement.dataset.form = "phone";
    expect(opensAsSheet()).toBe(true);
  });

  test("a sheet takes no inline position; a placed menu hides until measured", () => {
    expect(anchoredStyle(null, true)).toEqual({});
    expect(anchoredStyle(null, false)).toEqual({ top: 0, left: 0, visibility: "hidden" });
    expect(anchoredStyle({ top: 40, left: 8, above: false }, false, 120)).toEqual({
      top: 40,
      left: 8,
      minWidth: 120,
    });
  });

  test("the Select on a phone: a sheet named by its label, picking still picks", async () => {
    document.documentElement.dataset.form = "phone";
    await mount(<Fruit />);
    await open();
    const pop = q(".pop.dd-float");
    expect(pop?.classList.contains("sheet")).toBe(true);
    expect(pop?.dataset.placement).toBe("sheet");
    expect(pop?.style.top).toBe("");
    expect(pop?.querySelector(".sheet-h")?.textContent).toBe("Fruit");
    await act(async () => q<HTMLButtonElement>('[role="option"][data-value="pear"]')?.click());
    expect(q(".pop.dd-float")).toBeNull();
    expect(q(".dd-value")?.textContent).toBe("Pear");
  });

  test("the Select on a desktop: under its button, no heading", async () => {
    await mount(<Fruit />);
    await open();
    const pop = q(".pop.dd-float");
    expect(pop?.classList.contains("sheet")).toBe(false);
    expect(pop?.querySelector(".sheet-h")).toBeNull();
  });
});

describe("the palette's back arrow", () => {
  const sections = [{ label: "Go to", items: [{ key: "inbox", label: "Inbox" }] }];

  test("given one, it shows in place of the search glyph and closes", async () => {
    let closed = 0;
    await mount(
      <CommandPalette
        sections={sections}
        strings={{ back: "Back" }}
        onClose={() => {
          closed += 1;
        }}
      />,
    );
    const back = q<HTMLButtonElement>(".cmdk-in .cmdk-back");
    expect(back?.getAttribute("aria-label")).toBe("Back");
    await act(async () => back?.click());
    expect(closed).toBe(1);
  });

  test("without one (a desktop) there is none", async () => {
    await mount(<CommandPalette sections={sections} onClose={() => {}} />);
    expect(q(".cmdk-back")).toBeNull();
  });
});
