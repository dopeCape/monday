// Templates in a compose surface (docs/spec/templates.md, "Using a Template"):
// the picker opened by the trigger at a line start or by its key, inserting
// a Template at the caret, filling its Placeholders from the Thread at once,
// Tab and Shift-Tab between chips, the chip's menu of candidates with "Type
// it", and why Send is refused while a required Placeholder is left. One
// ProseMirror plugin, put first, carries the keys and the clicks; the rest is
// React state over the Tiptap editor the surface already has.

import type { Id, Person, Template, TemplateRank, TemplateSuggestResult } from "@monday/shared";
import { placeholderLabel, placeholdersIn } from "@monday/shared";
import { Btn, cx, Icon, type Placement, placeMenu } from "@monday/ui";
import { GearSixIcon, NotepadIcon, XIcon } from "@phosphor-icons/react";
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
import { chordLabel, chordOf, normalizeChord } from "../keyboard/keymaps.ts";
import type { Composer } from "../screens/compose/composer.ts";
import { AnchoredMenu } from "../screens/compose/Menu.tsx";
import { type TemplateLink, takeQueuedTemplate } from "./link.ts";
import { filterTemplates, type RankedItems, rankTemplates, triggerAt } from "./picker.ts";
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
  /**
   * The one quiet line above the editor: "Use Confirm the time (Tab)", the
   * softer "Maybe: Offer other times (Tab)", the one-time "Type ;; for
   * templates", or null.
   */
  suggestionLine: ReactNode;
  /** The Template suggested now, if any; `soft` for the Maybe line. */
  suggested: Suggested | null;
  /** The toolbar's Templates button: opens the picker at the caret, or the end of the text. */
  button: ReactNode;
  /** Opens the picker as the button does. */
  openPicker(): void;
  /** Inserts a Template at the caret as if picked. */
  insert(template: Template, range?: { from: number; to: number }): void;
}

/** Where the owner's own words end: before the quoted history, or at the end of the document. */
function ownRange(editor: TiptapEditor): { from: number; to: number; text: string } {
  let end = editor.state.doc.content.size;
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === "quoted" && offset < end) end = offset;
  });
  const text = editor.state.doc.textBetween(0, end, "\n", "\n");
  // Inside the first and the last block, so the Template replaces their text.
  return { from: 1, to: Math.max(1, end - 1), text };
}

/** What the owner typed around a range (the picker's trigger), for the ranking. */
function typedAround(editor: TiptapEditor, from: number, to: number): string {
  const own = ownRange(editor);
  const end = own.to + 1;
  const a = Math.min(from, end);
  const b = Math.min(Math.max(to, a), end);
  const doc = editor.state.doc;
  return `${doc.textBetween(0, a, "\n", "\n")}${doc.textBetween(b, end, "\n", "\n")}`.trim();
}

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

export interface Suggested {
  templateId: Id;
  name: string;
  /** The softer line: the closer look rejected it, but the ranking still leans to it. */
  soft?: boolean;
}

/** "Template suggestions need a judge" is said once per window session, quietly. */
let unavailableSaid = false;

