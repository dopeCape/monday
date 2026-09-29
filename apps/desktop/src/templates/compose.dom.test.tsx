/// <reference types="bun-types" />
// Templates in a compose surface through the DOM (happy-dom): typing ;;conf
// at a line start opens the picker, Enter inserts Confirm the time and asks
// the Server to fill it; with first_name, time and date filled nothing
// blocks Send, and with the time left unfilled Send says "Fill time first".
// Arrows move in the picker, Escape closes it, and Mod+; opens it with its
// own search field. A chip's menu lists the Thread's candidates and "Type it".

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
  PlaceholderFill,
  Template,
  TemplateFillResult,
  TemplateSuggestResult,
} from "@monday/shared";
import { BUILTIN_TEMPLATES, defaultSettings } from "@monday/shared";
import type { Editor as TiptapEditor } from "@tiptap/core";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "../screens/compose/Editor.tsx";
import { type TemplateCompose, useTemplateCompose } from "./compose.tsx";
import type { TemplateLink } from "./link.ts";
import { templateStrings } from "./strings.ts";

beforeAll(() => {
  if (typeof document === "undefined") GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  for (const el of [...document.body.querySelectorAll(".pop")]) el.remove();
});

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));
/** Waits, a few milliseconds at a time, until the check holds; fails after the deadline. */
async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await act(async () => tick(10));
  }
  throw new Error("condition not met");
}

const fillOf = (
  name: string,
  value: string | null,
  candidates: string[] = [],
): PlaceholderFill => ({
  name,
  value,
  span: value,
  by: value ? "judge" : null,
  confidence: value ? 0.95 : 0,
  candidates: candidates.map((c) => ({ span: c, value: c })),
});

interface Harness {
  editor: () => TiptapEditor;
  compose: () => TemplateCompose;
  html: () => string;
  subject: () => string;
  fills: Array<{ templateId: string; threadId: string | null }>;
  suggestions: string[];
}

async function mount(
  result: (id: string) => TemplateFillResult | null,
  suggest?: (typed: string) => TemplateSuggestResult | null,
): Promise<Harness> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const state: {
    editor: TiptapEditor | null;
    compose: TemplateCompose | null;
    html: string;
    subject: string;
  } = { editor: null, compose: null, html: "", subject: "" };
  const fills: Harness["fills"] = [];
  const suggestions: string[] = [];
  const link: TemplateLink = {
    enabled: true,
    trigger: ";;",
    openKey: "mod+;",
    library: BUILTIN_TEMPLATES,
    strings: templateStrings(defaultSettings()),
    fill: async (templateId, from) => {
      fills.push({ templateId, threadId: from.threadId });
      return result(templateId);
    },
    suggestion: {
      enabled: suggest !== undefined,
      debounceMs: 150,
      minIntervalMs: 0,
      maxTypedChars: 200,
    },
    suggest: async (request) => {
      suggestions.push(request.draft.typed);
      return suggest ? suggest(request.draft.typed) : null;
    },
    draftFrom: () => {},
    onOpen: { enabled: false, needsReplyAt: 0.6, suggest: async () => null },
  };
  function Surface() {
    const [ed, setEd] = useState<TiptapEditor | null>(null);
    const [html, setHtml] = useState("");
    const [subject, setSubject] = useState("");
    const compose = useTemplateCompose({
      link,
      editor: ed,
      threadId: "t-podcast",
      to: [{ name: "Sofia Lindqvist", email: "sofia@lindqvist.se" }],
      subject,
      setSubject,
      bodyHtml: html,
    });
    state.editor = ed;
    state.compose = compose;
    state.html = html;
    state.subject = subject;
    return (
      <div>
        <Editor
          initialHtml="<p></p>"
          onChange={(v) => setHtml(v.html)}
          strings={{
            bold: "",
            italic: "",
            bullets: "",
            numbered: "",
            link: "",
            linkPrompt: "",
            quote: "",
            code: "",
            clearFormat: "",
            quoted: "",
          }}
          onReady={setEd}
        />
        {compose.blocked ? <span className="blocked">{compose.blocked}</span> : null}
        {compose.suggestionLine}
        {compose.overlay}
      </div>
    );
  }
  await act(async () => root?.render(<Surface />));
  await act(async () => tick());
  return {
    editor: () => state.editor as TiptapEditor,
    compose: () => state.compose as TemplateCompose,
    html: () => state.html,
    subject: () => state.subject,
    fills,
    suggestions,
  };
}

