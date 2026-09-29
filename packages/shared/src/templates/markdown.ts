// Templates as Markdown files, on request only (docs/spec/templates.md,
// "Files, on request only"): Export writes one file per Template with the
// name, fits-when, kind, subject and Placeholders as front matter and the
// body below it; Import reads the same format. Neither runs by itself and
// nothing watches the folder. The front matter is YAML whose values are JSON
// (strings quoted, each Placeholder a JSON object), so it reads back exactly.

import { templateErrors, tidyTemplate } from "./syntax.ts";
import { PLACEHOLDER_TYPES, type Placeholder, type TemplateInput } from "./types.ts";

export interface TemplateFile {
  /** The file name, "confirm-the-time.md". */
  name: string;
  content: string;
}

/** A file name for a Template: its name in lowercase words joined by dashes. */
export function templateFileName(name: string, taken: ReadonlySet<string> = new Set()): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "template";
  let file = `${base}.md`;
  for (let n = 2; taken.has(file); n++) file = `${base}-${n}.md`;
  return file;
}

/** One Template as a Markdown file. */
export function templateToMarkdown(t: TemplateInput): string {
  const lines = [
    "---",
    `name: ${JSON.stringify(t.name)}`,
    `fits_when: ${JSON.stringify(t.fitsWhen)}`,
    `kind: ${t.kind}`,
  ];
  if (t.kind === "starter" && t.subject) lines.push(`subject: ${JSON.stringify(t.subject)}`);
  if (t.placeholders.length === 0) lines.push("placeholders: []");
  else {
    lines.push("placeholders:");
    for (const p of t.placeholders) {
      lines.push(
        `  - ${JSON.stringify({ name: p.name, type: p.type, optional: p.optional, hint: p.hint })}`,
      );
    }
  }
  lines.push("---", "", t.body.trim(), "");
  return lines.join("\n");
}

/** Every Template as its file, names made unique. */
export function templatesToFiles(templates: readonly TemplateInput[]): TemplateFile[] {
  const taken = new Set<string>();
  return templates.map((t) => {
    const name = templateFileName(t.name, taken);
    taken.add(name);
    return { name, content: templateToMarkdown(t) };
  });
}

function scalar(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"')) {
    try {
      const parsed = JSON.parse(v) as unknown;
      if (typeof parsed === "string") return parsed;
    } catch {}
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1);
  return v;
}

function placeholderOf(raw: string): Placeholder {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    throw new Error(`a Placeholder line is not readable: ${raw.trim().slice(0, 80)}`);
  }
  const o = (value ?? {}) as Record<string, unknown>;
  const type = String(o.type ?? "text");
  if (!(PLACEHOLDER_TYPES as readonly string[]).includes(type)) {
    throw new Error(`the Placeholder ${String(o.name)} has an unknown type "${type}"`);
  }
  return {
    name: String(o.name ?? ""),
    type: type as Placeholder["type"],
    optional: o.optional === true,
    hint: String(o.hint ?? ""),
  };
}

/**
 * A Markdown file read back as a Template, tidied and validated; throws an
 * Error in plain words when the front matter is missing or the Template
 * would not save.
 */
export function templateFromMarkdown(content: string): TemplateInput {
  const text = content.replace(/\r\n/g, "\n").replace(/^﻿/, "");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("the file has no front matter between --- lines");
  const head = m[1] ?? "";
  const body = (m[2] ?? "").trim();
  const fields = new Map<string, string>();
  const placeholders: Placeholder[] = [];
  let inList = false;
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && inList) {
      placeholders.push(placeholderOf(item[1] ?? ""));
      continue;
    }
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`a front matter line is not readable: ${line.slice(0, 80)}`);
    const key = kv[1] ?? "";
    const value = kv[2] ?? "";
    inList = key === "placeholders" && value.trim() === "";
    if (key !== "placeholders") fields.set(key, scalar(value));
  }
  const kind = fields.get("kind") === "starter" ? "starter" : "reply";
  const input = tidyTemplate({
    name: fields.get("name") ?? "",
    fitsWhen: fields.get("fits_when") ?? "",
    kind,
    subject: kind === "starter" ? (fields.get("subject") ?? null) : null,
    body,
    placeholders,
  });
  const errors = templateErrors(input);
  if (errors.length > 0) throw new Error(errors.join(" "));
  return input;
}

export interface ImportedTemplates {
  templates: TemplateInput[];
  /** The files that were not read, each with why, in plain words. */
  errors: Array<{ file: string; message: string }>;
}

/** Reads every Markdown file; the others (and unreadable ones) are listed with the reason. */
export function templatesFromFiles(files: readonly TemplateFile[]): ImportedTemplates {
  const out: ImportedTemplates = { templates: [], errors: [] };
  for (const f of files) {
    if (!/\.(md|markdown)$/i.test(f.name)) continue;
    try {
      out.templates.push(templateFromMarkdown(f.content));
    } catch (error) {
      out.errors.push({
        file: f.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}
