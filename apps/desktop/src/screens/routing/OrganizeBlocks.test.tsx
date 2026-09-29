/// <reference types="bun-types" />
// The custom action editor through the DOM: its Group, Section and Tool
// pickers are monday's Select, named by their field labels, and what they
// pick is what the saved action carries.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { type CustomActionSetting, defaultSettings } from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { ActionsBlock } from "./OrganizeBlocks.tsx";

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

const s = defaultSettings();
const q = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);
const qa = <T extends Element = HTMLElement>(selector: string) => [
  ...document.querySelectorAll<T>(selector),
];

async function click(el: Element | null | undefined) {
  if (!el) throw new Error("nothing to click");
  await act(async () => (el as HTMLElement).click());
}
async function clickText(label: string, within: ParentNode = document) {
  const el = [...within.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => (b.textContent ?? "").trim() === label,
  );
  if (!el) throw new Error(`no button ${label}`);
  await click(el);
}
async function type(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error("no input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const select = (label: string) =>
  q<HTMLButtonElement>(`.rule-edit button.dd[aria-label="${label}"]`);
async function pick(label: string, option: string) {
  await click(select(label));
  await click(qa("[role='option']").find((o) => o.textContent === option));
}

async function mount(saved: CustomActionSetting[][]) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  await act(async () =>
    r.render(
      <ActionsBlock
        settings={s}
        actions={[]}
        onChange={(next) => saved.push(next)}
        groups={[
          { id: "g-receipts", name: "Receipts" },
          { id: "g-team", name: "Team" },
        ]}
        sections={[{ id: "sec-reading", name: "Reading" }]}
      />,
    ),
  );
}

describe("ActionsBlock pickers", () => {
  test("the Group and Tool pickers are Selects, and the saved action carries their picks", async () => {
    const saved: CustomActionSetting[][] = [];
    await mount(saved);
    await clickText(s["strings.actions.add"]);
    await type(q<HTMLInputElement>(".rule-edit label input"), "File the receipt");
    await clickText(s["strings.actions.on_group"], q(".rule-edit-row") ?? document);
    expect(select(s["strings.actions.on_group"])?.textContent).toBe(
      s["strings.settings.groups.none"],
    );
    await pick(s["strings.actions.on_group"], "Receipts");
    await pick(s["strings.actions.tool"], "archive_threads");
    expect(select(s["strings.actions.tool"])?.textContent).toBe("archive_threads");
    await clickText(s["strings.actions.save"]);
    expect(saved.at(-1)?.[0]).toMatchObject({
      label: "File the receipt",
      on: { group: "g-receipts" },
      tool: "archive_threads",
    });
  });

  test("the Section picker is a Select over the Sections", async () => {
    const saved: CustomActionSetting[][] = [];
    await mount(saved);
    await clickText(s["strings.actions.add"]);
    await type(q<HTMLInputElement>(".rule-edit label input"), "Read later");
    await clickText(s["strings.actions.on_section"], q(".rule-edit-row") ?? document);
    await pick(s["strings.actions.on_section"], "Reading");
    await clickText(s["strings.actions.save"]);
    expect(saved.at(-1)?.[0]?.on).toEqual({ section: "sec-reading" });
  });
});
