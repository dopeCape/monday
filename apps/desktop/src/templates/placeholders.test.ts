/// <reference types="bun-types" />
// Placeholders in the compose editor through Tiptap's API under happy-dom: a
// Template goes in as chips, fills turn chips into marked values and hand the
// rest their candidates, Tab moves between chips, editing a filled value
// makes it ordinary text, Send finds the required chips left, and the send
// path drops the optional ones and the marks. Also the picker's trigger and
// filter.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { PlaceholderFill, Template } from "@monday/shared";
import { BUILTIN_TEMPLATES, findBuiltinTemplate } from "@monday/shared";
import type { Editor } from "@tiptap/core";
import { docToText } from "../screens/compose/text.ts";
import { blankTemplate, guessType, placeholdersFor } from "./form.ts";
import { filterTemplates, triggerAt } from "./picker.ts";
import {
  applyFills,
  chipsIn,
  clearChip,
  fillChip,
  finalizeForSend,
  insertTemplate,
  moveToChip,
  templateContent,
  unfilledInHtml,
} from "./placeholders.ts";

beforeAll(() => {
  if (typeof document === "undefined") GlobalRegistrator.register();
});

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

async function open(html = "<p></p>"): Promise<Editor> {
  const { Editor: TiptapEditor } = await import("@tiptap/core");
  const { editorExtensions } = await import("../screens/compose/Editor.tsx");
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor = new TiptapEditor({ element: el, extensions: editorExtensions("Write"), content: html });
  return editor;
}

const confirm = findBuiltinTemplate("t_confirm_time") as Template;
const decline = findBuiltinTemplate("t_decline") as Template;
const textOf = (e: Editor) => docToText(e.getJSON() as Parameters<typeof docToText>[0]);

const fill = (name: string, value: string | null, candidates: string[] = []): PlaceholderFill => ({
  name,
  value,
  span: value,
  by: value ? "judge" : null,
  confidence: value ? 0.9 : 0,
  candidates: candidates.map((c) => ({ span: c, value: c })),
});

describe("a Template in the editor", () => {
  test("goes in as chips at the typed trigger; the text alternative names them", async () => {
    const e = await open("<p>;;conf</p>");
    insertTemplate(e, { from: 1, to: 7 }, confirm);
    expect(chipsIn(e.state.doc).map((c) => c.name)).toEqual(["first_name", "time", "date"]);
    expect(textOf(e)).toBe(
      "Hi {first_name},\n\n{time} on {date} works for me. I'll send an invite shortly.\n\nThanks,",
    );
    expect(unfilledInHtml(e.getHTML())).toEqual(["first_name", "time", "date"]);
    // The caret lands on the first chip, so typing replaces it.
    expect(e.state.selection.from).toBe(chipsIn(e.state.doc)[0]?.pos ?? -1);
  });

  test("fills make chips into marked values and hand the rest their candidates", async () => {
    const e = await open();
    insertTemplate(e, { from: 1, to: 1 }, confirm);
    const filled = applyFills(e, [
      fill("first_name", "Sofia"),
      fill("time", "15:00"),
      fill("date", null, ["2 October", "3 October"]),
    ]);
    expect(filled).toBe(2);
    expect(e.getHTML()).toContain(
      '<span data-filled="first_name" data-value="Sofia" class="ph-filled">Sofia</span>',
    );
    expect(unfilledInHtml(e.getHTML())).toEqual(["date"]);
    expect(chipsIn(e.state.doc)[0]?.candidates.map((c) => c.value)).toEqual([
      "2 October",
      "3 October",
    ]);
    // Picking a candidate from the chip's menu fills it.
    fillChip(e, chipsIn(e.state.doc)[0]?.pos ?? 0, "2 October");
    expect(unfilledInHtml(e.getHTML())).toEqual([]);
    expect(textOf(e)).toContain("15:00 on 2 October works for me.");
  });

  test("editing a filled value makes it ordinary text; nothing refills it", async () => {
    const e = await open();
    insertTemplate(e, { from: 1, to: 1 }, confirm);
    applyFills(e, [fill("first_name", "Sofia")]);
    const at = e.getHTML().indexOf("Sofia");
    expect(at).toBeGreaterThan(0);
    // Type inside "Sofia".
    let pos = -1;
    e.state.doc.descendants((n, p) => {
      if (n.isText && n.text?.includes("Sofia") && pos < 0)
        pos = p + (n.text?.indexOf("Sofia") ?? 0) + 2;
    });
    e.view.dispatch(e.state.tr.insertText("x", pos));
    expect(e.getHTML()).not.toContain("data-filled");
    expect(textOf(e)).toContain("Hi Soxfia,");
  });

  test("Tab and Shift-Tab move between chips; Type it removes one", async () => {
    const e = await open();
    insertTemplate(e, { from: 1, to: 1 }, confirm);
    const [a, b, c] = chipsIn(e.state.doc);
    expect(e.state.selection.from).toBe(a?.pos ?? -1);
    expect(moveToChip(e, 1)).toBe(true);
    expect(e.state.selection.from).toBe(b?.pos ?? -1);
    expect(moveToChip(e, 1)).toBe(true);
    expect(e.state.selection.from).toBe(c?.pos ?? -1);
    expect(moveToChip(e, -1)).toBe(true);
    expect(e.state.selection.from).toBe(b?.pos ?? -1);
    clearChip(e, b?.pos ?? 0);
    expect(chipsIn(e.state.doc).map((x) => x.name)).toEqual(["first_name", "date"]);
  });

  test("a Draft saved with chips reopens with them and still blocks Send", async () => {
    const first = await open();
    insertTemplate(first, { from: 1, to: 1 }, confirm);
    const html = first.getHTML();
    const e = await open(html);
    expect(chipsIn(e.state.doc).map((c) => c.name)).toEqual(["first_name", "time", "date"]);
    expect(unfilledInHtml(e.getHTML())).toEqual(["first_name", "time", "date"]);
  });

  test("the send path drops an unfilled optional chip with its space and the marks", async () => {
    const e = await open();
    insertTemplate(e, { from: 1, to: 1 }, decline);
    applyFills(e, [fill("first_name", "Sofia")]);
    expect(unfilledInHtml(e.getHTML())).toEqual([]);
    const out = finalizeForSend({ bodyHtml: e.getHTML(), bodyText: textOf(e) });
    expect(out.bodyHtml).not.toContain("data-placeholder");
    expect(out.bodyHtml).not.toContain("data-filled");
    expect(out.bodyHtml).toContain("I'm going to pass on this one.");
    expect(out.bodyText).toContain("I'm going to pass on this one.");
    expect(out.bodyText).toContain("Hi Sofia,");
  });

  test("templateContent keeps breaks, paragraphs and an unknown {name} as text", () => {
    const content = templateContent({
      body: "A {x}\nB {y}\n\nC",
      placeholders: [{ name: "x", type: "text", optional: false, hint: "" }],
    });
    expect(content).toHaveLength(2);
    expect(content[0]?.content?.map((n) => n.type)).toEqual([
      "text",
      "templatePlaceholder",
      "hardBreak",
      "text",
    ]);
    expect(content[0]?.content?.[3]?.text).toBe("B {y}");
  });
});

