// Placeholders in the compose editor (docs/spec/templates.md, "Using a
// Template"): an unfilled Placeholder is an inline chip ("invoice number")
// that keeps its name, type, hint and the Thread's candidates; a filled one is
// plain text under a faint mark until the user edits it or sends. Send is
// refused while a required chip is left, and at send the optional chips go
// with the space before them and the marks are dropped (finalizeForSend).
// The document stays plain HTML, so a Draft saved with chips reopens with
// them, and a Draft whose Template was deleted keeps its chips (still
// blocking Send).

import type { PlaceholderCandidate, PlaceholderFill, Template } from "@monday/shared";
import { fillPlaceholders, placeholderLabel } from "@monday/shared";
import { type Editor, Mark, mergeAttributes, Node } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";

export const PLACEHOLDER_NODE = "templatePlaceholder";
export const FILLED_MARK = "templateFilled";

function candidatesOf(raw: string | null): PlaceholderCandidate[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as PlaceholderCandidate[]) : [];
  } catch {
    return [];
  }
}

/** The chip: an inline atom whose text is the Placeholder's name in words. */
export const TemplatePlaceholder = Node.create({
  name: PLACEHOLDER_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      name: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-placeholder") ?? "",
        renderHTML: (a) => ({ "data-placeholder": a.name }),
      },
      type: {
        default: "text",
        parseHTML: (el) => el.getAttribute("data-type") ?? "text",
        renderHTML: (a) => ({ "data-type": a.type }),
      },
      optional: {
        default: false,
        parseHTML: (el) => el.getAttribute("data-optional") === "true",
        renderHTML: (a) => (a.optional ? { "data-optional": "true" } : {}),
      },
      hint: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-hint") ?? "",
        renderHTML: (a) => (a.hint ? { "data-hint": a.hint } : {}),
      },
      candidates: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-candidates") ?? "",
        renderHTML: (a) => (a.candidates ? { "data-candidates": a.candidates } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-placeholder]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: "ph-chip", contenteditable: "false" }),
      placeholderLabel(String(node.attrs.name)),
    ];
  },

  renderText({ node }) {
    return `{${node.attrs.name}${node.attrs.optional ? "?" : ""}}`;
  },
});

const filledKey = new PluginKey("templateFilled");

/** A filled Placeholder's value, marked until its text is edited (then it is ordinary text). */
export const TemplateFilled = Mark.create({
  name: FILLED_MARK,
  inclusive: false,
  excludes: "",

  addAttributes() {
    return {
      name: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-filled") ?? "",
        renderHTML: (a) => ({ "data-filled": a.name }),
      },
      value: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-value") ?? el.textContent ?? "",
        renderHTML: (a) => ({ "data-value": a.value }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-filled]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "ph-filled" }), 0];
  },

  addProseMirrorPlugins() {
    const type = this.type;
    return [
      new Plugin({
        key: filledKey,
        appendTransaction(transactions, _old, state) {
          if (!transactions.some((t) => t.docChanged)) return null;
          const runs: Array<{
            from: number;
            to: number;
            text: string;
            value: string;
            mark: unknown;
          }> = [];
          state.doc.descendants((node, pos) => {
            if (!node.isText) return;
            const mark = node.marks.find((m) => m.type === type);
            if (!mark) return;
            const last = runs.at(-1);
            if (last && last.to === pos && (last.mark as typeof mark).eq(mark)) {
              last.to = pos + node.nodeSize;
              last.text += node.text ?? "";
            } else {
              runs.push({
                from: pos,
                to: pos + node.nodeSize,
                text: node.text ?? "",
                value: String(mark.attrs.value),
                mark,
              });
            }
          });
          let tr = null;
          for (const r of runs) {
            if (r.text === r.value) continue;
            tr ??= state.tr;
            tr.removeMark(r.from, r.to, type);
          }
          return tr;
        },
      }),
    ];
  },
});

/* ------------------------------ Content ------------------------------ */

export interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

