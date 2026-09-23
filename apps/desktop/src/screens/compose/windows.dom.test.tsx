/// <reference types="bun-types" />
// The compose windows on the Inbox screen through the DOM (happy-dom): opening
// never waits on the network, the Later menu sits on top of the sheet anchored
// to its button, windows minimize into the dock and come back with their
// content, a new message minimizes the open one, the dock survives a restart,
// Esc minimizes, Discard has Undo, each Setting changes what it names, a reply
// Draft the Agent wrote shows on its Thread, and the assist answers with a
// suggestion the user accepts or rejects.

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Draft, DraftAssistRequest, PartialSettings } from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import type { Editor as TiptapEditor } from "@tiptap/core";
import { act } from "react";
import type { Root } from "react-dom/client";
import { StaticShell } from "../../shell/Shell.tsx";
import { Inbox, type InboxProps } from "../Inbox.tsx";
import { fixtureInbox } from "../inbox/actions.ts";
import { composeBus, openDraftInComposer } from "./bus.ts";
import { type Composer, fixtureComposer } from "./composer.ts";

let createRoot: Awaited<ReturnType<typeof dom>>["createRoot"];
beforeAll(async () => {
  ({ createRoot } = await dom());
});

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
  localStorage.clear();
  composeBus.reset();
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  // The dock's own root unmounts a microtask later.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
  for (const el of [...document.body.querySelectorAll(".compose-layer, .pop.anchored")])
    el.remove();
});

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await act(async () => {
      await tick();
    });
  }
  throw new Error("condition not met");
}

const NOW = new Date(2026, 8, 16, 10, 0);

async function mount(
  props: Partial<InboxProps> = {},
  settings: PartialSettings = {},
): Promise<{ composer: Composer; render: (more?: Partial<InboxProps>) => Promise<void> }> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  const inbox = props.inbox ?? fixtureInbox();
  const composer = props.composer ?? fixtureComposer({ now: () => NOW });
  const render = async (more: Partial<InboxProps> = {}) =>
    act(async () =>
      r.render(
        <StaticShell settings={settings}>
          <Inbox
            now={NOW}
            initialOpen={null}
            timing={{ collapse: 0, toast: 60_000 }}
            {...props}
            {...more}
            inbox={inbox}
            composer={composer}
          />
        </StaticShell>,
      ),
    );
  await render();
  return { composer, render };
}

async function unmount() {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  await act(async () => {
    await tick();
  });
}

async function press(key: string, mods: Partial<KeyboardEventInit> = {}, target?: Element | null) {
  await act(async () => {
    (target ?? window).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }),
    );
  });
}

