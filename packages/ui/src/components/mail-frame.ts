// The document a Message's HTML body renders in: a sandboxed iframe's srcdoc
// (no scripts, same origin so the reader can size it and catch its links).
// The body cannot inherit the app's styles or break them, and its own
// <style> block (scoped by the Server to .monday-mail) stays inside it.
//
// Colours: a Message that sets its own (any background, bgcolor, or a dark
// text colour that would vanish on a dark theme) is laid on paper, white with
// dark text, whatever the app's theme, because inverting a designed message
// breaks it. A plain one (a reply with at most a grey signature) takes the
// app's text colours, font and size, so it reads like the rest of the reader.
//
// Remote images: the Server set them aside (data-src, data-srcset,
// data-background, data-blocked-style, a <style media="not all">), and the
// document's Content-Security-Policy refuses http(s) images besides; showing
// images rebuilds the document with a policy that allows them and puts each
// one back. Inline parts (src="/attachments/:id") are moved to
// data-attachment before the document parses, so nothing fetches them from
// the app's origin, and the reader resolves them with the device token.

/** The element the body renders into; the Server scopes a Message's <style> block to it. */
export const MAIL_SCOPE = "monday-mail";

/** The marks the Server puts on quoted history and on remote images left unloaded. */
export const QUOTED_MARK = 'class="quoted"';
export const BLOCKED_MARK = "data-blocked";

const ATTACHMENT_SRC = /(<img\b[^>]*?\s)src="\/attachments\/([^"/?#]+)"/g;

const DARK_NAMES = new Set([
  "black",
  "navy",
  "darkblue",
  "midnightblue",
  "maroon",
  "darkred",
  "purple",
  "indigo",
  "darkgreen",
  "green",
  "teal",
  "brown",
  "darkslategray",
  "darkslategrey",
  "dimgray",
  "dimgrey",
  "windowtext",
]);

/** Relative luminance of a CSS colour between 0 and 1, or null when it cannot be read. */
export function luminance(color: string): number | null {
  const c = color.trim().toLowerCase();
  let rgb: number[] | null = null;
  const fn = c.match(/^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/);
  if (fn) rgb = [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  const hex = c.match(/^#([0-9a-f]{3,8})$/)?.[1];
  if (!rgb && hex) {
    const full = hex.length <= 4 ? [...hex.slice(0, 3)].map((h) => h + h).join("") : hex;
    rgb = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
  }
  if (!rgb) return DARK_NAMES.has(c) ? 0 : null;
  const [r = 0, g = 0, b = 0] = rgb;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * True when the Message sets a background (bgcolor, background, a background
 * colour or image) or a dark text colour: it is designed for a light page.
 */
export function ownsColors(html: string): boolean {
  if (/\s(?:bgcolor|background)="|[\s;"{]background(?:-color|-image)?\s*:/i.test(html)) {
    return true;
  }
  const colors = [
    ...html.matchAll(/[\s;"{]color\s*:\s*([^;"}!]+)/gi),
    ...html.matchAll(/\scolor="([^"]+)"/gi),
  ];
  return colors.some((m) => {
    const l = luminance(m[1] ?? "");
    return l !== null && l < 0.4;
  });
}