async function type(e: TiptapEditor, text: string) {
  for (const ch of text) {
    await act(async () => {
      const { from, to } = e.state.selection;
      const insert = () => e.state.tr.insertText(ch, from, to);
      const handled = e.view.someProp("handleTextInput", (f) => f(e.view, from, to, ch, insert));
      if (!handled) e.view.dispatch(insert());
    });
  }
}

async function key(e: TiptapEditor, k: string, init: Partial<KeyboardEventInit> = {}) {
  await act(async () => {
    e.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
    await tick();
  });
}

const picker = () => document.body.querySelector(".tpl-picker");
const pickerNames = () =>
  [...document.body.querySelectorAll(".tpl-picker .tpl-name")].map((n) => n.textContent);

describe("Templates in compose", () => {
  test(";;conf and Enter inserts Confirm the time filled from the Thread; nothing blocks Send", async () => {
    const h = await mount(() => ({
      templateId: "t_confirm_time",
      judge: "typesafe",
      fills: [fillOf("first_name", "Sofia"), fillOf("time", "15:00"), fillOf("date", "2 October")],
    }));
    await type(h.editor(), ";;conf");
    expect(picker()).not.toBeNull();
    expect(pickerNames()[0]).toBe("Confirm the time");
    await key(h.editor(), "Enter");
    await act(async () => tick(20));
    expect(picker()).toBeNull();
    expect(h.fills).toEqual([{ templateId: "t_confirm_time", threadId: "t-podcast" }]);
    expect(h.editor().getText()).toContain("Hi Sofia,");
    expect(h.editor().getText()).toContain("15:00 on 2 October works for me.");
    expect(h.editor().getText()).not.toContain(";;conf");
    expect(h.compose().blocked).toBeNull();
  });

  test("a Placeholder the Thread did not fill blocks Send and says which", async () => {
    const h = await mount(() => ({
      templateId: "t_confirm_time",
      judge: "typesafe",
      fills: [
        fillOf("first_name", "Sofia"),
        fillOf("time", null, ["15:00", "10am"]),
        fillOf("date", "2 October"),
      ],
    }));
    await type(h.editor(), ";;confirm");
    await key(h.editor(), "Enter");
    await act(async () => tick(20));
    expect(h.compose().blocked).toBe("Fill time first");
    expect(document.body.querySelector(".blocked")?.textContent).toBe("Fill time first");
    // The chip's menu lists the candidates, likeliest first, and Type it.
    const chip = h.editor().view.dom.querySelector('[data-placeholder="time"]') as HTMLElement;
    expect(chip.textContent).toBe("time");
    await act(async () => {
      const pos = h.editor().view.posAtDOM(chip, 0);
      h.editor().view.someProp("handleClickOn", (f) =>
        f(
          h.editor().view,
          pos,
          h.editor().state.doc.nodeAt(pos - 0) ?? h.editor().state.doc,
          pos,
          new MouseEvent("click"),
          true,
        ),
      );
      await tick();
    });
    const items = [...document.body.querySelectorAll(".ph-menu .pop-item")].map(
      (n) => n.textContent,
    );
    expect(items).toEqual(["15:00", "10am", "Type it"]);
    await act(async () => {
      (document.body.querySelector(".ph-menu .pop-item") as HTMLElement).click();
      await tick();
    });
    expect(h.compose().blocked).toBeNull();
    expect(h.editor().getText()).toContain("15:00 on 2 October");
  });

  test("the picker: arrows move, Escape closes and keeps the typed text; Mod+; opens it with a search", async () => {
    const h = await mount(() => null);
    await type(h.editor(), ";;");
    expect(pickerNames()).toHaveLength(21);
    await key(h.editor(), "ArrowDown");
    expect(document.body.querySelector(".tpl-picker .pop-item.on .tpl-name")?.textContent).toBe(
      "Confirm the time",
    );
    await key(h.editor(), "Escape");
    expect(picker()).toBeNull();
    expect(h.editor().getText()).toBe(";;");
    await act(async () => h.editor().commands.setContent("<p>Hello </p>"));
    await act(async () => h.editor().commands.focus("end"));
    await key(h.editor(), ";", { ctrlKey: true });
    const search = document.body.querySelector(".tpl-picker input") as HTMLInputElement | null;
    expect(search).not.toBeNull();
  });

  test("a starter fills an empty subject, and its Placeholders fill there too", async () => {
    const h = await mount(() => ({
      templateId: "t_schedule_call",
      judge: "none",
      fills: [fillOf("first_name", "Sofia"), fillOf("topic", null), fillOf("times", null)],
    }));
    const call = BUILTIN_TEMPLATES.find((t) => t.id === "t_schedule_call") as Template;
    await act(async () => h.compose().insert(call));
    await act(async () => tick(20));
    expect(h.subject()).toBe("A quick call about {topic}");
    expect(h.compose().blocked).toBe("Fill topic first");
  });
});

