// The writing toolbar above the body: bold, italic and link; bullets,
// numbered and quote; clear formatting; the assist menu at the far end. Each
// button names its shortcut, and the shortcuts work with the toolbar hidden
// (compose.toolbar off). The link opens a small field anchored to its button
// instead of the browser's prompt, which a desktop webview may not show.

import { Btn, Icon } from "@monday/ui";
import {
  LinkSimpleIcon,
  ListBulletsIcon,
  ListNumbersIcon,
  QuotesIcon,
  TextBIcon,
  TextItalicIcon,
  TextTSlashIcon,
} from "@phosphor-icons/react";
import type { Editor as TiptapEditor } from "@tiptap/core";
import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";
import { chordLabel } from "../../keyboard/keymaps.ts";
import { clearFormatting, type EditorStrings, setLink } from "./Editor.tsx";
import { AnchoredMenu } from "./Menu.tsx";

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

/** "Bold (Ctrl+B)": the title a button shows, with its shortcut. */
export function withShortcut(label: string, chord: string): string {
  return `${label} (${chordLabel(chord, MAC)})`;
}

export interface ToolbarProps {
  editor: TiptapEditor | null;
  strings: EditorStrings & { formatting: string };
  /** Hidden rows still keep the link field reachable through Mod-K. */
  hidden?: boolean | undefined;
  /** The link field is open (Mod-K in the text asks for it). */
  linkOpen: boolean;
  onLinkOpen: (open: boolean) => void;
  /** The assist menu button, at the far end of the row. */
  assist?: ReactNode | undefined;
  className?: string | undefined;
}

/** Re-renders when the editor's selection or marks change, so the pressed states follow the caret. */
function useEditorTick(editor: TiptapEditor | null): void {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const on = () => bump((n) => n + 1);
    editor.on("transaction", on);
    editor.on("selectionUpdate", on);
    return () => {
      editor.off("transaction", on);
      editor.off("selectionUpdate", on);
    };
  }, [editor]);
}

export function Toolbar({
  editor,
  strings,
  hidden,
  linkOpen,
  onLinkOpen,
  assist,
  className,
}: ToolbarProps) {
  useEditorTick(editor);
  const linkButton = useRef<HTMLButtonElement>(null);
  const [href, setHref] = useState("");

  useEffect(() => {
    if (linkOpen && editor)
      setHref((editor.getAttributes("link").href as string | undefined) ?? "");
  }, [linkOpen, editor]);

  const active = (name: string) => editor?.isActive(name) ?? false;
  const tool = (
    key: string,
    label: string,
    chord: string,
    Glyph: typeof TextBIcon,
    run: (e: TiptapEditor) => void,
    on: boolean,
    ref?: Ref<HTMLButtonElement>,
  ) => (
    <Btn
      key={key}
      ref={ref}
      icon
      sm
      title={withShortcut(label, chord)}
      aria-label={label}
      aria-pressed={on}
      on={on}
      disabled={!editor}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => editor && run(editor)}
    >
      <Icon icon={Glyph} />
    </Btn>
  );

  const linkField = linkOpen ? (
    <AnchoredMenu
      anchor={linkButton.current ?? (editor ? (editor.view.dom as HTMLElement) : null)}
      label={strings.link}
      title={strings.linkPrompt}
      items={[]}
      onPick={() => {}}
      onClose={() => onLinkOpen(false)}
      focusItems={false}
      className="c-link"
    >
      <form
        className="pop-pick"
        onSubmit={(e) => {
          e.preventDefault();
          if (editor) setLink(editor, href);
          onLinkOpen(false);
        }}
      >
        <input
          className="input"
          aria-label={strings.linkPrompt}
          // biome-ignore lint/a11y/noAutofocus: the field opens to take the address
          autoFocus
          value={href}
          placeholder="https://"
          onChange={(e) => setHref(e.target.value)}
        />
        <Btn sm primary type="submit">
          {strings.link}
        </Btn>
      </form>
    </AnchoredMenu>
  ) : null;

  if (hidden) return linkField;
  return (
    <div className={className ?? "c-tools"} role="toolbar" aria-label={strings.formatting}>
      {tool(
        "b",
        strings.bold,
        "mod+b",
        TextBIcon,
        (e) => e.chain().focus().toggleBold().run(),
        active("bold"),
      )}
      {tool(
        "i",
        strings.italic,
        "mod+i",
        TextItalicIcon,
        (e) => e.chain().focus().toggleItalic().run(),
        active("italic"),
      )}
      {tool(
        "a",
        strings.link,
        "mod+k",
        LinkSimpleIcon,
        () => onLinkOpen(!linkOpen),
        active("link") || linkOpen,
        linkButton,
      )}
      <span className="vr" />
      {tool(
        "ul",
        strings.bullets,
        "mod+shift+8",
        ListBulletsIcon,
        (e) => e.chain().focus().toggleBulletList().run(),
        active("bulletList"),
      )}
      {tool(
        "ol",
        strings.numbered,
        "mod+shift+7",
        ListNumbersIcon,
        (e) => e.chain().focus().toggleOrderedList().run(),
        active("orderedList"),
      )}
      {tool(
        "q",
        strings.quote,
        "mod+shift+b",
        QuotesIcon,
        (e) => e.chain().focus().toggleBlockquote().run(),
        active("blockquote"),
      )}
      <span className="vr" />
      {tool("x", strings.clearFormat, "mod+\\", TextTSlashIcon, clearFormatting, false)}
      <span className="sp" />
      {assist}
      {linkField}
    </div>
  );
}
