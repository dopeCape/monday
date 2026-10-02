// Placeholder syntax and validation (docs/spec/templates.md, "What a Template
// is"): a Placeholder is written {name} or {name?}; every name the subject or
// body uses must be declared and every declared name used, or the Template
// does not save. Code owns this; no model is asked.

import { PLACEHOLDER_TYPES, type Placeholder, type TemplateInput } from "./types.ts";

/** One use of a Placeholder in text: `{name}` or `{name?}`. */
export const PLACEHOLDER_PATTERN = /\{([a-z][a-z0-9_]{0,63})(\?)?\}/g;

export interface PlaceholderUse {
  name: string;
  optional: boolean;
}

/** The Placeholders a text uses, in order of first use, each once. */
export function placeholdersIn(text: string): PlaceholderUse[] {
  const seen = new Map<string, PlaceholderUse>();
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1] ?? "";
    const optional = match[2] === "?";
    const prior = seen.get(name);
    if (prior) prior.optional = prior.optional && optional;
    else seen.set(name, { name, optional });
  }
  return [...seen.values()];
}

/** Every Placeholder a Template uses: the subject's first, then the body's. */
export function templateUses(input: Pick<TemplateInput, "subject" | "body">): PlaceholderUse[] {
  return placeholdersIn(`${input.subject ?? ""}\n${input.body}`);
}

/**
 * Why a Template cannot be saved, one plain line each; empty when it can.
 * Names must be declared, used, unique and of a known type, and the way the
 * text writes each one ({name} or {name?}) must match its `optional`.
 */
export function templateErrors(input: TemplateInput): string[] {
  const errors: string[] = [];
  if (!input.name.trim()) errors.push("The template needs a name.");
  if (!input.body.trim()) errors.push("The template needs a body.");
  if (input.kind === "reply" && input.subject?.trim()) {
    errors.push("Only a starter has a subject; a reply keeps the Thread's.");
  }
  const declared = new Map<string, Placeholder>();
  for (const p of input.placeholders) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(p.name)) {
      errors.push(`"${p.name}" is not a Placeholder name: lowercase letters, digits and _.`);
      continue;
    }
    if (declared.has(p.name)) errors.push(`{${p.name}} is declared twice.`);
    if (!(PLACEHOLDER_TYPES as readonly string[]).includes(p.type)) {
      errors.push(`{${p.name}} has an unknown type "${p.type}".`);
    }
    declared.set(p.name, p);
  }
  const uses = templateUses(input);
  for (const use of uses) {
    const d = declared.get(use.name);
    if (!d) {
      errors.push(`{${use.name}} is used but not declared.`);
      continue;
    }
    if (use.optional !== d.optional) {
      errors.push(
        d.optional
          ? `{${use.name}} is optional, so it is written {${use.name}?}.`
          : `{${use.name}} is required, so it is written without "?".`,
      );
    }
  }
  const used = new Set(uses.map((u) => u.name));
  for (const name of declared.keys()) {
    if (!used.has(name)) errors.push(`{${name}} is declared but never used.`);
  }
  return errors;
}

/**
 * The input tidied for saving: trimmed text, a reply without a subject, and
 * the Placeholders in order of first use (unknown order keeps declaration order).
 */
/** `{{name}}` (the way many tools write it) read as monday's `{name}`; `{{ Name? }}` too. */
export function singleBraces(text: string): string {
  return text.replace(
    /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,63})\s*(\?)?\s*\}\}/g,
    (_, name: string, optional?: string) => `{${name.toLowerCase()}${optional ?? ""}}`,
  );
}

export function tidyTemplate(input: TemplateInput): TemplateInput {
  const subject =
    input.kind === "starter" ? singleBraces(input.subject ?? "").trim() || null : null;
  const body = singleBraces(input.body.replace(/\r\n/g, "\n")).trim();
  const order = templateUses({ subject, body }).map((u) => u.name);
  const rank = (name: string) => {
    const i = order.indexOf(name);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const placeholders = [...input.placeholders]
    .map((p) => ({ ...p, hint: p.hint.trim() }))
    .sort((a, b) => rank(a.name) - rank(b.name));
  return {
    name: input.name.trim(),
    fitsWhen: input.fitsWhen.trim(),
    kind: input.kind,
    subject,
    body,
    placeholders,
  };
}

/**
 * Text with its Placeholders filled. A filled one becomes its value; an
 * unfilled optional one is removed with the space before it; an unfilled
 * required one stays as `{name}`, which still blocks Send.
 */
export function fillPlaceholders(
  text: string,
  values: Readonly<Record<string, string | null | undefined>>,
): string {
  return text.replace(
    /([ \t]?)\{([a-z][a-z0-9_]{0,63})(\?)?\}/g,
    (whole, space: string, name: string, optional: string | undefined) => {
      const value = values[name];
      if (value !== null && value !== undefined && value !== "") return `${space}${value}`;
      if (optional === "?") return "";
      return whole;
    },
  );
}

/** The required Placeholders a text still holds unfilled, by name. */
export function unfilledRequired(text: string): string[] {
  return placeholdersIn(text)
    .filter((u) => !u.optional)
    .map((u) => u.name);
}

/** A Placeholder's name as a chip reads it: "invoice number". */
export function placeholderLabel(name: string): string {
  return name.replaceAll("_", " ");
}