function chipNode(
  p: Template["placeholders"][number],
  candidates: PlaceholderCandidate[],
): JsonNode {
  return {
    type: PLACEHOLDER_NODE,
    attrs: {
      name: p.name,
      type: p.type,
      optional: p.optional,
      hint: p.hint,
      candidates: candidates.length ? JSON.stringify(candidates) : "",
    },
  };
}

function filledText(name: string, value: string): JsonNode {
  return { type: "text", text: value, marks: [{ type: FILLED_MARK, attrs: { name, value } }] };
}

/**
 * A Template's body as editor content: paragraphs at blank lines, breaks at
 * single newlines, each Placeholder a chip, or its value under the filled
 * mark when a fill has one.
 */
export function templateContent(
  template: Pick<Template, "body" | "placeholders">,
  fills: readonly PlaceholderFill[] = [],
): JsonNode[] {
  const declared = new Map(template.placeholders.map((p) => [p.name, p]));
  const filled = new Map(fills.map((f) => [f.name, f]));
  const inline = (line: string): JsonNode[] => {
    const out: JsonNode[] = [];
    const text = (t: string) => {
      const prev = out.at(-1);
      if (prev?.type === "text" && !prev.marks) prev.text = `${prev.text ?? ""}${t}`;
      else out.push({ type: "text", text: t });
    };
    let last = 0;
    for (const m of line.matchAll(/\{([a-z][a-z0-9_]{0,63})(\?)?\}/g)) {
      const start = m.index ?? 0;
      if (start > last) text(line.slice(last, start));
      const p = declared.get(m[1] ?? "");
      const f = p ? filled.get(p.name) : undefined;
      if (!p) text(m[0]);
      else if (f?.value) out.push(filledText(p.name, f.value));
      else out.push(chipNode(p, f?.candidates ?? []));
      last = start + m[0].length;
    }
    if (last < line.length) text(line.slice(last));
    return out;
  };
  return template.body
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((para): JsonNode => {
      const lines = para.split("\n");
      const content: JsonNode[] = [];
      lines.forEach((line, i) => {
        if (i > 0) content.push({ type: "hardBreak" });
        content.push(...inline(line));
      });
      return content.length ? { type: "paragraph", content } : { type: "paragraph" };
    });
}

export interface ChipAt {
  name: string;
  optional: boolean;
  type: string;
  hint: string;
  candidates: PlaceholderCandidate[];
  pos: number;
}

/** Every chip in the document, in order. */
export function chipsIn(doc: PmNode): ChipAt[] {
  const out: ChipAt[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== PLACEHOLDER_NODE) return;
    out.push({
      name: String(node.attrs.name),
      optional: Boolean(node.attrs.optional),
      type: String(node.attrs.type),
      hint: String(node.attrs.hint),
      candidates: candidatesOf(node.attrs.candidates as string | null),
      pos,
    });
  });
  return out;
}

/**
 * Replaces the typed range (the trigger and its query) with a Template's
 * body; the caret lands on the first chip, or after the text when none is left.
 */
export function insertTemplate(
  editor: Editor,
  range: { from: number; to: number },
  template: Pick<Template, "body" | "placeholders">,
  fills: readonly PlaceholderFill[] = [],
): void {
  const content = templateContent(template, fills);
  // One paragraph goes inline where the caret is; several replace the line they start on.
  const single = content.length === 1 ? (content[0]?.content ?? []) : content;
  editor.chain().focus().insertContentAt(range, single).run();
  const first = chipsIn(editor.state.doc).find((c) => c.pos >= range.from);
  if (first) selectChip(editor, first.pos);
}

/** Selects the chip at `pos`, so typing replaces it. */
export function selectChip(editor: Editor, pos: number): void {
  const tr = editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
}

/** Tab and Shift-Tab: the next or previous chip from the selection; false when there is none. */
export function moveToChip(editor: Editor, direction: 1 | -1): boolean {
  const chips = chipsIn(editor.state.doc);
  const { from, to } = editor.state.selection;
  const target =
    direction === 1
      ? (chips.find((c) => c.pos >= to) ?? chips.find((c) => c.pos > from))
      : [...chips].reverse().find((c) => c.pos < from);
  if (!target) return false;
  selectChip(editor, target.pos);
  return true;
}

