// A light line index over a TOML document: which table each line belongs to,
// where each key's value starts and ends, and where each table header sits.
// It is not a parser (smol-toml parses); it only locates things so that parse
// warnings can carry line numbers and edits can change one value in place
// without touching any other byte.

export interface TableEntry {
  kind: "table";
  path: string[];
  /** Zero-based line of the header. */
  line: number;
  /** True for a [[array of tables]] header. */
  array: boolean;
}

export interface KeyEntry {
  kind: "key";
  /** Full dotted path: the enclosing table's path plus the key's own segments. */
  path: string[];
  /** Zero-based line where the key starts. */
  line: number;
  /** Zero-based line where the value ends (same as `line` for one-line values). */
  endLine: number;
  /** Column on `line` where the value starts. */
  valueStart: number;
  /** Column on `endLine` just past the value's last character. */
  valueEnd: number;
  /** Index into `tables` of the enclosing table, or -1 for the root table. */
  table: number;
}

export interface LineIndex {
  lines: string[];
  tables: TableEntry[];
  keys: KeyEntry[];
}

export function joinPath(path: readonly string[]): string {
  return path.join(".");
}

/** Split a dotted key. Quoted segments keep their dots. */
export function splitKey(raw: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    if (quote) {
      if (ch === "\\" && quote === '"') {
        const next = raw[i + 1];
        if (next !== undefined) {
          current += next;
          i++;
        }
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ".") {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current.trim());
  return out;
}

interface ScanState {
  /** Bracket depth of [ and { outside strings. */
  depth: number;
  /** Open multi-line string delimiter, if any. */
  multi: '"""' | "'''" | null;
  /** Last position that belongs to the value. */
  lastLine: number;
  lastCol: number;
}

/**
 * Scan one line of a value starting at `from`. Returns whether the value is
 * complete at the end of this line. Updates the last value position.
 */
function scanValueLine(line: string, lineNo: number, from: number, state: ScanState): boolean {
  let i = from;
  let quote: '"' | "'" | null = null;
  const mark = (col: number) => {
    state.lastLine = lineNo;
    state.lastCol = col + 1;
  };
  while (i < line.length) {
    const ch = line[i] as string;
    if (state.multi) {
      if (line.startsWith(state.multi, i)) {
        // A closing delimiter may be followed by up to two extra quotes.
        let end = i + 3;
        while (end < line.length && line[end] === state.multi[0] && end < i + 5) end++;
        mark(end - 1);
        state.multi = null;
        i = end;
        continue;
      }
      if (state.multi === '"""' && ch === "\\") {
        mark(i + 1);
        i += 2;
        continue;
      }
      mark(i);
      i++;
      continue;
    }
    if (quote) {
      if (ch === "\\" && quote === '"') {
        mark(i + 1);
        i += 2;
        continue;
      }
      mark(i);
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      state.multi = line.slice(i, i + 3) as '"""' | "'''";
      mark(i + 2);
      i += 3;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      mark(i);
      i++;
      continue;
    }
    if (ch === "#") break;
    if (ch === "[" || ch === "{") state.depth++;
    if (ch === "]" || ch === "}") state.depth = Math.max(0, state.depth - 1);
    if (!/\s/.test(ch)) mark(i);
    i++;
  }
  return state.depth === 0 && state.multi === null;
}

/** Find the `=` of a key line, skipping quoted key segments. Returns -1 if none. */
function findEquals(line: string): number {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "=") return i;
    else if (ch === "#") return -1;
  }
  return -1;
}

export function indexLines(text: string): LineIndex {
  const lines = text.split("\n");
  const tables: TableEntry[] = [];
  const keys: KeyEntry[] = [];
  let tablePath: string[] = [];
  let tableIndex = -1;
  let pending: { entry: KeyEntry; state: ScanState } | null = null;

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo] as string;
    if (pending) {
      const done = scanValueLine(line, lineNo, 0, pending.state);
      if (done) {
        pending.entry.endLine = pending.state.lastLine;
        pending.entry.valueEnd = pending.state.lastCol;
        pending = null;
      }
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      const array = trimmed.startsWith("[[");
      const close = array ? trimmed.indexOf("]]") : trimmed.indexOf("]");
      if (close < 0) continue;
      const inner = trimmed.slice(array ? 2 : 1, close);
      tablePath = splitKey(inner);
      tables.push({ kind: "table", path: tablePath, line: lineNo, array });
      tableIndex = tables.length - 1;
      continue;
    }
    const eq = findEquals(line);
    if (eq < 0) continue;
    const segments = splitKey(line.slice(0, eq));
    let valueStart = eq + 1;
    while (valueStart < line.length && /\s/.test(line[valueStart] as string)) valueStart++;
    const state: ScanState = { depth: 0, multi: null, lastLine: lineNo, lastCol: valueStart };
    const entry: KeyEntry = {
      kind: "key",
      path: [...tablePath, ...segments],
      line: lineNo,
      endLine: lineNo,
      valueStart,
      valueEnd: valueStart,
      table: tableIndex,
    };
    keys.push(entry);
    const done = scanValueLine(line, lineNo, valueStart, state);
    if (done) {
      entry.endLine = state.lastLine;
      entry.valueEnd = state.lastCol;
    } else {
      pending = { entry, state };
    }
  }
  if (pending) {
    pending.entry.endLine = pending.state.lastLine;
    pending.entry.valueEnd = pending.state.lastCol;
  }
  return { lines, tables, keys };
}

export function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((seg, i) => seg === b[i]);
}

export function isPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((seg, i) => seg === path[i]);
}

/** The one-based line a dotted path was set on, or null when it was not found. */
export function lineOf(index: LineIndex, path: readonly string[]): number | null {
  const key = index.keys.find((k) => samePath(k.path, path));
  if (key) return key.line + 1;
  const table = index.tables.find((t) => samePath(t.path, path));
  if (table) return table.line + 1;
  // A key inside an inline table: fall back to the nearest ancestor that was written out.
  for (let n = path.length - 1; n > 0; n--) {
    const ancestor = path.slice(0, n);
    const k = index.keys.find((e) => samePath(e.path, ancestor));
    if (k) return k.line + 1;
    const t = index.tables.find((e) => samePath(e.path, ancestor));
    if (t) return t.line + 1;
  }
  return null;
}