async function click(el: Element | null | undefined) {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function typeInto(input: HTMLInputElement | null | undefined, value: string) {
  if (!input) throw new Error("no input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const sheet = () => document.querySelector<HTMLElement>(".scrim .compose, .compose.is-docked");
const chips = () =>
  [...document.querySelectorAll<HTMLElement>(".dock .dock-chip:not(.more) .s")].map(
    (s) => s.textContent,
  );
const button = (scope: ParentNode | null | undefined, title: string) =>
  scope?.querySelector<HTMLButtonElement>(`button[title="${title}"]`) ?? null;
const editorIn = (scope: ParentNode | null | undefined): TiptapEditor => {
  const box = scope?.querySelector<HTMLElement & { editor?: TiptapEditor }>(".tiptap");
  if (!box?.editor) throw new Error("no editor");
  return box.editor;
};

/** Opens a new message and gives it a subject, so it has content worth keeping. */
async function newWithSubject(
  render: (more?: Partial<InboxProps>) => Promise<void>,
  n: number,
  subject: string,
) {
  await render({ composeRequest: n });
  await until(
    () =>
      sheet() !== null &&
      (sheet()?.querySelector<HTMLInputElement>("#compose-subject")?.value ?? "x") === "",
  );
  await typeInto(sheet()?.querySelector<HTMLInputElement>("#compose-subject"), subject);
}

describe("opening", () => {
  test("the window opens and focuses To without waiting on the network", async () => {
    const composer = fixtureComposer({ now: () => NOW });
    let saves = 0;
    const never = new Promise<never>(() => {});
    composer.save = () => {
      saves += 1;
      return never;
    };
    composer.ensureContent = () => never;
    const { render } = await mount({ composer, composeRequest: 0 });
    // One render, no awaiting: the sheet is there and To has the keyboard.
    await act(async () => {
      void render({ composeRequest: 1 });
    });
    expect(sheet()).not.toBeNull();
    expect(document.activeElement?.id).toBe("compose-to");
    expect(saves).toBe(0);
  });
});

describe("the Later menu", () => {
  test("renders on the body above the sheet, anchored below its button, and Esc gives the focus back", async () => {
    await mount({}, {});
    await press("c");
    await until(() => sheet() !== null);
    const later = [...(sheet()?.querySelectorAll<HTMLButtonElement>(".c-foot .btn") ?? [])].find(
      (b) => b.textContent?.includes("Later"),
    );
    if (!later) throw new Error("no Later button");
    later.getBoundingClientRect = () =>
      ({ top: 400, bottom: 432, left: 360, right: 460, width: 100, height: 32 }) as DOMRect;
    await click(later);
    const menu = document.querySelector<HTMLElement>(".pop.anchored.later");
    expect(menu).not.toBeNull();
    // A child of the body, after the scrim: never inside the sheet or under it.
    expect(menu?.parentElement).toBe(document.body);
    expect(menu?.closest(".scrim")).toBeNull();
    expect(menu?.dataset.placement).toBe("below");
    expect(menu?.style.top).toBe("438px");
    expect(menu?.style.left).toBe("360px");
    await press("Escape", {}, menu?.querySelector(".pop-item"));
    expect(document.querySelector(".pop.anchored.later")).toBeNull();
    expect(document.activeElement).toBe(later);
    // The Escape stayed with the menu: the sheet is still open.
    expect(sheet()).not.toBeNull();
  });

  test("flips above the button when there is no room below", async () => {
    await mount();
    await press("c");
    await until(() => sheet() !== null);
    const later = [...(sheet()?.querySelectorAll<HTMLButtonElement>(".c-foot .btn") ?? [])].find(
      (b) => b.textContent?.includes("Later"),
    );
    if (!later) throw new Error("no Later button");
    later.getBoundingClientRect = () =>
      ({
        top: window.innerHeight - 40,
        bottom: window.innerHeight - 8,
        left: 360,
        right: 460,
      }) as DOMRect;
    const proto = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.classList.contains("anchored")) return { width: 220, height: 150 } as DOMRect;
      return proto.call(this);
    };
    try {
      await click(later);
      const menu = document.querySelector<HTMLElement>(".pop.anchored.later");
      expect(menu?.dataset.placement).toBe("above");
      expect(menu?.classList.contains("above")).toBe(true);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = proto;
    }
  });

  test("the stylesheet puts anchored menus above every scrim, the dock and a docked window", () => {
    const css = readFileSync(
      new URL("../../../../../packages/ui/src/app.css", import.meta.url).pathname,
      "utf8",
    );
    const z = (selector: string) => {
      const at = css.indexOf(`${selector} {`);
      const block = css.slice(at, css.indexOf("}", at));
      return Number(/z-index:\s*(\d+)/.exec(block)?.[1] ?? Number.NaN);
    };
    const menu = z(".pop.anchored");
    expect(menu).toBeGreaterThan(z(".scrim"));
    expect(menu).toBeGreaterThan(z(".dock"));
    expect(menu).toBeGreaterThan(z(".compose.is-docked"));
  });
});

describe("minimize and the dock", () => {
  test("minimize and restore keep the content", async () => {
    const { render } = await mount({ composeRequest: 0 });
    await newWithSubject(render, 1, "Offsite dates");
    await click(button(sheet(), "Minimize"));
    await until(() => sheet() === null && chips().length === 1);
    expect(chips()).toEqual(["Offsite dates"]);
    await click(document.querySelector(".dock-chip .dock-open"));
    await until(() => sheet() !== null);
    expect(sheet()?.querySelector<HTMLInputElement>("#compose-subject")?.value).toBe(
      "Offsite dates",
    );
    expect(chips()).toEqual([]);
  });

  test("a new message minimizes the open one, and three drafts dock side by side", async () => {
    const { render } = await mount({ composeRequest: 0 });
    await newWithSubject(render, 1, "One");
    await newWithSubject(render, 2, "Two");
    await newWithSubject(render, 3, "Three");
    await render({ composeRequest: 4 });
    await until(() => chips().length === 3);
    expect(chips()).toEqual(["Three", "Two", "One"]);
    expect(sheet()?.querySelector<HTMLInputElement>("#compose-subject")?.value).toBe("");
  });

  test("Esc minimizes a window with content and closes an empty one", async () => {
    const { render } = await mount({ composeRequest: 0 });
    await render({ composeRequest: 1 });
    await until(() => sheet() !== null);
    await press("Escape", {}, document.activeElement);
    await until(() => sheet() === null);
    expect(chips()).toEqual([]);
    await newWithSubject(render, 2, "Kept");
    await press("Escape", {}, sheet()?.querySelector("#compose-subject"));
    await until(() => sheet() === null && chips().length === 1);
    expect(chips()).toEqual(["Kept"]);
  });

  test("the dock comes back after a restart from the open Drafts", async () => {
    const composer = fixtureComposer({ now: () => NOW });
    const first = await mount({ composer, composeRequest: 0 });
    await newWithSubject(first.render, 1, "Before the restart");
    await click(button(sheet(), "Minimize"));
    await until(() => composer.drafts().some((d) => d.subject === "Before the restart"));
    await unmount();
    await mount({ composer, composeRequest: 0 });
    await until(() => chips().length === 1);
    expect(chips()).toEqual(["Before the restart"]);
  });

  test("with restore_docked_on_launch off the dock starts empty", async () => {
    const composer = fixtureComposer({ now: () => NOW });
    const first = await mount({ composer, composeRequest: 0 });
    await newWithSubject(first.render, 1, "Gone on launch");
    await click(button(sheet(), "Minimize"));
    await until(() => composer.drafts().length === 1);
    await unmount();
    await mount({ composer }, { "compose.restore_docked_on_launch": false });
    await act(async () => {
      await tick(20);
    });
    expect(chips()).toEqual([]);
    // Still a Draft: the dock only decides where it shows.
    expect(composer.drafts()[0]?.subject).toBe("Gone on launch");
  });

  test("the cycle shortcut walks the open and docked drafts", async () => {
    const { render } = await mount({ composeRequest: 0 });
    await newWithSubject(render, 1, "A");
    await newWithSubject(render, 2, "B");
    const subject = () => sheet()?.querySelector<HTMLInputElement>("#compose-subject")?.value;
    expect(subject()).toBe("B");
    await press("d", { ctrlKey: true, shiftKey: true }, sheet()?.querySelector("#compose-subject"));
    await until(() => subject() === "A");
    expect(chips()).toEqual(["B"]);
  });

  test("Discard throws the Draft away, and Undo brings it back", async () => {
    const composer = fixtureComposer({ now: () => NOW });
    const { render } = await mount({ composer, composeRequest: 0 });
    await newWithSubject(render, 1, "Second thoughts");
    await until(() => true);
    await click(button(sheet(), "Discard"));
    await until(() => sheet() === null && document.querySelector("[data-discard-undo]") !== null);
    expect(composer.drafts().some((d) => d.subject === "Second thoughts")).toBe(false);
    await click(document.querySelector("[data-discard-undo] .btn"));
    await until(() => sheet() !== null);
    expect(sheet()?.querySelector<HTMLInputElement>("#compose-subject")?.value).toBe(
      "Second thoughts",
    );
    expect(composer.drafts().some((d) => d.subject === "Second thoughts")).toBe(true);
  });
});

describe("each Setting changes what it names", () => {
  test("close_behavior close: Esc closes a window with content and keeps its Draft", async () => {
    const composer = fixtureComposer({ now: () => NOW });
    const { render } = await mount(
      { composer, composeRequest: 0 },
      { "compose.close_behavior": "close" },
    );
    await newWithSubject(render, 1, "Closed, kept");
    await press("Escape", {}, sheet()?.querySelector("#compose-subject"));
    await until(() => sheet() === null);
    await until(() => composer.drafts().some((d) => d.subject === "Closed, kept"));
    expect(chips()).toEqual([]);
  });

  test("new_while_open stack: the open message stays open beside the new one", async () => {
    const { render } = await mount({ composeRequest: 0 }, { "compose.new_while_open": "stack" });
    await newWithSubject(render, 1, "Beside");
    await render({ composeRequest: 2 });
    await until(() => document.querySelector(".dock .stacked .compose.is-bare") !== null);
    expect(
      document.querySelector<HTMLInputElement>(".dock .stacked input[id^='compose-subject']")
        ?.value ?? document.querySelector(".dock .stacked")?.textContent,
    ).toBeTruthy();
    expect(chips()).toEqual([]);
  });

  test("dock_max_visible folds the rest into +N; dock_position places the dock", async () => {
    const { render } = await mount(
      { composeRequest: 0 },
      { "compose.dock_max_visible": 2, "compose.dock_position": "bottom-left" },
    );
    await newWithSubject(render, 1, "One");
    await newWithSubject(render, 2, "Two");
    await newWithSubject(render, 3, "Three");
    await click(button(sheet(), "Minimize"));
    await until(() => document.querySelector(".dock-chip.more") !== null);
    expect(chips()).toEqual(["Three", "Two"]);
    expect(document.querySelector(".dock-chip.more")?.textContent).toBe("+1");
    expect(document.querySelector(".dock")?.classList.contains("bottom-left")).toBe(true);
    await click(document.querySelector(".dock-chip.more"));
    const item = document.querySelector<HTMLElement>(".pop.anchored .pop-item");
    expect(item?.textContent).toContain("One");
    await click(item);
    await until(
      () => sheet()?.querySelector<HTMLInputElement>("#compose-subject")?.value === "One",
    );
  });

  test("window_style docked has no scrim; fullscreen fills the window", async () => {
    await mount({}, { "compose.window_style": "docked" });
    await press("c");
    await until(() => document.querySelector(".compose.is-docked") !== null);
    expect(document.querySelector(".scrim")).toBeNull();
    await unmount();
    await mount({}, { "compose.window_style": "fullscreen" });
    await press("c");
    await until(
      () => document.querySelector(".scrim.is-fullscreen .compose.is-fullscreen") !== null,
    );
  });

  test("compose.toolbar off hides the row; the shortcuts still name their keys when on", async () => {
    await mount();
    await press("c");
    await until(() => sheet()?.querySelector(".c-tools") !== null);
    expect(button(sheet(), "Bold (Ctrl+B)")).not.toBeNull();
    const titles = [...(sheet()?.querySelectorAll<HTMLElement>(".c-tools .btn") ?? [])].map(
      (b) => b.title,
    );
    expect(titles).toContain("Clear formatting (Ctrl+\\)");
    expect(titles).toContain("Link (Ctrl+K)");
    await unmount();
    await mount({}, { "compose.toolbar": false });
    await press("c");
    await until(() => sheet() !== null);
    expect(sheet()?.querySelector(".c-tools")).toBeNull();
  });
});

describe("Drafts you can find", () => {
  const agentReply: Draft = {
    id: "dr-agent",
    workspaceId: "ws-genai",
    threadId: "e1",
    kind: "reply",
    inReplyToMessageId: null,
    to: [{ name: "Aoife Brennan", email: "aoife@northlight.dev" }],
    cc: [],
    bcc: [],
    subject: "Re: Senior Rust engineer role, take-home submitted",
    bodyText: "Thanks Aoife, Thursday at 15:00 works.",
    bodyHtml: "<p>Thanks Aoife, Thursday at 15:00 works.</p>",
    attachmentBlobIds: [],
    attachments: [],
    status: "open",
    updatedAt: "2026-09-16T08:00:00.000Z",
    updatedBy: "agent",
  };

  test("a reply Draft the Agent wrote opens on its Thread as the inline reply, with who wrote it", async () => {
    const composer = fixtureComposer({ now: () => NOW, drafts: [agentReply] });
    await mount({ composer, initialOpen: "e1" });
    await until(() => document.querySelector(".reply .tiptap") !== null);
    expect(document.querySelector(".reply .tiptap")?.textContent).toContain(
      "Thursday at 15:00 works",
    );
    expect(document.querySelector(".reply .c-byline")?.textContent).toBe("Drafted by monday");
  });

  test("R on that Thread continues the saved reply instead of starting a second one", async () => {
    const composer = fixtureComposer({ now: () => NOW, drafts: [agentReply] });
    await mount({ composer, initialOpen: "e1" });
    await until(() => document.querySelector(".reply .tiptap") !== null);
    await press("Escape");
    await until(() => document.querySelector(".reply .tiptap") === null);
    await press("r");
    await until(() => document.querySelector(".reply .tiptap") !== null);
    expect(document.querySelector(".reply .tiptap")?.textContent).toContain("Thursday");
    expect(composer.drafts()).toHaveLength(1);
  });

  test("the Agent's Open draft opens a new-message Draft in a window", async () => {
    const note: Draft = {
      ...agentReply,
      id: "dr-new",
      threadId: null,
      kind: "new",
      subject: "Hello",
    };
    const composer = fixtureComposer({ now: () => NOW, drafts: [note] });
    await mount({ composer });
    await act(async () => {
      openDraftInComposer("dr-new");
    });
    await until(() => sheet() !== null);
    expect(sheet()?.querySelector<HTMLInputElement>("#compose-subject")?.value).toBe("Hello");
    expect(composeBus.openDraft()).toBe("dr-new");
  });
});

describe("the Agent edits the open Draft", () => {
  test("update_draft's save shows in the open window at once", async () => {
    const composer = fixtureComposer({ now: () => NOW });
    const { render } = await mount({ composer, composeRequest: 0 });
    await newWithSubject(render, 1, "Terms");
    await press("Escape", {}, sheet()?.querySelector("#compose-subject"));
    await until(() => composer.drafts().length === 1);
    const id = composer.drafts()[0]?.id ?? "";
    await click(document.querySelector(".dock-chip .dock-open"));
    await until(() => sheet() !== null);
    const saved = composer.draft(id);
    if (!saved) throw new Error("no draft");
    await act(async () => {
      composer.agentSave(id, {
        ...saved,
        subject: "Terms, shorter",
        bodyHtml: "<p>Short.</p>",
        bodyText: "Short.",
      });
    });
    await until(
      () =>
        sheet()?.querySelector<HTMLInputElement>("#compose-subject")?.value === "Terms, shorter",
    );
    expect(editorIn(sheet()).getText()).toBe("Short.");
  });
});

describe("the writing assist", () => {
  test("a rewrite comes back as a suggestion; Accept writes it, Reject leaves the text", async () => {
    const asked: Array<Omit<DraftAssistRequest, "workspace">> = [];
    const composer = fixtureComposer({
      now: () => NOW,
      assist: async (request) => {
        asked.push(request);
        return { text: "Short version.", voice: false };
      },
    });
    await mount({ composer }, { "ai.level": "assist" });
    await press("c");
    await until(() => sheet()?.querySelector(".c-assist") !== null);
    const editor = editorIn(sheet());
    await act(async () => {
      editor.commands.setContent("<p>A long and winding first draft of the message.</p>");
    });
    await click(sheet()?.querySelector(".c-assist"));
    const shorter = [...document.querySelectorAll<HTMLElement>(".pop.anchored .pop-item")].find(
      (b) => b.textContent === "Shorter",
    );
    await click(shorter);
    await until(() => document.querySelector(".c-suggestion .btn.primary") !== null);
    expect(asked[0]?.action).toBe("shorter");
    expect(asked[0]?.text).toContain("A long and winding");
    // Shown beside the text, not written into it.
    expect(editor.getText()).toContain("A long and winding");
    await click(document.querySelector(".c-suggestion .btn.primary"));
    expect(editor.getText()).toContain("Short version.");
    expect(editor.getText()).not.toContain("winding");
    expect(document.querySelector(".c-suggestion")).toBeNull();
  });

  test("the free instruction and Reject", async () => {
    const composer = fixtureComposer({
      now: () => NOW,
      assist: async (request) => ({ text: `(${request.instruction})`, voice: true }),
    });
    await mount({ composer }, { "ai.level": "assist" });
    await press("c");
    await until(() => sheet()?.querySelector(".c-assist") !== null);
    const editor = editorIn(sheet());
    await act(async () => {
      editor.commands.setContent("<p>I never said that.</p>");
    });
    await click(sheet()?.querySelector(".c-assist"));
    const field = document.querySelector<HTMLInputElement>(".pop.anchored .pop-pick input");
    await typeInto(field, "make this sound less defensive");
    await act(async () => {
      field?.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await until(() => document.querySelector(".c-suggestion p") !== null);
    expect(document.querySelector(".c-suggestion")?.textContent).toContain(
      "(make this sound less defensive)",
    );
    expect(document.querySelector(".c-suggestion")?.textContent).toContain("In your voice");
    const reject = [...document.querySelectorAll<HTMLElement>(".c-suggestion .btn")].find(
      (b) => b.textContent === "Reject",
    );
    await click(reject);
    expect(editor.getText()).toBe("I never said that.");
  });

  test("hidden at AI level off, and without a runtime", async () => {
    const composer = fixtureComposer({
      now: () => NOW,
      assist: async () => ({ text: "", voice: false }),
    });
    await mount({ composer }, { "ai.level": "off" });
    await press("c");
    await until(() => sheet() !== null);
    expect(sheet()?.querySelector(".c-assist")).toBeNull();
    await unmount();
    await mount({}, { "ai.level": "assist" });
    await press("c");
    await until(() => sheet() !== null);
    expect(sheet()?.querySelector(".c-assist")).toBeNull();
  });
});