/** Fills one chip with a value (a candidate picked from its menu): the value under the filled mark. */
export function fillChip(editor: Editor, pos: number, value: string): boolean {
  const node = editor.state.doc.nodeAt(pos);
  if (!node || node.type.name !== PLACEHOLDER_NODE) return false;
  const name = String(node.attrs.name);
  editor
    .chain()
    .focus()
    .insertContentAt({ from: pos, to: pos + node.nodeSize }, [filledText(name, value)])
    .run();
  return true;
}

/** "Type it": the chip goes and the caret stays where it was, for the user's own words. */
export function clearChip(editor: Editor, pos: number): boolean {
  const node = editor.state.doc.nodeAt(pos);
  if (!node || node.type.name !== PLACEHOLDER_NODE) return false;
  editor
    .chain()
    .focus()
    .deleteRange({ from: pos, to: pos + node.nodeSize })
    .run();
  return true;
}

/**
 * The fills that arrived after the Template went in: every chip whose name
 * was filled becomes its value; the others keep their chip and learn their
 * candidates, likeliest first, for the menu. Returns how many were filled.
 */
export function applyFills(editor: Editor, fills: readonly PlaceholderFill[]): number {
  const byName = new Map(fills.map((f) => [f.name, f]));
  const chips = chipsIn(editor.state.doc);
  let tr = editor.state.tr;
  let filled = 0;
  // From the end, so earlier positions stay valid as chips turn into text.
  for (const chip of [...chips].reverse()) {
    const f = byName.get(chip.name);
    if (!f) continue;
    const node = tr.doc.nodeAt(chip.pos);
    if (!node) continue;
    if (f.value) {
      const mark = editor.schema.marks[FILLED_MARK]?.create({ name: chip.name, value: f.value });
      tr = tr.replaceWith(
        chip.pos,
        chip.pos + node.nodeSize,
        editor.schema.text(f.value, mark ? [mark] : []),
      );
      filled++;
    } else if (f.candidates.length) {
      tr = tr.setNodeMarkup(chip.pos, undefined, {
        ...node.attrs,
        candidates: JSON.stringify(f.candidates),
      });
    }
  }
  if (tr.docChanged) editor.view.dispatch(tr);
  return filled;
}

/* ------------------------------ Send ------------------------------ */

const CHIP_HTML = /<span\b[^>]*\bdata-placeholder="([^"]*)"[^>]*>[^<]*<\/span>/g;

/** The required Placeholders a Draft's HTML still holds as chips, in order, each once. */
export function unfilledInHtml(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(CHIP_HTML)) {
    if (/\bdata-optional="true"/.test(m[0])) continue;
    const name = m[1] ?? "";
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * The Draft as it is sent: an unfilled optional chip goes with the space
 * before it, a filled value loses its mark, and the text alternative drops
 * the same optional Placeholders. Required chips stay (Send refuses them).
 */
export function finalizeForSend(content: { bodyHtml: string; bodyText: string }): {
  bodyHtml: string;
  bodyText: string;
} {
  const bodyHtml = content.bodyHtml
    .replace(/(\s|&nbsp;)?<span\b[^>]*\bdata-optional="true"[^>]*>[^<]*<\/span>/g, (whole) =>
      /\bdata-placeholder=/.test(whole) ? "" : whole,
    )
    .replace(/<span\b[^>]*\bdata-filled="[^"]*"[^>]*>([\s\S]*?)<\/span>/g, "$1");
  return { bodyHtml, bodyText: fillPlaceholders(content.bodyText, {}) };
}

/** Send refused: these required Placeholders are still chips. */
export class UnfilledPlaceholderError extends Error {
  constructor(readonly names: string[]) {
    super(`unfilled placeholder: ${names.join(", ")}`);
    this.name = "UnfilledPlaceholderError";
  }
}

/** Whether a Draft holds any Template markup, so the send path knows to finalize it. */
export function hasTemplateMarkup(html: string): boolean {
  return /\bdata-(placeholder|filled)="/.test(html);
}
