/// <reference types="bun-types" />
// The phone form's polish through the DOM (happy-dom), under a StaticShell
// that says "phone": what does not fit a narrow header moves behind a More
// button whose menu is a sheet along the bottom, anchored menus drop their
// position and open as sheets, compose has no Minimize (there is no dock),
// the list header carries New message, Workflows is a list and then one
// Workflow as a page, and the palette shows a back arrow where there is no
// Escape key. The desktop keeps every one of these as it was.

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { PartialSettings } from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { Calendar } from "../screens/Calendar.tsx";
import { fixtureCalendar } from "../screens/calendar/calendar-data.ts";
import { composeBus } from "../screens/compose/bus.ts";
import { fixtureComposer } from "../screens/compose/composer.ts";
import { AnchoredMenu } from "../screens/compose/Menu.tsx";
import { Inbox } from "../screens/Inbox.tsx";
import { fixtureInbox } from "../screens/inbox/actions.ts";
import { Workflows } from "../screens/Workflows.tsx";
import { fixtureWorkflowsApi } from "../screens/workflows/workflow-data.ts";
import { resetBackStack } from "./back.ts";
import { keyboardInset } from "./keyboard.ts";
import { type ShellState, StaticShell } from "./Shell.tsx";

let createRoot: Awaited<ReturnType<typeof dom>>["createRoot"];
beforeAll(async () => {
  ({ createRoot } = await dom());
});

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
  resetBackStack();
  localStorage.clear();
  composeBus.reset();
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  await act(async () => Bun.sleep(5));
  for (const el of [...document.body.querySelectorAll(".compose-layer, .pop.anchored")])
    el.remove();
  delete document.documentElement.dataset.form;
});

type Form = ShellState["form"];
const NOW = new Date(2026, 8, 16, 10, 0);

async function render(node: ReactNode, form: Form, settings: PartialSettings = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  await act(async () =>
    r.render(
      <StaticShell shell={{ form }} settings={{ "ai.level": "automate", ...settings }}>
        {node}
      </StaticShell>,
    ),
  );
  await settle();
}

const settle = () => act(async () => Bun.sleep(10));
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const qa = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];

async function click(el: Element | null | undefined) {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await settle();
  }
  throw new Error("condition not met");
}

const labels = (sel: string) =>
  qa(sel).map((b) => b.getAttribute("aria-label") ?? b.getAttribute("title") ?? "");

function inbox(form: Form) {
  return render(
    <Inbox
      now={NOW}
      initialOpen={null}
      timing={{ collapse: 0, toast: 60_000 }}
      inbox={fixtureInbox()}
      composer={fixtureComposer({ now: () => NOW })}
    />,
    form,
  );
}

describe("anchored menus open as sheets on a phone", () => {
  function menu(form: Form) {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    return render(
      <AnchoredMenu
        anchor={anchor}
        label="Send later"
        items={[
          { key: "a", label: "In an hour" },
          { key: "b", label: "Tomorrow morning" },
        ]}
        onPick={() => {}}
        onClose={() => {}}
      />,
      form,
    );
  }

  test("a phone: a sheet with no inline position, named by its label", async () => {
    await menu("phone");
    const pop = q(".pop.anchored");
    expect(pop?.classList.contains("sheet")).toBe(true);
    expect(pop?.dataset.placement).toBe("sheet");
    expect(pop?.style.top).toBe("");
    expect(pop?.style.left).toBe("");
    expect(pop?.querySelector(".sheet-h")?.textContent).toBe("Send later");
  });

  test("a desktop: placed beside its button as before", async () => {
    await menu("desktop");
    const pop = q(".pop.anchored");
    expect(pop?.classList.contains("sheet")).toBe(false);
    expect(pop?.style.top).not.toBe("");
    expect(pop?.querySelector(".sheet-h")).toBeNull();
  });
});

describe("the list header on a phone", () => {
  test("carries New message, which opens compose full screen with no Minimize", async () => {
    await inbox("phone");
    const button = q(".col.list .col-head .phone-compose");
    expect(button?.getAttribute("aria-label")).toBe("New message");
    await click(button);
    await until(() => q(".compose .c-tools") !== null);
    expect(labels(".compose > .col-head .btn")).toEqual(["Close"]);
  });

  test("a desktop has no such button, and compose keeps Minimize", async () => {
    await inbox("desktop");
    expect(q(".phone-compose")).toBeNull();
  });
});

