// A strict allowlist HTML sanitizer for message bodies. Mail HTML is untrusted
// (ADR 0002 says as much about the shell; the webview is no different), so the
// reader only ever sees what this file re-serialises: a fixed set of tags, a
// fixed set of attributes per tag, a fixed set of CSS properties, http, https
// and mailto links, and images that are either inline parts (cid:, resolved
// to /attachments/:id) or blocked until the user asks. Everything else is
// dropped, including the contents of script, style, iframe and friends.
//
// The tokenizer is htmlparser2; nothing from the input reaches the output as
// bytes, every text node and attribute value is escaped again on the way out,
// so a parse ambiguity in the input cannot become one in the output.
//
// Quoted history is marked, not removed: known quote containers (Gmail,
// Apple Mail, Thunderbird, Yahoo, Outlook's reply separator) come out wrapped
// in <div class="quoted"> so the reader can fold them.

import { Parser } from "htmlparser2";

export interface SanitizeOptions {
  /** Content-ID (without angle brackets) to the URL that serves the part. */
  cidUrl?: (contentId: string) => string | null;
  /** Load http(s) images. Off by default: the src moves to data-src and the reader offers to show them. */
  allowRemoteImages?: boolean;
  /** Extra class names (beyond the built-in list) that mark a quoted-history container. */
  quoteClasses?: readonly string[];
}

export interface SanitizedHtml {
  html: string;
  /** True when a quoted-history container was found and wrapped. */
  quoted: boolean;
  /** Remote images left unloaded. */
  blockedImages: number;
  /** Tags dropped, for diagnostics. */
  dropped: number;
}

/** Tags kept with their (allowed) children. */
const ALLOWED = new Set([
  "a",
  "abbr",
  "b",
  "big",
  "blockquote",
  "br",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "font",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "tt",
  "u",
  "ul",
  "var",
  "wbr",
]);

/** Tags whose whole subtree is dropped. */
const DROPPED = new Set([
  "applet",
  "audio",
  "base",
  "button",
  "canvas",
  "dialog",
  "embed",
  "form",
  "frame",
  "frameset",
  "head",
  "iframe",
  "input",
  "link",
  "math",
  "meta",
  "noscript",
  "object",
  "option",
  "picture",
  "script",
  "select",
  "slot",
  "source",
  "style",
  "svg",
  "template",
  "textarea",
  "title",
  "track",
  "video",
  "xml",
]);

const VOID = new Set(["br", "hr", "img", "wbr", "col"]);

/** Tags renamed on the way out. */
const RENAMED: Record<string, string> = {
  font: "span",
  center: "div",
  strike: "s",
  big: "span",
  tt: "code",
};

const GLOBAL_ATTRS = new Set(["title", "dir", "lang", "style"]);
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href"]),
  img: new Set(["src", "alt", "width", "height"]),
  td: new Set(["colspan", "rowspan", "align", "valign", "width", "height"]),
  th: new Set(["colspan", "rowspan", "align", "valign", "width", "height"]),
  table: new Set(["width", "cellpadding", "cellspacing", "align"]),
  col: new Set(["span", "width"]),
  colgroup: new Set(["span"]),
  ol: new Set(["start", "type"]),
  ul: new Set(["type"]),
  div: new Set(["align"]),
  p: new Set(["align"]),
  q: new Set(["cite"]),
  blockquote: new Set(["type"]),
};

const CSS_PROPERTIES = new Set([
  "background-color",
  "border",
  "border-bottom",
  "border-collapse",
  "border-color",
  "border-left",
  "border-radius",
  "border-right",
  "border-spacing",
  "border-style",
  "border-top",
  "border-width",
  "color",
  "display",
  "font",
  "font-family",
  "font-size",
  "font-style",
  "font-variant",
  "font-weight",
  "height",
  "letter-spacing",
  "line-height",
  "list-style",
  "list-style-type",
  "margin",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-top",
  "max-width",
  "min-width",
  "padding",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "text-align",
  "text-decoration",
  "text-indent",
  "text-transform",
  "vertical-align",
  "white-space",
  "width",
  "word-break",
  "word-wrap",
]);