describe("suggestions while typing", () => {
  const thanks = (typed: string): TemplateSuggestResult =>
    /thanks for sending/i.test(typed)
      ? {
          status: "suggested",
          templateId: "t_thanks_received",
          name: "Thanks, received",
          fits: 0.9,
          gate: 0.8,
        }
      : { status: "none", reason: "gate", gate: 0.1 };
  const line = () => document.body.querySelector(".tpl-suggest");

  test("Thanks for sending the ... suggests Thanks, received after the pause; Tab replaces the line typed", async () => {
    const h = await mount(
      () => ({
        templateId: "t_thanks_received",
        judge: "typesafe",
        fills: [fillOf("first_name", "Sofia")],
      }),
      thanks,
    );
    await type(h.editor(), "Thanks for sending the");
    expect(line()).toBeNull();
    await until(() => line() !== null);
    expect(h.suggestions.at(-1)).toBe("Thanks for sending the");
    expect(line()?.textContent).toContain("Use Thanks, received (Tab)");
    await key(h.editor(), "Tab");
    await until(() => h.editor().getText().includes("Hi Sofia,"));
    expect(line()).toBeNull();
    expect(h.editor().getText()).not.toContain("Thanks for sending the");
    expect(h.editor().getText()).toContain("Hi Sofia,");
    expect(h.editor().getText()).toContain("Thanks for sending");
  });

  test("a personal paragraph suggests nothing; Esc dismisses a suggestion for this Draft", async () => {
    const h = await mount(() => null, thanks);
    await type(h.editor(), "I was so sorry to hear about your father");
    await until(() => h.suggestions.at(-1) === "I was so sorry to hear about your father");
    await act(async () => tick(20));
    expect(line()).toBeNull();
    await act(async () => h.editor().commands.setContent("<p></p>"));
    await type(h.editor(), "Thanks for sending the");
    await until(() => line() !== null);
    await key(h.editor(), "Escape");
    expect(line()).toBeNull();
    const asked = h.suggestions.length;
    await type(h.editor(), " contract");
    await act(async () => tick(300));
    expect(line()).toBeNull();
    expect(h.suggestions.length).toBe(asked);
  });

  test("more than one line typed asks before replacing it", async () => {
    const h = await mount(() => null, thanks);
    await act(async () =>
      h.editor().commands.setContent("<p>Hi Sofia,</p><p>Thanks for sending the</p>"),
    );
    await act(async () => h.editor().commands.focus("end"));
    await type(h.editor(), " deck");
    await until(() => line() !== null);
    await key(h.editor(), "Tab");
    expect(line()?.textContent).toContain("Replace what you typed?");
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>(".tpl-suggest button")]
        .find((b) => b.textContent === "Keep it")
        ?.click();
      await tick(20);
    });
    await until(() => h.editor().getText().includes("I've got it"));
    expect(h.editor().getText()).toContain("Thanks for sending the deck");
    expect(h.editor().getText()).toContain("I've got it and will take a look.");
  });

  test("with no judge on the Server the window says so once, quietly", async () => {
    const h = await mount(
      () => null,
      () => ({ status: "unavailable", reason: "no judge" }),
    );
    await type(h.editor(), "Hello");
    await until(() => line() !== null);
    expect(line()?.textContent).toBe("Template suggestions need TypeSafe or a language model");
  });
});
