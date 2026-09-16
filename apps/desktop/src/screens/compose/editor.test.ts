/// <reference types="bun-types" />
// The rich text editor through Tiptap's own API under happy-dom: every
// toolbar command yields the expected HTML and the same plain-text
// alternative text.ts derives, Markdown shortcuts fire on typed input, and
// the quoted history round trips as <div class="quoted">.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Editor } from "@tiptap/core";
import { docToText } from "./text.ts";

beforeAll(() => {
  if (typeof document === "undefined") GlobalRegistrator.register();
});

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

async function open(html: string): Promise<Editor> {
  const { Editor: TiptapEditor } = await import("@tiptap/core");
  const { editorExtensions } = await import("./Editor.tsx");
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor = new TiptapEditor({ element: el, extensions: editorExtensions("Write"), content: html });
  return editor;
}

/** Types text the way a keyboard would, so input rules (Markdown shortcuts) run. */
function type(e: Editor, text: string) {
  for (const ch of text) {
    const { from, to } = e.state.selection;
    const insert = () => e.state.tr.insertText(ch, from, to);
    const handled = e.view.someProp("handleTextInput", (f) => f(e.view, from, to, ch, insert));
    if (!handled) e.view.dispatch(insert());
  }
}

const textOf = (e: Editor) => docToText(e.getJSON() as Parameters<typeof docToText>[0]);
/** StarterKit keeps an empty paragraph after a closing block so the caret can leave it; ignore it. */
const htmlOf = (e: Editor) => e.getHTML().replace(/<p><\/p>$/, "");

describe("editor toolbar actions", () => {
  test("bold and italic", async () => {
    const e = await open("<p>hello world</p>");
    e.commands.setTextSelection({ from: 1, to: 6 });
    e.commands.toggleBold();
    expect(e.getHTML()).toBe("<p><strong>hello</strong> world</p>");
    e.commands.setTextSelection({ from: 7, to: 12 });
    e.commands.toggleItalic();
    expect(e.getHTML()).toBe("<p><strong>hello</strong> <em>world</em></p>");
    expect(textOf(e)).toBe("hello world");
    e.commands.setTextSelection({ from: 1, to: 6 });
    e.commands.toggleBold();
    expect(e.getHTML()).toBe("<p>hello <em>world</em></p>");
  });

  test("bullet and numbered lists", async () => {
    const e = await open("<p>one</p><p>two</p>");
    e.commands.selectAll();
    e.commands.toggleBulletList();
    expect(htmlOf(e)).toBe("<ul><li><p>one</p></li><li><p>two</p></li></ul>");
    expect(textOf(e)).toBe("- one\n- two");
    const numbered = await open("<p>one</p><p>two</p>");
    numbered.commands.selectAll();
    numbered.commands.toggleOrderedList();
    expect(htmlOf(numbered)).toBe("<ol><li><p>one</p></li><li><p>two</p></li></ol>");
    expect(textOf(numbered)).toBe("1. one\n2. two");
    numbered.commands.setTextSelection(3);
    numbered.commands.toggleOrderedList();
    expect(htmlOf(numbered)).toBe("<p>one</p><ol><li><p>two</p></li></ol>");
    e.destroy();
  });

  test("quote and code block", async () => {
    const e = await open("<p>quoted line</p>");
    e.commands.selectAll();
    e.commands.toggleBlockquote();
    expect(htmlOf(e)).toBe("<blockquote><p>quoted line</p></blockquote>");
    expect(textOf(e)).toBe("> quoted line");
    e.commands.setTextSelection(3);
    e.commands.toggleBlockquote();
    expect(htmlOf(e)).toBe("<p>quoted line</p>");
    e.commands.setTextSelection(3);
    e.commands.toggleCodeBlock();
    expect(htmlOf(e)).toBe("<pre><code>quoted line</code></pre>");
    expect(textOf(e)).toBe("    quoted line");
  });

  test("links keep their address in the text alternative", async () => {
    const e = await open("<p>see the docs</p>");
    e.commands.setTextSelection({ from: 9, to: 13 });
    e.commands.setLink({ href: "https://monday.email/docs" });
    expect(e.getHTML()).toBe(
      '<p>see the <a target="_blank" rel="noopener noreferrer nofollow" href="https://monday.email/docs">docs</a></p>',
    );
    expect(textOf(e)).toBe("see the docs <https://monday.email/docs>");
    e.commands.setTextSelection({ from: 9, to: 13 });
    e.commands.unsetLink();
    expect(e.getHTML()).toBe("<p>see the docs</p>");
  });

  test("markdown shortcuts: **bold**, _italic_, lists, quotes, code", async () => {
    const e = await open("<p></p>");
    type(e, "**bold** ");
    expect(e.getHTML()).toBe("<p><strong>bold</strong> </p>");
    e.commands.clearContent();
    type(e, "_soft_ ");
    expect(e.getHTML()).toBe("<p><em>soft</em> </p>");
    e.commands.clearContent();
    type(e, "- item");
    expect(htmlOf(e)).toBe("<ul><li><p>item</p></li></ul>");
    e.commands.clearContent();
    type(e, "1. first");
    expect(htmlOf(e)).toBe("<ol><li><p>first</p></li></ol>");
    e.commands.clearContent();
    type(e, "> quoted");
    expect(htmlOf(e)).toBe("<blockquote><p>quoted</p></blockquote>");
    e.commands.clearContent();
    type(e, "`code` ");
    expect(e.getHTML()).toBe("<p><code>code</code> </p>");
    e.commands.clearContent();
    type(e, "``` ");
    expect(htmlOf(e)).toBe("<pre><code></code></pre>");
  });

  test("quoted history stays a folded block and serialises with its class", async () => {
    const e = await open(
      '<p>Thanks.</p><div class="quoted"><p>On Monday, Aoife wrote:</p><blockquote><p>old</p></blockquote></div>',
    );
    expect(e.getHTML()).toBe(
      '<p>Thanks.</p><div class="quoted"><p>On Monday, Aoife wrote:</p><blockquote><p>old</p></blockquote></div>',
    );
    expect(textOf(e)).toBe("Thanks.\n\nOn Monday, Aoife wrote:\n\n> old");
    const node = e.state.doc.child(1);
    expect(node.type.name).toBe("quoted");
    expect(node.attrs.open).toBe(false);
    expect(document.querySelector(".quoted[data-open='false'] .quoted-toggle")).not.toBeNull();
  });

  test("hard breaks become newlines inside a paragraph", async () => {
    const e = await open("<p>Best,<br>Aoife</p>");
    expect(textOf(e)).toBe("Best,\nAoife");
  });
});
