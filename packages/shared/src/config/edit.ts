// A comment-preserving single-key edit of monday.toml (ADR 0001).
//
// Given the file text, a dotted key and a value, return new text that changes
// only that key. If the key exists its value is replaced in place, keeping the
// key's spelling, spacing and trailing comment. If it is absent the key is
// added at the end of the closest enclosing table, or a new table is appended.
// Every other byte, including comments and ordering, is kept.

import { parse as parseToml } from "smol-toml";
import {
  indexLines,
  isPrefix,
  type KeyEntry,
  type LineIndex,
  samePath,
  splitKey,
} from "./lines.ts";

export type TomlValue =
  | string
  | number
  | boolean
  | TomlValue[]
  | { [key: string]: TomlValue | undefined };

/** Serialize one value as TOML. Objects become inline tables. */
export function formatValue(value: TomlValue): string {
  if (typeof value === "string") return formatString(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("TOML cannot hold a non-finite number");
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(formatValue).join(", ")}]`;
  if (typeof value === "object" && value !== null) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      parts.push(`${formatKey(k)} = ${formatValue(v)}`);
    }
    return parts.length === 0 ? "{}" : `{ ${parts.join(", ")} }`;
  }
  throw new Error(`Cannot write ${String(value)} to TOML`);
}

function formatString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

function formatKey(segment: string): string {
  return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : formatString(segment);
}

function formatPath(path: readonly string[]): string {
  return path.map(formatKey).join(".");
}

/** Replace a key's value in place. Multi-line values collapse to one line. */
function replaceValue(index: LineIndex, entry: KeyEntry, rendered: string): string {
  const lines = [...index.lines];
  const first = lines[entry.line] as string;
  const last = lines[entry.endLine] as string;
  const merged = first.slice(0, entry.valueStart) + rendered + last.slice(entry.valueEnd);
  lines.splice(entry.line, entry.endLine - entry.line + 1, merged);
  return lines.join("\n");
}

/** The last line that belongs to a table's body (before trailing blank lines and the next header). */
function tableBodyEnd(index: LineIndex, tableIndex: number): number {
  const start = tableIndex < 0 ? -1 : (index.tables[tableIndex] as { line: number }).line;
  const next = index.tables.find((t) => t.line > start);
  const limit = next ? next.line : index.lines.length;
  let end = limit - 1;
  while (end > start && (index.lines[end] as string).trim() === "") end--;
  return end;
}

function insertLines(lines: readonly string[], at: number, inserted: readonly string[]): string {
  const out = [...lines];
  out.splice(at, 0, ...inserted);
  return out.join("\n");
}

function parseInlineValue(index: LineIndex, entry: KeyEntry): unknown {
  const first = index.lines[entry.line] as string;
  if (entry.line === entry.endLine) {
    return (parseToml(`v = ${first.slice(entry.valueStart, entry.valueEnd)}`) as { v: unknown }).v;
  }
  const middle = index.lines.slice(entry.line + 1, entry.endLine);
  const last = (index.lines[entry.endLine] as string).slice(0, entry.valueEnd);
  const snippet = [first.slice(entry.valueStart), ...middle, last].join("\n");
  return (parseToml(`v = ${snippet}`) as { v: unknown }).v;
}

function setNested(
  table: Record<string, TomlValue>,
  path: readonly string[],
  value: TomlValue,
): Record<string, TomlValue> {
  const [head, ...rest] = path;
  if (head === undefined) return table;
  const out: Record<string, TomlValue> = { ...table };
  if (rest.length === 0) {
    out[head] = value;
    return out;
  }
  const child = out[head];
  const childTable =
    typeof child === "object" && child !== null && !Array.isArray(child)
      ? (child as Record<string, TomlValue>)
      : {};
  out[head] = setNested(childTable, rest, value);
  return out;
}

export function editConfigKey(text: string, key: string, value: TomlValue): string {
  const path = splitKey(key);
  if (path.length === 0 || path.some((s) => s === "")) throw new Error(`Invalid key "${key}"`);
  const rendered = formatValue(value);
  if (text.trim() === "" && path.length === 1) return `${formatPath(path)} = ${rendered}\n`;
  const index = indexLines(text);

  const existing = index.keys.find((k) => samePath(k.path, path));
  if (existing) return replaceValue(index, existing, rendered);

  // The key lives inside an inline table: rewrite that table with the field changed.
  const holder = index.keys.find((k) => k.path.length < path.length && isPrefix(k.path, path));
  if (holder) {
    const current = parseInlineValue(index, holder);
    if (typeof current === "object" && current !== null && !Array.isArray(current)) {
      const merged = setNested(
        current as Record<string, TomlValue>,
        path.slice(holder.path.length),
        value,
      );
      return replaceValue(index, holder, formatValue(merged));
    }
    throw new Error(`Cannot set "${key}": "${holder.path.join(".")}" is not a table`);
  }

  // The longest table header that is a proper prefix of the key.
  let best = -1;
  for (let i = 0; i < index.tables.length; i++) {
    const table = index.tables[i] as { path: string[]; array: boolean };
    if (table.array) continue;
    if (table.path.length < path.length && isPrefix(table.path, path)) {
      const current = best < 0 ? -1 : (index.tables[best] as { path: string[] }).path.length;
      if (table.path.length > current) best = i;
    }
  }

  if (best >= 0) {
    const table = index.tables[best] as { path: string[] };
    const leaf = path.slice(table.path.length);
    const end = tableBodyEnd(index, best);
    return insertLines(index.lines, end + 1, [`${formatPath(leaf)} = ${rendered}`]);
  }

  if (path.length === 1) {
    // A root key: after the leading comment block and any root keys, before the first header.
    const rootEnd = tableBodyEnd(index, -1);
    if (rootEnd >= 0) {
      const lastRootKey = index.keys.filter((k) => k.table < 0).at(-1);
      const at = lastRootKey ? lastRootKey.endLine + 1 : rootEnd + 1;
      const needsGap = !lastRootKey && (index.lines[rootEnd] as string).trim() !== "";
      return insertLines(
        index.lines,
        at,
        needsGap
          ? ["", `${formatPath(path)} = ${rendered}`]
          : [`${formatPath(path)} = ${rendered}`],
      );
    }
    return insertLines(index.lines, 0, [`${formatPath(path)} = ${rendered}`, ""]);
  }

  // No enclosing table: append a new one at the end of the file.
  const parent = path.slice(0, -1);
  const leaf = path.slice(-1);
  const lines = [...index.lines];
  while (lines.length > 0 && (lines.at(-1) as string).trim() === "") lines.pop();
  const block = [`[${formatPath(parent)}]`, `${formatPath(leaf)} = ${rendered}`];
  const inserted = lines.length > 0 ? ["", ...block] : block;
  const trailingNewline = text.endsWith("\n") || text === "";
  return [...lines, ...inserted].join("\n") + (trailingNewline ? "\n" : "");
}