export function useTemplateCompose(o: TemplateComposeOptions): TemplateCompose {
  const { link, editor } = o;
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [chipMenu, setChipMenu] = useState<ChipMenuState | null>(null);
  const [subjectNames, setSubjectNames] = useState<string[]>([]);
  const enabled = Boolean(link?.enabled);
  const library = link?.library ?? [];
  // Jev's ranking for this opening of the picker: null until it is back (or never asked).
  const [rank, setRank] = useState<TemplateRank[] | null>(null);
  const rankOptions = useMemo(
    () => ({
      max: link?.ranking.suggestedMax ?? 0,
      floor: link?.ranking.suggestedFloor ?? 1,
    }),
    [link?.ranking.suggestedMax, link?.ranking.suggestedFloor],
  );
  const ranked = useMemo<RankedItems>(
    () =>
      picker
        ? rankTemplates(filterTemplates(library, picker.query), rank, rankOptions)
        : { items: [], suggested: 0, p: new Map() },
    [library, picker, rank, rankOptions],
  );
  const items = ranked.items;

  // Suggestions while typing (slice 37): the Template suggested, the replace question, the quiet line.
  const [suggested, setSuggested] = useState<Suggested | null>(null);
  /** A suggestion is being worked out: the line says so, so the owner knows to wait. */
  const [looking, setLooking] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const dismissed = useRef(false);
  const lastAsked = useRef(0);
  const asking = useRef(0);

  // Latest values for the plugin, which is made once per editor.
  const latest = useRef({ o, picker, items, enabled, suggested, rankOptions });
  latest.current = { o, picker, items, enabled, suggested, rankOptions };

  const insert = useCallback((template: Template, range?: { from: number; to: number }) => {
    const { o: opts } = latest.current;
    const ed = opts.editor;
    if (!ed || !opts.link) return;
    const at = range ?? { from: ed.state.selection.from, to: ed.state.selection.to };
    insertTemplate(ed, at, template);
    setPicker(null);
    // Using a template is knowing where they are: the one-time hint has done its work.
    if (opts.link.hint.show) opts.link.hint.dismiss();
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

  /** The suggestion goes away for the rest of this Draft: Esc, or it was used. */
  const dismiss = useCallback(() => {
    dismissed.current = true;
    asking.current++;
    setSuggested(null);
    setConfirmReplace(false);
  }, []);

  /** Inserts the suggested Template: over what was typed, or at the caret when the owner keeps it. */
  const takeSuggested = useCallback(
    (replace: boolean) => {
      const { o: opts, suggested: s } = latest.current;
      const ed = opts.editor;
      const template = s ? opts.link?.library.find((t) => t.id === s.templateId) : undefined;
      dismiss();
      if (!ed || !template) return;
      insert(template, replace ? ownRange(ed) : undefined);
    },
    [dismiss, insert],
  );

  /** Tab on the suggestion line: one line typed is replaced; more asks first. */
  const accept = useCallback(() => {
    const ed = latest.current.o.editor;
    if (!ed) return;
    const lines = ownRange(ed)
      .text.split("\n")
      .filter((l) => l.trim());
    if (lines.length > 1) setConfirmReplace(true);
    else takeSuggested(true);
  }, [takeSuggested]);

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
      const plainTab = event.key === "Tab" && !event.altKey && !event.metaKey && !event.ctrlKey;
      if (plainTab && chipsIn(ed.state.doc).length > 0) {
        return moveToChip(ed, event.shiftKey ? -1 : 1);
      }
      if (latest.current.suggested) {
        if (plainTab && !event.shiftKey) {
          accept();
          return true;
        }
        if (event.key === "Escape") {
          dismiss();
          return true;
        }
      }
      return false;
    },
    [pick, accept, dismiss],
  );

  /** The button: the picker at the caret, or at the end of the owner's text when the editor is not focused. */
  const openPicker = useCallback(() => {
    const { o: opts, picker: p, enabled: on } = latest.current;
    const ed = opts.editor;
    if (!ed || !opts.link || !on) return;
    if (p) {
      setPicker(null);
      return;
    }
    let { from, to } = ed.state.selection;
    if (!ed.isFocused) {
      const end = ownRange(ed).to;
      from = end;
      to = end;
    }
    setPicker({ mode: "key", from, to, query: "", index: 0 });
  }, []);

  // When the picker opens in a reply, or with something typed, Jev's ranking
  // reorders it once it is back; the picker opens at once in its own order.
  const pickerOpen = picker !== null;
  const opening = useRef(0);
  useEffect(() => {
    const mine = ++opening.current;
    setRank(null);
    if (!pickerOpen) return;
    const { o: opts, picker: p } = latest.current;
    const l = opts.link;
    const ed = opts.editor;
    if (!l || !ed || !p || !l.ranking.enabled) return;
    const typed = typedAround(ed, p.from, p.to);
    if (!opts.threadId && !typed) return;
    void l.ranking
      .rank({ threadId: opts.threadId, draft: { to: [...opts.to], subject: opts.subject, typed } })
      .then((ranking) => {
        if (mine !== opening.current || !ranking) return;
        // Keep the row the owner moved to under the arrow; a list not yet moved starts at the top.
        const now = latest.current;
        const at = now.picker;
        const kept = at && at.index > 0 ? now.items[at.index]?.id : undefined;
        setRank(ranking);
        if (at && kept) {
          const next = rankTemplates(
            filterTemplates(now.o.link?.library ?? [], at.query),
            ranking,
            now.rankOptions,
          ).items.findIndex((t) => t.id === kept);
          setPicker((q) => (q ? { ...q, index: Math.max(0, next) } : q));
        }
      })
      .catch(() => {});
  }, [pickerOpen]);

  // After a pause in the first words, the two requests (docs/spec/templates.md, "When").
  const suggestion = link?.suggestion;
  const typedNow = editor && link ? ownRange(editor).text.trim() : "";
  useEffect(() => {
    const opts = latest.current.o;
    const l = opts.link;
    const ed = opts.editor;
    if (!l || !ed || !enabled || !suggestion?.enabled || dismissed.current) return;
    if (
      !typedNow ||
      typedNow.length >= suggestion.maxTypedChars ||
      chipsIn(ed.state.doc).length > 0 ||
      /data-(placeholder|filled)=/.test(opts.bodyHtml)
    ) {
      setSuggested(null);
      setLooking(false);
      return;
    }
    const wait = Math.max(
      suggestion.debounceMs,
      lastAsked.current + suggestion.minIntervalMs - Date.now(),
    );
    const timer = setTimeout(() => {
      lastAsked.current = Date.now();
      const mine = ++asking.current;
      const now = latest.current.o;
      setLooking(true);
      const draft = { to: [...now.to], subject: now.subject, typed: typedNow };
      const show = (r: TemplateSuggestResult | null) => {
        if (mine !== asking.current || dismissed.current || !r) return;
        if (r.status === "suggested") setSuggested({ templateId: r.templateId, name: r.name });
        else if ((r.status === "none" || r.status === "ranked") && r.maybe) {
          setSuggested({ templateId: r.maybe.templateId, name: r.maybe.name, soft: true });
        } else if (r.status !== "ranked") setSuggested(null);
        if (r.status === "unavailable" && !unavailableSaid) {
          unavailableSaid = true;
          setUnavailable(true);
        }
      };
      void (async () => {
        try {
          // The quick ranking first: its likeliest template shows softly at once, then the
          // closer look over that same answer confirms it (or takes it back).
          const first = await l.suggest({ threadId: now.threadId, draft, rankOnly: true });
          if (mine !== asking.current) return;
          if (first?.status === "ranked") {
            show(first);
            setLooking(false);
            show(
              await l.suggest({
                threadId: now.threadId,
                draft,
                prior: { ranking: first.ranking, gate: first.gate },
              }),
            );
            return;
          }
          // No ranking on this Server (the picker's ranking is off): the two requests in one.
          show(await l.suggest({ threadId: now.threadId, draft }));
        } catch {
          // A failed ask leaves the line as it was.
        } finally {
          if (mine === asking.current) setLooking(false);
        }
      })();
    }, wait);
    return () => clearTimeout(timer);
  }, [typedNow, enabled, suggestion]);

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
            suggestedCount={ranked.suggested}
            shares={ranked.p}
            index={picker.index}
            mode={picker.mode}
            query={picker.query}
            strings={link.strings}
            onManage={
              link.manage
                ? () => {
                    setPicker(null);
                    link.manage?.();
                  }
                : undefined
            }
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
  let suggestionLine: ReactNode = null;
  if (link && enabled) {
    const s = link.strings;
    if (confirmReplace && suggested) {
      suggestionLine = (
        <div className="tpl-suggest" role="status" data-suggest="replace">
          <span>{s.suggestReplace}</span>
          <Btn sm primary onClick={() => takeSuggested(true)}>
            {s.replaceYes}
          </Btn>
          <Btn sm onClick={() => takeSuggested(false)}>
            {s.replaceNo}
          </Btn>
        </div>
      );
    } else if (suggested) {
      suggestionLine = (
        <div
          className={cx("tpl-suggest", suggested.soft && "maybe")}
          role="status"
          data-suggest={suggested.templateId}
          data-soft={suggested.soft ? "true" : undefined}
        >
          <button
            type="button"
            className="tpl-suggest-use"
            onMouseDown={(e) => e.preventDefault()}
            onClick={accept}
          >
            {fillIn(suggested.soft ? s.suggestMaybe : s.suggestUse, { name: suggested.name })}
          </button>
          <Btn icon sm title={s.dismiss} onClick={dismiss}>
            <XIcon />
          </Btn>
        </div>
      );
    } else if (looking && !dismissed.current) {
      suggestionLine = (
        <div className="tpl-suggest quiet looking" role="status" data-suggest="looking">
          <span className="tpl-looking-dot" aria-hidden="true" />
          {s.suggestLooking}
        </div>
      );
    } else if (unavailable) {
      suggestionLine = (
        <div className="tpl-suggest quiet" role="status" data-suggest="unavailable">
          {s.unavailable}
        </div>
      );
    } else if (link.hint.show) {
      const hint = link.hint;
      suggestionLine = (
        <div className="tpl-suggest tpl-hint" role="note" data-suggest="hint">
          <Icon icon={NotepadIcon} />
          <span>{fillIn(s.hintTrigger, { trigger: link.trigger })}</span>
          <Btn sm onMouseDown={(e) => e.preventDefault()} onClick={() => hint.dismiss()}>
            {s.hintDismiss}
          </Btn>
        </div>
      );
    }
  }

  let button: ReactNode = null;
  if (link && enabled) {
    const s = link.strings;
    const tip = fillIn(s.buttonTip, {
      trigger: link.trigger,
      key: chordLabel(link.openKey, MAC),
    });
    button = (
      <Btn
        sm
        className="tpl-open"
        data-templates-open=""
        title={tip}
        aria-label={s.button}
        aria-haspopup="listbox"
        aria-expanded={picker !== null}
        on={picker !== null}
        disabled={!editor}
        onMouseDown={(e) => e.preventDefault()}
        onClick={openPicker}
      >
        <Icon icon={NotepadIcon} /> {s.button}
      </Btn>
    );
  }
  return { blocked, overlay, insert, suggestionLine, suggested, button, openPicker };
}

