// The rich text editor for a Draft: Tiptap (ProseMirror) with the StarterKit
// nodes and marks, Markdown input rules (**bold**, _italic_, "- " lists,
// "1. " numbered, "> " quotes, backtick code) and the keyboard shortcuts the
// writing toolbar names (Mod-B, Mod-I, Mod-K for a link, Mod-Shift-8 and 7 for
// lists, Mod-Shift-B for a quote, Mod-\ to clear). Files pasted into it become
// attachments. Produces clean HTML through Tiptap's serializer and a
// plain-text alternative through text.ts, so both parts of a send come from
// the same document (ADR 0010). The toolbar is its own component
// (Toolbar.tsx) over the instance this one reports through onReady.

import { Kbd } from "@monday/ui";
import { Extension, type Extensions, Editor as TiptapEditor } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import { Quoted } from "./quoted.ts";
import { type DocNode, docToText } from "./text.ts";

export interface EditorValue {
  html: string;
  text: string;
}

export interface EditorStrings {
  bold: string;
  italic: string;
  bullets: string;
  numbered: string;
  link: string;
  linkPrompt: string;
  quote: string;
  code: string;
  clearFormat: string;
  /** The folded history toggle. */
  quoted: string;
}

/** The extension list; shared with tests so a headless Editor matches the surface. */
export function editorExtensions(placeholder = "", quotedLabel = "Quoted text"): Extensions {
  return [
    StarterKit.configure({
      heading: false,
      horizontalRule: false,
      link: { openOnClick: false, autolink: true, linkOnPaste: true },
    }),
    Quoted.configure({ label: quotedLabel }),
    placeholderExtension(placeholder),
  ];
}

/** A one-line placeholder on the empty first paragraph, without a package for it. */
function placeholderExtension(text: string) {
  return Extension.create({
    name: "mondayPlaceholder",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          props: {
            decorations(state) {
              if (!text) return null;
              const first = state.doc.firstChild;
              if (!first || state.doc.childCount !== 1) return null;
              if (first.type.name !== "paragraph" || first.content.size !== 0) return null;
              return DecorationSet.create(state.doc, [
                Decoration.node(0, first.nodeSize, {
                  class: "is-editor-empty",
                  "data-placeholder": text,
                }),
              ]);
            },
          },
        }),
      ];
    },
  });
}

/** The html and text a document yields. */
export function editorValue(editor: TiptapEditor): EditorValue {
  return { html: editor.getHTML(), text: docToText(editor.getJSON() as DocNode) };
}

/** Clears every mark and turns lists, quotes and code back into paragraphs. */
export function clearFormatting(editor: TiptapEditor): void {
  editor.chain().focus().unsetAllMarks().clearNodes().run();
}

/** Sets, changes or (with an empty href) removes the link on the selection. */
export function setLink(editor: TiptapEditor, href: string): void {
  const h = href.trim();
  if (h === "") editor.chain().focus().extendMarkRange("link").unsetLink().run();
  else editor.chain().focus().extendMarkRange("link").setLink({ href: h }).run();
}

/** What the writing assist works on: the selection, or the user's own text above the quoted history. */
export interface AssistTarget {
  from: number;
  to: number;
  text: string;
  selection: boolean;
}

/** Where the user's own words end: before the quoted history, or at the end of the document. */
function ownEnd(editor: TiptapEditor): number {
  let end = editor.state.doc.content.size;
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === "quoted" && offset < end) end = offset;
  });
  return end;
}

