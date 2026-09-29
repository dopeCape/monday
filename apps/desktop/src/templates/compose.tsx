// Templates in a compose surface (docs/spec/templates.md, "Using a Template"):
// the picker opened by the trigger at a line start or by its key, inserting
// a Template at the caret, filling its Placeholders from the Thread at once,
// Tab and Shift-Tab between chips, the chip's menu of candidates with "Type
// it", and why Send is refused while a required Placeholder is left. One
// ProseMirror plugin, put first, carries the keys and the clicks; the rest is
// React state over the Tiptap editor the surface already has.

import type { Id, Person, Template } from "@monday/shared";
import { placeholderLabel, placeholdersIn } from "@monday/shared";
import { cx, type Placement, placeMenu } from "@monday/ui";
import type { Editor as TiptapEditor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { chordOf, normalizeChord } from "../keyboard/keymaps.ts";
import type { Composer } from "../screens/compose/composer.ts";
import { AnchoredMenu } from "../screens/compose/Menu.tsx";
import { type TemplateLink, takeQueuedTemplate } from "./link.ts";
import { filterTemplates, triggerAt } from "./picker.ts";
import {
  applyFills,
  chipsIn,
  clearChip,
  fillChip,
  insertTemplate,
  moveToChip,
  PLACEHOLDER_NODE,
  unfilledInHtml,
} from "./placeholders.ts";
import { fillIn } from "./strings.ts";

const pluginKey = new PluginKey("mondayTemplates");

interface PickerState {
  mode: "trigger" | "key";
  from: number;
  to: number;
  query: string;
  index: number;
}

interface ChipMenuState {
  pos: number;
  name: string;
  anchor: HTMLElement | null;
}

export interface TemplateComposeOptions {
  /** Whose queue a Template picked from the palette waits in. */
  composer?: Composer | undefined;
  link: TemplateLink | null;
  editor: TiptapEditor | null;
  threadId: Id | null;
  to: readonly Person[];
  subject: string;
  setSubject: (subject: string) => void;
  bodyHtml: string;
}

export interface TemplateCompose {
  /** "Fill invoice number first" while a required Placeholder is unfilled, else null. */
  blocked: string | null;
  /** The picker and the chip menu, in portals; render anywhere in the surface. */
  overlay: ReactNode;
  /** Inserts a Template at the caret as if picked (the suggestion line's Tab). */
  insert(template: Template, range?: { from: number; to: number }): void;
}

export function useTemplateCompose(o: TemplateComposeOptions): TemplateCompose {
  const { link, editor } = o;
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [chipMenu, setChipMenu] = useState<ChipMenuState | null>(null);
  const [subjectNames, setSubjectNames] = useState<string[]>([]);
  const enabled = Boolean(link?.enabled);
  const library = link?.library ?? [];
  const items = useMemo(
    () => (picker ? filterTemplates(library, picker.query) : []),
    [library, picker],
  );

  // Latest values for the plugin, which is made once per editor.
  const latest = useRef({ o, picker, items, enabled });
  latest.current = { o, picker, items, enabled };

  const insert = useCallback((template: Template, range?: { from: number; to: number }) => {
    const { o: opts } = latest.current;
    const ed = opts.editor;
    if (!ed || !opts.link) return;
    const at = range ?? { from: ed.state.selection.from, to: ed.state.selection.to };
    insertTemplate(ed, at, template);
    setPicker(null);
    let subjectTemplate: string | null = null;
    if (template.kind === "starter" && template.subject && !opts.subject.trim()) {
      subjectTemplate = template.subject;
      opts.setSubject(template.subject);
      setSubjectNames(placeholdersIn(template.subject).map((u) => u.name));
    }
    const threadId = opts.threadId;
    void opts.link
      .fill(template.id, { threadId, to: [...opts.to] })
      .then((result) => {
        const current = latest.current.o;
        if (!result || !current.editor) return;
        applyFills(current.editor, result.fills);
        if (subjectTemplate !== null) {
          let next = current.subject || subjectTemplate;
          for (const f of result.fills) {
            if (f.value) next = next.replaceAll(`{${f.name}}`, f.value);
          }
          if (next !== current.subject) current.setSubject(next);
        }
      })
      .catch(() => {});
  }, []);

  const pick = useCallback(
    (template: Template) => {
      const p = latest.current.picker;
      insert(template, p ? { from: p.from, to: p.to } : undefined);
    },
    [insert],
  );

  const onKey = useCallback(
    (event: KeyboardEvent): boolean => {
      const { picker: p, items: list, enabled: on, o: opts } = latest.current;
      const ed = opts.editor;
      if (!ed || !on || !opts.link) return false;
      if (p && p.mode === "trigger") {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const step = event.key === "ArrowDown" ? 1 : -1;
          setPicker({
            ...p,
            index: Math.min(Math.max(0, p.index + step), Math.max(0, list.length - 1)),
          });
          return true;
        }
        if (event.key === "Enter") {
          const chosen = list[p.index];
          if (chosen) {
            pick(chosen);
            return true;
          }
          setPicker(null);
          return false;
        }
        if (event.key === "Escape") {
          setPicker(null);
          return true;
        }
      }
      if (chordOf(event) === normalizeChord(opts.link.openKey)) {
        const { from, to } = ed.state.selection;
        setPicker({ mode: "key", from, to, query: "", index: 0 });
        return true;
      }
      if (event.key === "Tab" && !event.altKey && !event.metaKey && !event.ctrlKey) {
        if (chipsIn(ed.state.doc).length === 0) return false;
        return moveToChip(ed, event.shiftKey ? -1 : 1);
      }
      return false;
    },
    [pick],
  );

  // The plugin: first in line, so Enter and the arrows reach the picker before the editor.
  useEffect(() => {
    if (!editor) return;
    const plugin = new Plugin({
      key: pluginKey,
      props: {
        handleKeyDown: (_view, event) => onKey(event),
        handleClickOn: (view, _pos, node, nodePos) => {
          if (node.type.name !== PLACEHOLDER_NODE || !latest.current.enabled) return false;
          const dom = view.nodeDOM(nodePos);
          setChipMenu({
            pos: nodePos,
            name: String(node.attrs.name),
            anchor: dom instanceof HTMLElement ? dom : null,
          });
          return false;
        },
      },
      view: () => ({
        update: (view) => {
          const { enabled: on, o: opts, picker: p } = latest.current;
          if (!on || !opts.link) return;
          if (p?.mode === "key") return;
          const found = triggerAt(view.state, opts.link.trigger);
          if (!found) {
            if (p) setPicker(null);
            return;
          }
          if (p && p.from === found.from && p.query === found.query) return;
          setPicker({ mode: "trigger", ...found, index: 0 });
        },
      }),
    });
    editor.registerPlugin(plugin, (p, plugins) => [p, ...plugins]);
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(pluginKey);
    };
  }, [editor, onKey]);

  // A Template picked from the palette goes into the surface that opened for it.
  useEffect(() => {
    const composer = latest.current.o.composer;
    const current = latest.current.o.link;
    if (!editor || !composer || !current) return;
    const id = takeQueuedTemplate(composer);
    const template = id ? current.library.find((t) => t.id === id) : undefined;
    if (template) insert(template);
  }, [editor, insert]);

  // A chip's menu is about that chip: if it is gone (filled, typed over), the menu goes too.
  useEffect(() => {
    if (!chipMenu || !editor) return;
    const node = editor.state.doc.nodeAt(chipMenu.pos);
    if (!node || node.type.name !== PLACEHOLDER_NODE) setChipMenu(null);
  });

  const unfilled = useMemo(() => {
    const names = unfilledInHtml(o.bodyHtml);
    for (const n of subjectNames) {
      if (o.subject.includes(`{${n}}`) && !names.includes(n)) names.push(n);
    }
    return names;
  }, [o.bodyHtml, o.subject, subjectNames]);

  const blocked =
    link && unfilled[0]
      ? fillIn(link.strings.fillFirst, { placeholder: placeholderLabel(unfilled[0]) })
      : null;

  let overlay: ReactNode = null;
  if (link && enabled && editor) {
    const chip = chipMenu ? chipsIn(editor.state.doc).find((c) => c.pos === chipMenu.pos) : null;
    overlay = (
      <>
        {picker ? (
          <TemplatePicker
            editor={editor}
            at={picker.from}
            items={items}
            index={picker.index}
            mode={picker.mode}
            query={picker.query}
            strings={link.strings}
            onQuery={(query) => setPicker({ ...picker, query, index: 0 })}
            onIndex={(index) => setPicker({ ...picker, index })}
            onPick={pick}
            onClose={() => {
              setPicker(null);
              editor.commands.focus();
            }}
          />
        ) : null}
        {chipMenu && chip ? (
          <AnchoredMenu
            anchor={chipMenu.anchor}
            label={placeholderLabel(chip.name)}
            title={chip.candidates.length ? link.strings.candidates : link.strings.noCandidates}
            className="ph-menu"
            items={[
              ...chip.candidates.map((c, i) => ({
                key: `c${i}`,
                label: c.value,
                detail: c.span !== c.value ? c.span : undefined,
              })),
              { key: "type", label: link.strings.typeIt },
            ]}
            onPick={(key) => {
              setChipMenu(null);
              if (key === "type") {
                clearChip(editor, chip.pos);
                return;
              }
              const c = chip.candidates[Number(key.slice(1))];
              if (!c) return;
              fillChip(editor, chip.pos, c.value);
              if (o.subject.includes(`{${chip.name}}`)) {
                o.setSubject(o.subject.replaceAll(`{${chip.name}}`, c.value));
              }
            }}
            onClose={() => setChipMenu(null)}
          />
        ) : null}
      </>
    );
  }
  return { blocked, overlay, insert };
}

