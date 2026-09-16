// text/plain to safe HTML for the reader: paragraphs on blank lines, line
// breaks inside them, links made clickable, and the quoted history found and
// wrapped in <div class="quoted"> so the reader can fold it. Quoted history is
// any of: a run of ">" lines (nested by depth into blockquotes), an
// "On <date>, <name> wrote:" line and everything after it, an Outlook
// "-----Original Message-----" or "From: ... Sent: ... To: ... Subject:"
// header block and everything after it, or a "________" rule before one.
// Everything that is not a link is escaped.

import { escapeHtml } from "./sanitize.ts";

export interface TextHtml {
  html: string;
  quoted: boolean;
}

const URL = /\b((?:https?:\/\/|www\.)[^\s<>"'`]+)/gi;
const EMAIL = /\b([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\b/gi;
const TRAILING = /[.,;:!?)\]}'"]+$/;

/** Escapes a line and turns URLs and addresses into links. */
export function linkify(line: string): string {
  let out = "";
  let last = 0;
  const matches: Array<{ start: number; end: number; href: string; text: string }> = [];
  for (const m of line.matchAll(URL)) {
    let text = m[1] ?? "";
    let end = (m.index ?? 0) + text.length;
    // Trailing punctuation belongs to the sentence, except a closing paren
    // that balances one inside the URL (wikipedia style).
    const opens = (text.match(/\(/g) ?? []).length;
    let closes = (text.match(/\)/g) ?? []).length;
    while (text.length > 0 && TRAILING.test(text[text.length - 1] ?? "")) {
      const last = text[text.length - 1];
      if (last === ")") {
        if (closes <= opens) break;
        closes -= 1;
      }
      text = text.slice(0, -1);
      end -= 1;
    }
    const href = /^www\./i.test(text) ? `http://${text}` : text;
    matches.push({ start: m.index ?? 0, end, href, text });
  }
  for (const m of line.matchAll(EMAIL)) {
    const start = m.index ?? 0;
    const end = start + (m[1]?.length ?? 0);
    if (matches.some((u) => start < u.end && end > u.start)) continue;
    matches.push({ start, end, href: `mailto:${m[1]}`, text: m[1] ?? "" });
  }
  matches.sort((a, b) => a.start - b.start);
  for (const m of matches) {
    if (m.start < last) continue;
    out += escapeHtml(line.slice(last, m.start));
    out += `<a href="${escapeHtml(m.href)}" rel="noopener noreferrer" target="_blank">${escapeHtml(m.text)}</a>`;
    last = m.end;
  }
  out += escapeHtml(line.slice(last));
  return out;
}

const WROTE_LINE =
  /^\s*(?:on|le|am|el|il)\b.{4,200}?\b(?:wrote|écrit|schrieb|escribió|ha scritto)\s*:\s*$/i;
const WROTE_START = /^\s*(?:on|le|am)\b.{4,200}$/i;
const WROTE_END = /\b(?:wrote|écrit|schrieb|escribió|ha scritto)\s*:\s*$/i;
const ORIGINAL =
  /^\s*-{2,}\s*(?:original message|forwarded message|ursprüngliche nachricht|message d'origine)\s*-{2,}\s*$/i;
const RULE = /^\s*_{5,}\s*$/;
const FROM = /^\s*(?:from|de|von)\s*:\s*\S/i;
const HEADER_FOLLOW = /^\s*(?:sent|date|to|cc|subject|envoyé|à|objet|gesendet|an|betreff)\s*:/i;

/**
 * The index of the first line that starts the quoted history, or -1. A ">"
 * run is not a start on its own here; those are folded per run below.
 */
export function quoteStart(lines: readonly string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (WROTE_LINE.test(line)) return i;
    if (WROTE_START.test(line) && WROTE_END.test(lines[i + 1] ?? "")) return i;
    if (ORIGINAL.test(line)) return i;
    if (RULE.test(line) && FROM.test(lines[i + 1] ?? "")) return i;
    if (FROM.test(line)) {
      let headers = 0;
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
        if (HEADER_FOLLOW.test(lines[j] ?? "")) headers += 1;
      }
      if (headers >= 2) return i;
    }
  }
  return -1;
}

/** The ">" depth of a line and the text after the markers. */
function quoteDepth(line: string): { depth: number; text: string } {
  let depth = 0;
  let rest = line;
  for (;;) {
    const m = rest.match(/^\s{0,3}>\s?/);
    if (!m) break;
    depth += 1;
    rest = rest.slice(m[0].length);
  }
  return { depth, text: rest };
}

/** Lines to paragraphs: blank lines separate, single newlines become <br>. */
function paragraphsHtml(lines: readonly string[]): string {
  const out: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length === 0) return;
    out.push(`<p>${current.map(linkify).join("<br>")}</p>`);
    current = [];
  };
  for (const line of lines) {
    if (line.trim() === "") flush();
    else current.push(line.replace(/\s+$/, ""));
  }
  flush();
  return out.join("");
}

/** Renders lines that may carry ">" markers; each depth change opens or closes a blockquote. */
function blockHtml(lines: readonly string[]): string {
  const out: string[] = [];
  let depth = 0;
  let run: string[] = [];
  const flush = () => {
    if (run.length > 0) out.push(paragraphsHtml(run));
    run = [];
  };
  for (const raw of lines) {
    const { depth: d, text } = quoteDepth(raw);
    if (d !== depth) {
      flush();
      while (depth < d) {
        out.push("<blockquote>");
        depth += 1;
      }
      while (depth > d) {
        out.push("</blockquote>");
        depth -= 1;
      }
    }
    run.push(text);
  }
  flush();
  while (depth > 0) {
    out.push("</blockquote>");
    depth -= 1;
  }
  return out.join("");
}

export function textToHtml(text: string): TextHtml {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const start = quoteStart(lines);
  const own = start >= 0 ? lines.slice(0, start) : lines;
  const history = start >= 0 ? lines.slice(start) : [];
  // A trailing run of ">" lines with no "wrote:" line is history too.
  let firstQuote = own.length;
  for (let i = own.length - 1; i >= 0; i--) {
    const line = own[i] ?? "";
    if (quoteDepth(line).depth > 0 || line.trim() === "") firstQuote = i;
    else break;
  }
  const hasTrailingQuote = own.slice(firstQuote).some((l) => quoteDepth(l).depth > 0);
  const head = hasTrailingQuote ? own.slice(0, firstQuote) : own;
  const tail = hasTrailingQuote ? [...own.slice(firstQuote), ...history] : history;
  let html = blockHtml(head);
  const quoted = tail.some((l) => l.trim() !== "");
  if (quoted) html += `<div class="quoted">${blockHtml(tail)}</div>`;
  return { html, quoted };
}