/* ------------------------------ The picker ------------------------------ */

interface TemplatePickerProps {
  editor: TiptapEditor;
  /** The document position the picker opens at: the trigger's start, or the caret. */
  at: number;
  items: readonly Template[];
  /** How many of `items`, from the top, Jev's ranking marks Suggested. */
  suggestedCount: number;
  /** Each ranked Template's share of the ranking, shown subtly on the Suggested. */
  shares: ReadonlyMap<string, number>;
  index: number;
  mode: "trigger" | "key";
  query: string;
  strings: TemplateLink["strings"];
  onQuery(query: string): void;
  onIndex(index: number): void;
  onPick(template: Template): void;
  onClose(): void;
  /** "Manage templates": Settings › Templates. */
  onManage?: (() => void) | undefined;
}

function TemplatePicker({
  editor,
  at,
  items,
  suggestedCount,
  shares,
  index,
  mode,
  query,
  strings,
  onQuery,
  onIndex,
  onPick,
  onClose,
  onManage,
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
      // The toolbar button toggles the picker itself.
      if ((e.target as Element | null)?.closest?.("[data-templates-open]")) return;
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

  const suggested = items.slice(0, suggestedCount);
  const rest = items.slice(suggestedCount);
  const own = rest.filter((t) => t.workspaceId !== null);
  const builtin = rest.filter((t) => t.workspaceId === null);
  const row = (t: Template, mark = false) => {
    const i = items.indexOf(t);
    const share = mark ? shares.get(t.id) : undefined;
    return (
      <button
        key={t.id}
        type="button"
        role="option"
        aria-selected={i === index}
        className={cx("pop-item", "tpl-item", i === index && "on", mark && "suggested")}
        data-template={t.id}
        data-suggested={mark ? "true" : undefined}
        onMouseEnter={() => onIndex(i)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onPick(t)}
      >
        <span className="tpl-line">
          <span className="tpl-name">{t.name}</span>
          {share !== undefined ? (
            <span className="tpl-share" title={strings.pickerFitTitle}>
              {fillIn(strings.pickerFit, { percent: Math.round(share * 100) })}
            </span>
          ) : null}
        </span>
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
        {suggested.length > 0 ? (
          <div className="pop-h tpl-h-suggested">{strings.pickerSuggested}</div>
        ) : null}
        {suggested.map((t) => row(t, true))}
        {own.length > 0 ? <div className="pop-h">{strings.pickerYours}</div> : null}
        {own.map((t) => row(t))}
        {builtin.length > 0 ? <div className="pop-h">{strings.pickerBuiltin}</div> : null}
        {builtin.map((t) => row(t))}
      </div>
      {onManage ? (
        <div className="tpl-picker-foot">
          <button
            type="button"
            className="tpl-manage"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onManage}
          >
            <Icon icon={GearSixIcon} /> {strings.pickerManage}
          </button>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