/* ------------------------------ The picker ------------------------------ */

interface TemplatePickerProps {
  editor: TiptapEditor;
  /** The document position the picker opens at: the trigger's start, or the caret. */
  at: number;
  items: readonly Template[];
  index: number;
  mode: "trigger" | "key";
  query: string;
  strings: TemplateLink["strings"];
  onQuery(query: string): void;
  onIndex(index: number): void;
  onPick(template: Template): void;
  onClose(): void;
}

function TemplatePicker({
  editor,
  at,
  items,
  index,
  mode,
  query,
  strings,
  onQuery,
  onIndex,
  onPick,
  onClose,
}: TemplatePickerProps) {
  const host = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    let coords = { left: 0, top: 0, bottom: 0, right: 0 };
    try {
      const c = editor.view.coordsAtPos(Math.min(at, editor.state.doc.content.size));
      coords = { left: c.left, top: c.top, bottom: c.bottom, right: c.right };
    } catch {}
    const box = el.getBoundingClientRect();
    setPlace(
      placeMenu(
        coords,
        { width: box.width, height: box.height },
        {
          width: window.innerWidth,
          height: window.innerHeight,
        },
      ),
    );
  }, [editor, at]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (host.current?.contains(e.target as Node)) return;
      closeRef.current();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  useEffect(() => {
    host.current
      ?.querySelectorAll<HTMLElement>(".pop-item")
      [index]?.scrollIntoView?.({ block: "nearest" });
  }, [index]);

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      onIndex(Math.min(Math.max(0, index + step), Math.max(0, items.length - 1)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const chosen = items[index];
      if (chosen) onPick(chosen);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const own = items.filter((t) => t.workspaceId !== null);
  const builtin = items.filter((t) => t.workspaceId === null);
  const row = (t: Template) => {
    const i = items.indexOf(t);
    return (
      <button
        key={t.id}
        type="button"
        role="option"
        aria-selected={i === index}
        className={cx("pop-item", "tpl-item", i === index && "on")}
        data-template={t.id}
        onMouseEnter={() => onIndex(i)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onPick(t)}
      >
        <span className="tpl-name">{t.name}</span>
        <span className="tpl-fit">{t.fitsWhen}</span>
      </button>
    );
  };

  return createPortal(
    <div
      ref={host}
      className={cx("pop anchored tpl-picker", place?.above && "above")}
      role="listbox"
      aria-label={strings.title}
      style={{
        top: place?.top ?? 0,
        left: place?.left ?? 0,
        visibility: place ? undefined : "hidden",
      }}
    >
      {mode === "key" ? (
        <div className="pop-pick">
          <input
            className="input"
            // biome-ignore lint/a11y/noAutofocus: the picker opened by its key takes the typing
            autoFocus
            aria-label={strings.pickerSearch}
            placeholder={strings.pickerSearch}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={onKey}
          />
        </div>
      ) : null}
      <div className="pop-list">
        {items.length === 0 ? <div className="pop-empty">{strings.pickerEmpty}</div> : null}
        {own.length > 0 ? <div className="pop-h">{strings.pickerYours}</div> : null}
        {own.map(row)}
        {builtin.length > 0 ? <div className="pop-h">{strings.pickerBuiltin}</div> : null}
        {builtin.map(row)}
      </div>
    </div>,
    document.body,
  );
}