describe("the picker", () => {
  test("the trigger at a line start opens it with the query after it", async () => {
    const e = await open("<p>;;conf</p>");
    e.commands.setTextSelection(7);
    expect(triggerAt(e.state, ";;")).toEqual({ from: 1, to: 7, query: "conf" });
    const mid = await open("<p>so ;;conf</p>");
    mid.commands.setTextSelection(10);
    expect(triggerAt(mid.state, ";;")).toBeNull();
    const second = await open("<p>first<br>;;dec</p>");
    second.commands.setTextSelection(second.state.doc.content.size - 1);
    expect(triggerAt(second.state, ";;")?.query).toBe("dec");
  });

  test("filters by name and fits-when, own Templates first", () => {
    const own: Template = {
      ...confirm,
      id: "mine",
      workspaceId: "ws",
      builtIn: null,
      name: "Confirm, my way",
    };
    const lib = [own, ...BUILTIN_TEMPLATES];
    // A name match comes before a match in the fits-when ("confirms the next step").
    expect(filterTemplates(lib, "conf").map((t) => t.id)).toEqual([
      "mine",
      "t_confirm_time",
      "t_thanks_for_applying",
    ]);
    expect(filterTemplates(lib, "invoice").map((t) => t.id)).toEqual([
      "t_invoice_question",
      "t_payment_sent",
    ]);
    expect(filterTemplates(lib, "")).toHaveLength(22);
  });
});

describe("the form", () => {
  test("Placeholders follow the text and keep what was said about them", () => {
    const prev = blankTemplate().placeholders;
    const next = placeholdersFor(
      { subject: null, body: "Hi {first_name}, re {invoice_number} {due_date?}" },
      prev.map((p) => ({ ...p, hint: "kept" })),
    );
    expect(next).toEqual([
      { name: "first_name", type: "first_name", optional: false, hint: "kept" },
      { name: "invoice_number", type: "reference", optional: false, hint: "" },
      { name: "due_date", type: "date", optional: true, hint: "" },
    ]);
    expect(guessType("colleague_email")).toBe("email");
    expect(guessType("topic")).toBe("text");
  });
});
