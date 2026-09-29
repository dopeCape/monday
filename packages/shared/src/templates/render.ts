// A Template as Draft content, for a Draft made on the Server (the Agent's
// use_template, a Workflow's draft_from_template): the same markup the
// compose editor writes, so the Draft opens with an unfilled Placeholder as a
// chip (still blocking Send) and a filled one under its faint mark. Pure
// string building; no DOM.

import { fillPlaceholders, placeholderLabel } from "./syntax.ts";
import type { PlaceholderFill, Template } from "./types.ts";

const escapeText = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttr = (s: string) => escapeText(s).replaceAll('"', "&quot;");

/** The body as editor HTML: paragraphs at blank lines, breaks at newlines, chips and marked values. */
export function templateHtml(
  template: Pick<Template, "body" | "placeholders">,
  fills: readonly PlaceholderFill[] = [],
): string {
  const declared = new Map(template.placeholders.map((p) => [p.name, p]));
  const filled = new Map(fills.map((f) => [f.name, f]));
  const line = (text: string): string => {
    let out = "";
    let last = 0;
    for (const m of text.matchAll(/\{([a-z][a-z0-9_]{0,63})(\?)?\}/g)) {
      const start = m.index ?? 0;
      out += escapeText(text.slice(last, start));
      const p = declared.get(m[1] ?? "");
      const f = p ? filled.get(p.name) : undefined;
      if (!p) out += escapeText(m[0]);
      else if (f?.value) {
        out += `<span data-filled="${escapeAttr(p.name)}" data-value="${escapeAttr(f.value)}" class="ph-filled">${escapeText(f.value)}</span>`;
      } else {
        const attrs = [
          `data-placeholder="${escapeAttr(p.name)}"`,
          `data-type="${escapeAttr(p.type)}"`,
          ...(p.optional ? ['data-optional="true"'] : []),
          ...(p.hint ? [`data-hint="${escapeAttr(p.hint)}"`] : []),
          ...(f?.candidates.length
            ? [`data-candidates="${escapeAttr(JSON.stringify(f.candidates))}"`]
            : []),
          'class="ph-chip"',
          'contenteditable="false"',
        ];
        out += `<span ${attrs.join(" ")}>${escapeText(placeholderLabel(p.name))}</span>`;
      }
      last = start + m[0].length;
    }
    return out + escapeText(text.slice(last));
  };
  return template.body
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((para) => `<p>${para.split("\n").map(line).join("<br>")}</p>`)
    .join("");
}

/** The text alternative: filled values in, unfilled ones as {name}. */
export function templateText(
  template: Pick<Template, "body">,
  fills: readonly PlaceholderFill[] = [],
): string {
  const values = Object.fromEntries(fills.map((f) => [f.name, f.value]));
  // Optional ones stay written {name?} until the send path drops them, as the editor writes them.
  return template.body.replace(/\{([a-z][a-z0-9_]{0,63})(\?)?\}/g, (whole, name: string) => {
    const v = values[name];
    return v ? v : whole;
  });
}

/** The values a Template's subject takes from fills; unfilled ones stay {name}. */
export function templateSubject(subject: string, fills: readonly PlaceholderFill[] = []): string {
  return fillPlaceholders(
    subject,
    Object.fromEntries(fills.flatMap((f) => (f.value ? [[f.name, f.value]] : []))),
  );
}
