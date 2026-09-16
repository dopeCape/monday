// The rich text editor for a Draft: Tiptap (ProseMirror) with the StarterKit
// nodes and marks, Markdown input rules (**bold**, _italic_, "- " lists,
// "1. " numbered, "> " quotes, backtick code) and a small toolbar. Produces
// clean HTML through Tiptap's serializer and a plain-text alternative through
// text.ts, so both parts of a send come from the same document (ADR 0010).

import { Btn, Kbd } from "@monday/ui";
import {
  CodeIcon,
  LinkSimpleIcon,
  ListBulletsIcon,
  ListNumbersIcon,
  QuotesIcon,
  TextBIcon,
  TextItalicIcon,
} from "@phosphor-icons/react";
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

export interface EditorProps {
  /** The Draft's html on open; later changes come back through onChange only. */
  initialHtml: string;
  placeholder?: string | undefined;
  onChange: (value: EditorValue) => void;
  onBlur?: (() => void) | undefined;
  /** Focus on mount, with the caret at the start (a reply starts above the quote). */
  autofocus?: boolean | undefined;
  strings: EditorStrings;
  /** Show the toolbar. */
  toolbar: boolean;
  className?: string | undefined;
  /** For tests: the Editor once it exists. */
  onReady?: ((editor: TiptapEditor) => void) | undefined;
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
  toolbar,
  className,
  onReady,
  ghost,
  ghostKey = "tab",
}: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<TiptapEditor | null>(null);
  const [, bump] = useState(0);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const blurRef = useRef(onBlur);
  blurRef.current = onBlur;
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
          const text = ghostRef.current;
          if (event.key !== "Tab" || !text) return false;
          event.preventDefault();
          instance.chain().focus("end").insertContent(`<p>${text}</p>`).run();
          ghostRef.current = undefined;
          setGhostTaken(true);
          return true;
        },
      },
      onUpdate: ({ editor: e }) => changeRef.current(editorValue(e)),
      onBlur: () => blurRef.current?.(),
      onSelectionUpdate: () => bump((n) => n + 1),
      onTransaction: () => bump((n) => n + 1),
    });
    setEditor(instance);
    onReady?.(instance);
    return () => {
      instance.destroy();
      setEditor(null);
    };
  }, [initial, placeholder, autofocus, onReady, strings.quoted]);

  const setLink = () => {
    if (!editor) return;
    const current = editor.getAttributes("link").href as string | undefined;
    const href =
      typeof window !== "undefined" ? window.prompt(strings.linkPrompt, current ?? "") : null;
    if (href === null) return;
    if (href.trim() === "") editor.chain().focus().unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: href.trim() }).run();
  };

  const tool = (
    title: string,
    active: boolean,
    Icon: typeof TextBIcon,
    run: () => void,
    key: string,
  ) => (
    <Btn
      key={key}
      icon
      sm
      title={title}
      on={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      <Icon />
    </Btn>
  );

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
      {toolbar && editor ? (
        <div className="c-tools" role="toolbar" aria-label={strings.bold}>
          {tool(
            strings.bold,
            editor.isActive("bold"),
            TextBIcon,
            () => editor.chain().focus().toggleBold().run(),
            "b",
          )}
          {tool(
            strings.italic,
            editor.isActive("italic"),
            TextItalicIcon,
            () => editor.chain().focus().toggleItalic().run(),
            "i",
          )}
          {tool(
            strings.bullets,
            editor.isActive("bulletList"),
            ListBulletsIcon,
            () => editor.chain().focus().toggleBulletList().run(),
            "ul",
          )}
          {tool(
            strings.numbered,
            editor.isActive("orderedList"),
            ListNumbersIcon,
            () => editor.chain().focus().toggleOrderedList().run(),
            "ol",
          )}
          {tool(strings.link, editor.isActive("link"), LinkSimpleIcon, setLink, "a")}
          {tool(
            strings.quote,
            editor.isActive("blockquote"),
            QuotesIcon,
            () => editor.chain().focus().toggleBlockquote().run(),
            "q",
          )}
          {tool(
            strings.code,
            editor.isActive("codeBlock"),
            CodeIcon,
            () => editor.chain().focus().toggleCodeBlock().run(),
            "c",
          )}
        </div>
      ) : null}
    </div>
  );
}