/** The app's look at render time, from the root's tokens, so the body never paints in the wrong colours. */
export function appLook(): Record<string, string> {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return {};
  const style = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  const pairs: Array<[string, string]> = [
    ["--mail-fg", "--fg"],
    ["--mail-muted", "--fg-muted"],
    ["--mail-rule", "--border"],
    ["--mail-link", "--accent"],
    ["--mail-mono", "--font-mono"],
    ["--mail-font", "--font-sans"],
    ["--mail-size", "--fs-lg"],
  ];
  for (const [to, from] of pairs) {
    const value = style.getPropertyValue(from).trim();
    // Only plain values: they go into a style attribute.
    if (value && /^[\w\s#%.,()'"-]+$/.test(value)) out[to] = value.replace(/"/g, "'");
  }
  return out;
}

const BASE_CSS = `
html { overflow-x: auto; overflow-y: hidden; }
body { margin: 0; background: transparent; }
.${MAIL_SCOPE} {
  display: flow-root;
  color: var(--mail-fg, #18181b);
  font-family: var(--mail-font, system-ui, sans-serif);
  font-size: var(--mail-size, 15px);
  line-height: var(--mail-line, 1.65);
  overflow-wrap: break-word;
}
.${MAIL_SCOPE}.paper {
  --mail-fg: #1f1f1f;
  --mail-muted: #5f6368;
  --mail-rule: #dadce0;
  --mail-link: #1a55d6;
  color-scheme: light;
  background: #ffffff;
  line-height: normal;
}
html[data-theme="dark"] .${MAIL_SCOPE}.paper { padding: 16px; border-radius: 8px; }
:where(.${MAIL_SCOPE}:not(.paper)) :where(p) { margin: 0 0 14px; }
:where(.${MAIL_SCOPE}:not(.paper)) :where(p:last-child) { margin-bottom: 0; }
:where(.${MAIL_SCOPE}) :where(a) { color: var(--mail-link, #3d63dd); text-underline-offset: 2px; }
:where(.${MAIL_SCOPE}) :where(img) { max-width: 100%; }
:where(.${MAIL_SCOPE}) :where(img:not([height])) { height: auto; }
:where(.${MAIL_SCOPE}) :where(blockquote) {
  margin: 8px 0;
  padding-left: 12px;
  border-left: 2px solid var(--mail-rule, #e4e4e7);
  color: var(--mail-muted, #6b6b76);
}
:where(.${MAIL_SCOPE}) :where(pre, code) { font-family: var(--mail-mono, ui-monospace, monospace); font-size: 0.9em; }
:where(.${MAIL_SCOPE}) :where(pre) { white-space: pre-wrap; }
:where(.${MAIL_SCOPE}) :where(.quoted) {
  margin-top: 14px;
  padding-left: 12px;
  border-left: 2px solid var(--mail-rule, #e4e4e7);
  color: var(--mail-muted, #6b6b76);
}
html[data-quoted="collapsed"] .quoted { display: none !important; }
`;

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** The whole srcdoc for one body: policy, base styles, the Server's HTML inside the scope element. */
export function mailDocument(
  html: string,
  options: {
    images: boolean;
    scheme?: "light" | "dark";
    /** The app's look as --mail-* custom properties (appLook), set before the first paint. */
    look?: Record<string, string>;
  },
): string {
  const scheme = options.scheme ?? "light";
  const look = Object.entries(options.look ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .concat(`color-scheme: ${scheme}`)
    .join("; ");
  const images = options.images ? "data: blob: https: http:" : "data: blob:";
  const policy = [
    "default-src 'none'",
    `img-src ${images}`,
    "style-src 'unsafe-inline'",
    "font-src data: 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const body = html.replace(ATTACHMENT_SRC, '$1data-attachment="$2"');
  const paper = ownsColors(html) ? " paper" : "";
  return `<!doctype html><html data-theme="${scheme}" style="${escapeAttr(look)}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttr(policy)}"><meta name="color-scheme" content="${scheme}"><style>${BASE_CSS}</style></head><body><div class="${MAIL_SCOPE}${paper}">${body}</div></body></html>`;
}

/** Puts back every remote image the Server set aside, for "Show images". */
export function revealImages(doc: Document): void {
  for (const el of doc.querySelectorAll<HTMLElement>("[data-src]")) {
    el.setAttribute("src", el.getAttribute("data-src") ?? "");
    el.removeAttribute("data-src");
  }
  for (const el of doc.querySelectorAll<HTMLElement>("[data-srcset]")) {
    el.setAttribute("srcset", el.getAttribute("data-srcset") ?? "");
    el.removeAttribute("data-srcset");
  }
  for (const el of doc.querySelectorAll<HTMLElement>("[data-background]")) {
    el.setAttribute("background", el.getAttribute("data-background") ?? "");
    el.removeAttribute("data-background");
  }
  for (const el of doc.querySelectorAll<HTMLElement>("[data-blocked-style]")) {
    const own = el.getAttribute("style");
    const blocked = el.getAttribute("data-blocked-style") ?? "";
    el.setAttribute("style", own ? `${own}; ${blocked}` : blocked);
    el.removeAttribute("data-blocked-style");
  }
  for (const el of doc.querySelectorAll<HTMLStyleElement>("style[data-blocked]")) {
    el.setAttribute("media", "all");
  }
  for (const el of doc.querySelectorAll("[data-blocked]")) el.removeAttribute("data-blocked");
}

/** The host's look, carried into the document as custom properties: colours, font, size. */
export function carryHostStyle(host: Element | null, doc: Document): void {
  const root = doc.documentElement;
  if (!host || typeof getComputedStyle !== "function") return;
  const style = getComputedStyle(host);
  const token = (name: string) => style.getPropertyValue(name).trim();
  const set = (name: string, value: string) => {
    if (value) root.style.setProperty(name, value);
  };
  set("--mail-fg", style.color || token("--fg"));
  set("--mail-muted", token("--fg-muted"));
  set("--mail-rule", token("--border"));
  set("--mail-link", token("--accent"));
  set("--mail-mono", token("--font-mono"));
  set("--mail-font", style.fontFamily);
  set("--mail-size", style.fontSize);
  set("--mail-line", style.lineHeight);
  const dark = isLight(style.color);
  root.setAttribute("data-theme", dark ? "dark" : "light");
  // The frame's element and its document share a scheme, or the browser paints an opaque backdrop.
  root.style.colorScheme = dark ? "dark" : "light";
}

/** The app's colour scheme, read from the root element; light when there is no DOM. */
export function appScheme(): "light" | "dark" {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return "light";
  const scheme = getComputedStyle(document.documentElement).colorScheme ?? "";
  return scheme.includes("dark") ? "dark" : "light";
}

/** Whether a CSS colour is light (the app's text is light in a dark theme). */
function isLight(color: string): boolean {
  const m = color.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  let rgb: number[] | null = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  const hex = color.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (!rgb && hex) rgb = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  if (!rgb) return false;
  const [r = 0, g = 0, b = 0] = rgb;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5;
}

/** The app's @font-face rules, so a plain Message reads in the app's font. */
export function carryFonts(doc: Document): void {
  if (typeof document === "undefined") return;
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(list)) {
      if (rule.cssText.startsWith("@font-face")) rules.push(rule.cssText);
    }
  }
  if (rules.length === 0) return;
  const style = doc.createElement("style");
  style.textContent = rules.join("\n");
  doc.head?.appendChild(style);
}

/** The height the frame needs for its content, 0 before layout. */
export function contentHeight(doc: Document): number {
  const root = doc.querySelector(`.${MAIL_SCOPE}`) ?? doc.body;
  if (!root) return 0;
  const html = doc.documentElement;
  // A body wider than the reader scrolls sideways; its scrollbar needs room too.
  const view = doc.defaultView;
  const bar =
    view && html.scrollWidth > html.clientWidth
      ? Math.max(0, view.innerHeight - html.clientHeight)
      : 0;
  return Math.ceil(root.getBoundingClientRect().height + bar);
}