/** Class names mail clients put on the container that holds the quoted history. */
const QUOTE_CLASSES = [
  "quoted",
  "gmail_quote",
  "gmail_quote_container",
  "yahoo_quoted",
  "moz-cite-prefix",
  "protonmail_quote",
  "zmail_extra",
  "quoted-text",
];

/** Element ids that mark where Outlook's reply separator begins; everything after it in the parent is quoted. */
const OUTLOOK_SEPARATORS = new Set(["divrplyfwdmsg", "appendonsend"]);

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Drops C0 controls and DEL, which browsers ignore inside a scheme ("java\tscript:"). */
function stripControls(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

/** A safe href: http, https or mailto with no control characters; null otherwise. */
export function safeHref(value: string): string | null {
  const trimmed = stripControls(value.trim());
  if (trimmed.length === 0 || trimmed.length > 4096) return null;
  // Decode entity-ish and percent tricks only enough to read the scheme.
  const lower = trimmed.toLowerCase();
  if (/^https?:\/\//.test(lower)) return trimmed;
  if (/^mailto:[^\s]+/.test(lower)) return trimmed;
  return null;
}

/** A safe image source: a cid: resolved through the map, a small data: image, or a blocked remote. */
function imageSource(
  value: string,
  options: SanitizeOptions,
): { src: string } | { blocked: string } | null {
  const trimmed = stripControls(value.trim()).replace(/\s/g, "");
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("cid:")) {
    const id = trimmed.slice(4).replace(/^<|>$/g, "");
    const url = options.cidUrl?.(id) ?? null;
    return url ? { src: url } : null;
  }
  if (/^data:image\/(png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=]+$/i.test(trimmed)) {
    return trimmed.length <= 2_000_000 ? { src: trimmed } : null;
  }
  if (/^https?:\/\//.test(lower)) {
    return options.allowRemoteImages ? { src: trimmed } : { blocked: trimmed };
  }
  return null;
}

/** Keeps the declarations whose property is on the list and whose value carries no escape hatch. */
export function sanitizeStyle(style: string): string {
  const out: string[] = [];
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (!CSS_PROPERTIES.has(property)) continue;
    if (value.length === 0 || value.length > 200) continue;
    const lower = value.toLowerCase().replace(/\s+/g, "");
    if (/url\(|expression\(|javascript|@import|\\|\/\*|<|>|&#|behavior|-moz-binding/.test(lower)) {
      continue;
    }
    if (!/^[\w\s#%.,()'"!/:-]*$/.test(value)) continue;
    out.push(`${property}: ${value.replace(/"/g, "'")}`);
  }
  return out.join("; ");
}

function isQuoteContainer(name: string, attrs: Record<string, string>, extra: readonly string[]) {
  const classes = (attrs.class ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (classes.some((c) => QUOTE_CLASSES.includes(c) || extra.includes(c))) return true;
  if (name === "blockquote" && (attrs.type ?? "").toLowerCase() === "cite") return true;
  return false;
}

function isOutlookSeparator(attrs: Record<string, string>): boolean {
  const id = (attrs.id ?? "").toLowerCase();
  return OUTLOOK_SEPARATORS.has(id);
}

interface Frame {
  /** The output tag name, or null when the tag itself is stripped (children kept). */
  out: string | null;
  /** True while inside a dropped subtree; children are skipped. */
  dropping: boolean;
  /** This frame opened a <div class="quoted"> that closes with it. */
  quoteWrapper: boolean;
  /** A quoted wrapper opened by an Outlook separator among this frame's children, closed when this frame closes. */
  trailingQuote: boolean;
}

export function sanitizeHtml(input: string, options: SanitizeOptions = {}): SanitizedHtml {
  const extraQuoteClasses = options.quoteClasses ?? [];
  const parts: string[] = [];
  const stack: Frame[] = [];
  let dropDepth = 0;
  let quoted = false;
  let blockedImages = 0;
  let dropped = 0;

  const emit = (s: string) => {
    if (dropDepth === 0) parts.push(s);
  };

  const attributesFor = (name: string, attrs: Record<string, string>): string => {
    const allowed = TAG_ATTRS[name];
    const out: string[] = [];
    for (const [rawKey, rawValue] of Object.entries(attrs)) {
      const key = rawKey.toLowerCase();
      const value = rawValue ?? "";
      if (!(GLOBAL_ATTRS.has(key) || allowed?.has(key))) continue;
      if (key === "style") {
        const style = sanitizeStyle(value);
        if (style) out.push(`style="${escapeHtml(style)}"`);
        continue;
      }
      if (key === "href") {
        const href = safeHref(value);
        if (href)
          out.push(`href="${escapeHtml(href)}"`, 'rel="noopener noreferrer"', 'target="_blank"');
        continue;
      }
      if (key === "src") {
        const source = imageSource(value, options);
        if (!source) continue;
        if ("src" in source) out.push(`src="${escapeHtml(source.src)}"`);
        else {
          blockedImages += 1;
          out.push(`data-src="${escapeHtml(source.blocked)}"`, 'data-blocked=""');
        }
        continue;
      }
      if (key === "cite") {
        const href = safeHref(value);
        if (href) out.push(`cite="${escapeHtml(href)}"`);
        continue;
      }
      if (
        [
          "width",
          "height",
          "colspan",
          "rowspan",
          "span",
          "start",
          "cellpadding",
          "cellspacing",
        ].includes(key)
      ) {
        if (/^\d{1,5}(%|px)?$/.test(value.trim())) out.push(`${key}="${escapeHtml(value.trim())}"`);
        continue;
      }
      if (["align", "valign", "type", "dir"].includes(key)) {
        if (/^[a-z-]{1,20}$/i.test(value.trim()))
          out.push(`${key}="${escapeHtml(value.trim().toLowerCase())}"`);
        continue;
      }
      if (value.length <= 1024) out.push(`${key}="${escapeHtml(value)}"`);
    }
    return out.length ? ` ${out.join(" ")}` : "";
  };

  const parser = new Parser(
    {
      onopentag(rawName, attrs) {
        const name = rawName.toLowerCase();
        if (dropDepth > 0 || DROPPED.has(name)) {
          if (DROPPED.has(name) && dropDepth === 0) dropped += 1;
          dropDepth += 1;
          stack.push({ out: null, dropping: true, quoteWrapper: false, trailingQuote: false });
          return;
        }
        const frame: Frame = {
          out: null,
          dropping: false,
          quoteWrapper: false,
          trailingQuote: false,
        };
        if (isOutlookSeparator(attrs)) {
          const parent = stack[stack.length - 1];
          if (parent && !parent.trailingQuote) {
            parent.trailingQuote = true;
            quoted = true;
            emit('<div class="quoted">');
          }
        }
        if (isQuoteContainer(name, attrs, extraQuoteClasses)) {
          frame.quoteWrapper = true;
          quoted = true;
          emit('<div class="quoted">');
        }
        if (ALLOWED.has(name)) {
          const out = RENAMED[name] ?? name;
          frame.out = VOID.has(name) ? null : out;
          const rest = attributesFor(name, attrs);
          if (name === "img") {
            emit(`<img${rest}>`);
          } else if (VOID.has(name)) {
            emit(`<${out}${rest}>`);
          } else {
            emit(`<${out}${rest}>`);
          }
        } else {
          dropped += name === "html" || name === "body" ? 0 : 1;
        }
        stack.push(frame);
      },
      ontext(text) {
        if (dropDepth > 0) return;
        emit(escapeHtml(text));
      },
      onclosetag() {
        const frame = stack.pop();
        if (!frame) return;
        if (frame.dropping) {
          dropDepth = Math.max(0, dropDepth - 1);
          return;
        }
        if (frame.out) emit(`</${frame.out}>`);
        if (frame.trailingQuote) emit("</div>");
        if (frame.quoteWrapper) emit("</div>");
      },
    },
    {
      decodeEntities: true,
      lowerCaseTags: true,
      lowerCaseAttributeNames: true,
      recognizeSelfClosing: true,
    },
  );
  parser.write(input);
  parser.end();
  // Anything left open (the parser closes implied tags at end, but be safe).
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame || frame.dropping) continue;
    if (frame.out) parts.push(`</${frame.out}>`);
    if (frame.trailingQuote) parts.push("</div>");
    if (frame.quoteWrapper) parts.push("</div>");
  }
  return { html: parts.join("").trim(), quoted, blockedImages, dropped };
}