describe("compose's toolbar on a phone", () => {
  async function openCompose(form: Form) {
    await inbox(form);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
    });
    await until(() => q(".compose .c-tools") !== null);
    await until(() => !q<HTMLButtonElement>(".c-tools .btn")?.disabled);
  }
  const tools = () => labels(".c-tools > .btn:not(.tpl-open):not(.c-assist)");

  test("bold, italic, link and bullets in the row; the rest behind More, as a sheet", async () => {
    await openCompose("phone");
    expect(tools()).toEqual(["Bold", "Italic", "Link", "Bullets", "More formatting"]);
    await click(q(".c-tools-more"));
    const sheet = q(".pop.anchored.c-tools-sheet");
    expect(sheet?.classList.contains("sheet")).toBe(true);
    expect(qa(".c-tools-sheet .pop-item").map((b) => b.textContent)).toEqual([
      "Numbered",
      "Quote",
      "Clear formatting",
    ]);
    await click(qa(".c-tools-sheet .pop-item")[1]);
    expect(q(".c-tools-sheet")).toBeNull();
  });

  test("a desktop keeps every tool in the row", async () => {
    await openCompose("desktop");
    expect(tools()).toEqual([
      "Bold",
      "Italic",
      "Link",
      "Bullets",
      "Numbered",
      "Quote",
      "Clear formatting",
    ]);
    expect(q(".c-tools-more")).toBeNull();
  });
});

describe("the Calendar's header on a phone", () => {
  const now = new Date("2026-09-16T10:00:00");
  test("the views sit under the header; Schedule and Plan week sit behind More", async () => {
    const asked: string[] = [];
    await render(
      <Calendar source={fixtureCalendar({})} now={now} onAsk={(t) => asked.push(t)} />,
      "phone",
    );
    expect(q(".cal-phone-views .seg")).not.toBeNull();
    expect(q(".cal-wrap .col-head .seg")).toBeNull();
    const head = qa(".cal-wrap .col-head .btn").map((b) => b.textContent?.trim());
    expect(head).not.toContain("Schedule");
    expect(q('.cal-wrap .col-head [aria-pressed][title="Show the side panel"]')).toBeNull();
    await click(q(".cal-phone-more"));
    const items = qa(".pop.anchored.sheet .pop-item").map((b) => b.textContent);
    expect(items).toEqual(["Schedule", "Plan week"]);
    await click(qa(".pop.anchored.sheet .pop-item")[1]);
    expect(asked).toHaveLength(1);
    expect(q(".pop.anchored")).toBeNull();
  });

  test("a desktop keeps them in the header", async () => {
    await render(<Calendar source={fixtureCalendar({})} now={now} onAsk={() => {}} />, "desktop");
    expect(q(".cal-wrap .col-head .seg")).not.toBeNull();
    expect(q(".cal-phone-views")).toBeNull();
    expect(q(".cal-phone-more")).toBeNull();
  });
});

describe("Workflows on a phone", () => {
  function workflows(form: Form) {
    return render(
      <Workflows api={fixtureWorkflowsApi()} now={NOW} groupName={(id) => id} />,
      form,
      { "workflows.page.refresh_seconds": 0 },
    );
  }

  test("the list, then one Workflow as a page with a back arrow", async () => {
    await workflows("phone");
    await until(() => q(".wfx") !== null);
    expect(q(".wfx")?.dataset.phone).toBe("list");
    await click(qa(".wfx-row:not(.wfx-new)")[1]);
    expect(q(".wfx")?.dataset.phone).toBe("detail");
    await click(q(".wfx-head .phone-back"));
    expect(q(".wfx")?.dataset.phone).toBe("list");
  });

  test("a desktop shows both side by side, with no back arrow", async () => {
    await workflows("desktop");
    await until(() => q(".wfx") !== null);
    expect(q(".wfx")?.dataset.phone).toBeUndefined();
    expect(q(".wfx-head .phone-back")).toBeNull();
  });
});

describe("the software keyboard", () => {
  test("what the visual viewport leaves uncovered is the keyboard; a sliver is not", () => {
    expect(keyboardInset(844, { height: 508, offsetTop: 0 })).toBe(336);
    expect(keyboardInset(844, { height: 820, offsetTop: 0 })).toBe(0);
    expect(keyboardInset(844, null)).toBe(0);
  });
});