export function assistTarget(editor: TiptapEditor): AssistTarget {
  const { from, to, empty } = editor.state.selection;
  if (!empty) {
    return { from, to, text: editor.state.doc.textBetween(from, to, "\n\n"), selection: true };
  }
  const end = ownEnd(editor);
  return { from: 0, to: end, text: editor.state.doc.textBetween(0, end, "\n\n"), selection: false };
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Plain text as editor HTML: blank lines are paragraphs, single newlines are breaks. */
export function textToParagraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/**
 * Writes an accepted suggestion into the document: in place of the text it
 * was made from, or after it for "continue writing". When the text changed
 * while the model was writing, the suggestion goes in at the caret instead
 * of over words the user has since typed.
 */
export function applySuggestion(
  editor: TiptapEditor,
  target: AssistTarget,
  text: string,
  mode: "replace" | "append",
): void {
  const size = editor.state.doc.content.size;
  const still =
    target.to <= size &&
    editor.state.doc.textBetween(target.from, target.to, "\n\n") === target.text;
  const inline = target.selection && !/\n\s*\n/.test(text.trim());
  const content = inline ? escapeHtml(text.trim()) : textToParagraphs(text);
  if (!still) {
    editor.chain().focus().insertContent(content).run();
    return;
  }
  if (mode === "append") {
    editor.chain().focus().insertContentAt(target.to, content).run();
    return;
  }
  editor.chain().focus().insertContentAt({ from: target.from, to: target.to }, content).run();
}

export interface EditorProps {
  /** The Draft's html on open; later changes come back through onChange only. */
  initialHtml: string;
  placeholder?: string | undefined;
  onChange: (value: EditorValue) => void;
  onBlur?: (() => void) | undefined;
  /** Focus on mount, with the caret at the start (a reply starts above the quote). */
  autofocus?: boolean | undefined;
  strings: EditorStrings;
  className?: string | undefined;
  /** The Editor once it exists (the toolbar and the assist act on it), and null when it goes. */
  onReady?: ((editor: TiptapEditor | null) => void) | undefined;
  /** Mod-K: the toolbar opens its link field. */
  onLink?: (() => void) | undefined;
  /** Files pasted or dropped into the text: they become attachments. */
  onFiles?: ((files: File[]) => void) | undefined;
  /** A proposed continuation shown faint after the text; Tab accepts it. */
  ghost?: string | undefined;
  /** The Tab hint's label. */
  ghostKey?: string | undefined;
}

export function Editor({
  initialHtml,
  placeholder,
  onChange,
  onBlur,
  autofocus,
  strings,
  className,
  onReady,
  onLink,
  onFiles,
  ghost,
  ghostKey = "tab",
}: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const blurRef = useRef(onBlur);
  blurRef.current = onBlur;
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  const linkRef = useRef(onLink);
  linkRef.current = onLink;
  const filesRef = useRef(onFiles);
  filesRef.current = onFiles;
  const ghostRef = useRef(ghost);
  ghostRef.current = ghost;
  const [ghostTaken, setGhostTaken] = useState(false);
  // The editor owns its document after mount; the html feeds it only once.
  const initialRef = useRef(initialHtml);
  const initial = initialRef.current;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const instance = new TiptapEditor({
      element: el,
      extensions: editorExtensions(placeholder, strings.quoted),
      content: initial,
      autofocus: autofocus ? "start" : false,
      editorProps: {
        attributes: { class: "tiptap", role: "textbox", "aria-multiline": "true" },
        handleKeyDown: (_view, event) => {
          const mod = event.metaKey || event.ctrlKey;
          if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
            event.preventDefault();
            linkRef.current?.();
            return true;
          }
          if (mod && event.key === "\\") {
            event.preventDefault();
            clearFormatting(instance);
            return true;
          }
          const text = ghostRef.current;
          if (event.key !== "Tab" || !text) return false;
          event.preventDefault();
          instance
            .chain()
            .focus("end")
            .insertContent(`<p>${escapeHtml(text)}</p>`)
            .run();
          ghostRef.current = undefined;
          setGhostTaken(true);
          return true;
        },
        handlePaste: (_view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length === 0 || !filesRef.current) return false;
          event.preventDefault();
          filesRef.current(files);
          return true;
        },
        handleDrop: (_view, event) => {
          const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
          // The surface around the editor takes dropped files as attachments.
          return files.length > 0 && filesRef.current !== undefined;
        },
      },
      // A plugin settling the document (the trailing paragraph after the quoted
      // history, appended to the first focus) is not the user's change: it
      // neither saves a Draft nor makes an untouched window count as written in.
      onUpdate: ({ editor: e, transaction }) => {
        if (transaction.docChanged) changeRef.current(editorValue(e));
      },
      onBlur: () => blurRef.current?.(),
    });
    readyRef.current?.(instance);
    return () => {
      readyRef.current?.(null);
      instance.destroy();
    };
  }, [initial, placeholder, autofocus, strings.quoted]);

  return (
    <div className={className}>
      <div ref={host} />
      {ghost && !ghostTaken ? (
        <p>
          <span className="ghost">
            {ghost} <Kbd>{ghostKey}</Kbd>
          </span>
        </p>
      ) : null}
    </div>
  );
}
