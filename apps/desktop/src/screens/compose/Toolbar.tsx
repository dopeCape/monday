// The writing toolbar above the body: bold, italic and link; bullets,
// numbered and quote; clear formatting; the assist menu at the far end. Each
// button names its shortcut, and the shortcuts work with the toolbar hidden
// (compose.toolbar off). The link opens a small field anchored to its button
// instead of the browser's prompt, which a desktop webview may not show.
// In the phone form the row keeps bold, italic, link and bullets and puts
// numbered, quote and clear formatting behind a More button, as a sheet.

import { Btn, Icon } from "@monday/ui";
import {
  DotsThreeIcon,
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
import { useShellForm } from "../../shell/Shell.tsx";
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
  /** The Templates button (templates/compose.tsx), after the formatting. */
  templates?: ReactNode | undefined;
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
  templates,
  assist,
  className,
}: ToolbarProps) {
  useEditorTick(editor);
  const linkButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const [href, setHref] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  // The phone form folds what does not fit into the More sheet.
  const compact = useShellForm() === "phone";

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
  const numbered = (e: TiptapEditor) => e.chain().focus().toggleOrderedList().run();
  const quote = (e: TiptapEditor) => e.chain().focus().toggleBlockquote().run();
  const moreLabel = strings.more ?? strings.formatting;
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
      {compact ? (
        <Btn
          ref={moreButton}
          icon
          sm
          className="c-tools-more"
          title={moreLabel}
          aria-label={moreLabel}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          on={moreOpen || active("orderedList") || active("blockquote")}
          disabled={!editor}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setMoreOpen((o) => !o)}
        >
          <Icon icon={DotsThreeIcon} />
        </Btn>
      ) : (
        <>
          {tool(
            "ol",
            strings.numbered,
            "mod+shift+7",
            ListNumbersIcon,
            numbered,
            active("orderedList"),
          )}
          {tool("q", strings.quote, "mod+shift+b", QuotesIcon, quote, active("blockquote"))}
          <span className="vr" />
          {tool("x", strings.clearFormat, "mod+\\", TextTSlashIcon, clearFormatting, false)}
        </>
      )}
      {templates ? (
        <>
          <span className="vr" />
          {templates}
        </>
      ) : null}
      <span className="sp" />
      {assist}
      {linkField}
      {compact && moreOpen ? (
        <AnchoredMenu
          anchor={moreButton.current}
          label={moreLabel}
          items={[
            { key: "ol", label: strings.numbered },
            { key: "q", label: strings.quote },
            { key: "x", label: strings.clearFormat },
          ]}
          onPick={(key) => {
            setMoreOpen(false);
            if (!editor) return;
            if (key === "ol") numbered(editor);
            else if (key === "q") quote(editor);
            else clearFormatting(editor);
          }}
          onClose={() => setMoreOpen(false)}
          className="c-tools-sheet"
        />
      ) : null}
    </div>
  );
}
