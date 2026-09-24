// Message HTML made safe for the reader. Mail HTML is untrusted (ADR 0002
// says as much about the shell; the webview is no different), so the reader
// only ever sees what sanitize-html re-serialises: a fixed set of tags, a
// fixed set of attributes, http, https and mailto links, and images that are
// inline parts (cid:, resolved to /attachments/:id), small data: images, or
// remote images blocked until the user asks. Every text node and attribute
// value is escaped again on the way out.
//
// Real mail lays itself out with tables, their presentational attributes,
// inline styles and a <style> block, so those survive: the table attributes
// newsletters use (width, align, valign, bgcolor, background, cellpadding,
// cellspacing, border), <center> and <font>, srcset, and the CSS in css.ts
// (a property allowlist, remote url() under the same rule as <img>, and the
// <style> block scoped to the element the reader renders into).
//
// Before sanitize-html runs, one pass over the parsed tree (htmlparser2)
// does what an allowlist cannot: it lifts the <style> blocks out, drops the
// subtrees whose content must never show (script, head, iframe, svg and
// friends), removes the sender's own data-* attributes (the reader keys on
// data-src and data-blocked), turns <body> into a <div> so its bgcolor and
// style survive, and wraps quoted history in <div class="quoted"> so the
// reader can fold it: known quote containers (Gmail, Apple Mail,
// Thunderbird, Yahoo, Outlook's reply separator).
//
// Remote images, when blocked, move aside instead of disappearing: an
// <img>'s src to data-src (and srcset to data-srcset), a background
// attribute to data-background, a style declaration to data-blocked-style,
// and a <style> rule into <style media="not all" data-blocked>. Each carries
// data-blocked, and "Show images" puts them back without another request.

import { type ChildNode, Element, isTag, isText, type ParentNode } from "domhandler";
import { DomUtils, parseDocument } from "htmlparser2";
import sanitize from "sanitize-html";
import {
  type CssPolicy,
  cleanInlineStyle,
  cleanStylesheet,
  stripControls,
  type UrlVerdict,
} from "./css.ts";
import { escapeHtml } from "./escape.ts";

export { MAIL_SCOPE } from "./css.ts";

export interface SanitizeOptions {
  /** Content-ID (without angle brackets) to the URL that serves the part. */
  cidUrl?: (contentId: string) => string | null;
  /** Load http(s) images. Off by default: they move aside and the reader offers to show them. */
  allowRemoteImages?: boolean;
  /**
   * Hosts (or host suffixes) whose images are open trackers, dropped whether
   * or not remote images load: the reader.tracker_hosts Setting.
   */
  trackerHosts?: readonly string[];
  /** Extra class names (beyond the built-in list) that mark a quoted-history container. */
  quoteClasses?: readonly string[];
}

export interface SanitizedHtml {
  html: string;
  /** True when a quoted-history container was found and wrapped. */
  quoted: boolean;
  /** Remote images left unloaded (img, srcset, backgrounds, CSS url()). */
  blockedImages: number;
  /** Tracking pixels dropped: tiny or hidden remote images, and images from tracker hosts. */
  trackers: number;
  /** Subtrees dropped whole, for diagnostics. */
  dropped: number;
}

/** Tags kept (their attributes filtered); anything else is unwrapped, its text kept. */
const ALLOWED_TAGS = [
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "b",
  "bdi",
  "bdo",
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
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "font",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "main",
  "mark",
  "nav",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "summary",
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
];

/** Tags whose whole subtree is dropped: nothing inside them is mail the reader shows. */
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
  "map",
  "math",
  "meta",
  "noembed",
  "noframes",
  "noscript",
  "object",
  "option",
  "plaintext",
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
  "xmp",
]);

/** The attributes the reader itself sets; a sender's copies are removed before sanitising. */
const STASH = ["data-src", "data-srcset", "data-background", "data-blocked-style", "data-blocked"];

const GLOBAL_ATTRS = [
  "title",
  "dir",
  "lang",
  "style",
  "class",
  "align",
  "valign",
  "bgcolor",
  "background",
  "width",
  "height",
  "border",
  ...STASH,
];
const TAG_ATTRS: Record<string, string[]> = {
  a: ["href", "rel", "target"],
  img: ["src", "srcset", "alt", "hspace", "vspace"],
  td: ["colspan", "rowspan", "nowrap"],
  th: ["colspan", "rowspan", "nowrap", "scope"],
  table: ["cellpadding", "cellspacing"],
  col: ["span"],
  colgroup: ["span"],
  ol: ["start", "type"],
  ul: ["type"],
  li: ["value"],
  font: ["color", "face", "size"],
  hr: ["size", "color", "noshade"],
  q: ["cite"],
  blockquote: ["type", "cite"],
  details: ["open"],
};

const NUMERIC = new Set([
  "width",
  "height",
  "border",
  "cellpadding",
  "cellspacing",
  "colspan",
  "rowspan",
  "span",
  "start",
  "hspace",
  "vspace",
  "value",
]);
const WORD = new Set(["align", "valign", "dir", "type", "scope", "lang"]);
const COLOR = new Set(["bgcolor", "color"]);

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

/** The largest data: image kept inline. */
const MAX_DATA_IMAGE = 2_000_000;

export { escapeHtml };

/** A safe href: http, https or mailto with no control characters; null otherwise. */
export function safeHref(value: string): string | null {
  const trimmed = stripControls(value.trim());
  if (trimmed.length === 0 || trimmed.length > 4096) return null;
  const lower = trimmed.toLowerCase();
  if (/^https?:\/\//.test(lower)) return trimmed;
  if (/^mailto:[^\s]+/.test(lower)) return trimmed;
  return null;
}

/** Where an image may come from: a cid: part, a small data: image, or http(s) under the remote rule. */
function imageVerdict(value: string, options: SanitizeOptions): UrlVerdict {
  const trimmed = stripControls(value.trim()).replace(/\s/g, "");
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("cid:")) {
    const id = trimmed.slice(4).replace(/^<|>$/g, "");
    let decoded = id;
    try {
      decoded = decodeURIComponent(id);
    } catch {}
    const url = options.cidUrl?.(decoded) ?? null;
    return url ? { keep: url } : null;
  }
  if (/^data:image\/(png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=]+$/i.test(trimmed)) {
    return trimmed.length <= MAX_DATA_IMAGE ? { keep: trimmed } : null;
  }
  if (/^https?:\/\/[^/]/.test(lower) && trimmed.length <= 4096) {
    return options.allowRemoteImages ? { keep: trimmed } : { block: trimmed };
  }
  return null;
}

/**
 * An open tracker: a remote image no one is meant to see (1 or 2 pixels, or
 * hidden) or one served from a known tracking host. It is dropped rather than
 * blocked, so showing images never tells the sender the message was opened.
 */
export function isTrackerImage(
  attribs: Record<string, string>,
  trackerHosts: readonly string[],
): boolean {
  // Seen after the img transform too, when a blocked image's url sits in data-src.
  const src = (attribs.src ?? attribs["data-src"] ?? "").trim();
  if (!/^https?:\/\//i.test(src)) return false;
  const tiny = (v: string | undefined) => v !== undefined && /^\s*[0-2](px)?\s*$/i.test(v);
  if (tiny(attribs.width) && tiny(attribs.height)) return true;
  const style = (attribs.style ?? "").toLowerCase().replace(/\s+/g, "");
  if (/display:none|visibility:hidden/.test(style)) return true;
  if (
    /(^|;)width:[0-2](px)?(!important)?(;|$)/.test(style) &&
    /(^|;)height:[0-2](px)?(!important)?(;|$)/.test(style)
  ) {
    return true;
  }
  let host = "";
  try {
    host = new URL(src).hostname.toLowerCase();
  } catch {
    return false;
  }
  return trackerHosts.some((h) => {
    const t = h.trim().toLowerCase();
    return t !== "" && (host === t || host.endsWith(`.${t}`));
  });
}

/** A srcset whose candidates all pass the image rule; blocked when any is remote and images are off. */
function srcsetVerdict(value: string, options: SanitizeOptions): UrlVerdict {
  const out: string[] = [];
  let blocked = false;
  for (const candidate of value.split(/,(?=\s)|,$/)) {
    const [url, ...descriptor] = candidate.trim().split(/\s+/);
    if (!url) continue;
    const d = descriptor.join(" ");
    if (d && !/^\d+(\.\d+)?[wx]$/.test(d)) return null;
    const verdict = imageVerdict(url, options);
    if (!verdict) return null;
    if ("block" in verdict) blocked = true;
    const target = "block" in verdict ? verdict.block : verdict.keep;
    if (/[\s,]/.test(target)) return null;
    out.push(d ? `${target} ${d}` : target);
  }
  if (out.length === 0) return null;
  const joined = out.join(", ");
  return blocked ? { block: joined } : { keep: joined };
}

function classesOf(el: Element): string[] {
  return (el.attribs.class ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

function isQuoteContainer(el: Element, extra: readonly string[]): boolean {
  if (classesOf(el).some((c) => QUOTE_CLASSES.includes(c) || extra.includes(c))) return true;
  return el.name === "blockquote" && (el.attribs.type ?? "").toLowerCase() === "cite";
}

function isOutlookSeparator(el: Element): boolean {
  return OUTLOOK_SEPARATORS.has((el.attribs.id ?? "").toLowerCase());
}

interface Prepared {
  html: string;
  styles: string[];
  quoted: boolean;
  dropped: number;
}

/** The tree pass before sanitising: styles lifted, dead subtrees dropped, quotes wrapped. */
function prepare(input: string, extraQuoteClasses: readonly string[]): Prepared {
  const doc = parseDocument(input, { decodeEntities: true, lowerCaseTags: true });
  const styles = DomUtils.getElementsByTagName("style", doc, true).map((s) =>
    DomUtils.textContent(s),
  );
  let quoted = false;
  let dropped = 0;

  const wrapQuoted = (nodes: ChildNode[]) => {
    const first = nodes[0];
    if (!first) return;
    const wrapper = new Element("div", { class: "quoted" });
    DomUtils.prepend(first, wrapper);
    for (const n of nodes) DomUtils.appendChild(wrapper, n);
    quoted = true;
  };

  const walk = (parent: ParentNode, insideQuote: boolean) => {
    const children = [...parent.children];
    for (let i = 0; i < children.length; i++) {
      const node = children[i] as ChildNode;
      if (isText(node)) continue;
      if (!isTag(node)) {
        // Comments, doctypes, processing instructions, CDATA.
        DomUtils.removeElement(node);
        continue;
      }
      if (DROPPED.has(node.name)) {
        if (node.name !== "style" && node.name !== "head") dropped += 1;
        DomUtils.removeElement(node);
        continue;
      }
      for (const key of Object.keys(node.attribs)) {
        if (key.startsWith("data-")) delete node.attribs[key];
      }
      // A body's bgcolor and style are the message's backdrop: kept on a div. A bare body is unwrapped.
      if (node.name === "body" && Object.keys(node.attribs).length > 0) node.name = "div";
      if (!insideQuote && isOutlookSeparator(node)) {
        // Everything from the separator to the end of its parent is the quoted history.
        const rest = parent.children.slice(parent.children.indexOf(node));
        wrapQuoted(rest);
        for (const n of rest) if (isTag(n)) walk(n, true);
        return;
      }
      if (!insideQuote && isQuoteContainer(node, extraQuoteClasses)) {
        wrapQuoted([node]);
        walk(node, true);
        continue;
      }
      walk(node, insideQuote);
    }
  };
  walk(doc, false);
  return { html: DomUtils.getOuterHTML(doc), styles, quoted, dropped };
}

export function sanitizeHtml(input: string, options: SanitizeOptions = {}): SanitizedHtml {
  const prepared = prepare(input, options.quoteClasses ?? []);
  let blockedImages = 0;
  let trackers = 0;
  const policy: CssPolicy = { url: (target) => imageVerdict(target, options) };

  const transformAll = (tagName: string, attribs: sanitize.Attributes): sanitize.Tag => {
    const out: sanitize.Attributes = {};
    let blocked = false;
    for (const [key, raw] of Object.entries(attribs)) {
      const value = raw ?? "";
      if (STASH.includes(key)) {
        // Set by the tag transforms below, never by the sender (prepare removed theirs).
        out[key] = value;
        continue;
      }
      if (key === "style") {
        const clean = cleanInlineStyle(value, policy);
        if (clean.style) out.style = clean.style;
        if (clean.blocked) {
          out["data-blocked-style"] = clean.blocked;
          blockedImages += clean.blockedImages;
          blocked = true;
        }
        continue;
      }
      if (key === "background") {
        const verdict = imageVerdict(value, options);
        if (!verdict) continue;
        if ("block" in verdict) {
          out["data-background"] = verdict.block;
          blockedImages += 1;
          blocked = true;
        } else out.background = verdict.keep;
        continue;
      }
      if (key === "class") {
        const classes = value.split(/\s+/).filter((c) => /^[\w-]{1,64}$/.test(c));
        if (classes.length > 0) out.class = classes.slice(0, 20).join(" ");
        continue;
      }
      if (NUMERIC.has(key)) {
        if (/^\d{1,5}(\.\d+)?(%|px)?$/.test(value.trim())) out[key] = value.trim();
        continue;
      }
      if (WORD.has(key)) {
        if (/^[a-z-]{1,20}$/i.test(value.trim())) out[key] = value.trim().toLowerCase();
        continue;
      }
      if (COLOR.has(key)) {
        if (/^(#[0-9a-f]{3,8}|[a-z]{1,30})$/i.test(value.trim())) out[key] = value.trim();
        continue;
      }
      if (key === "face") {
        if (/^[\w\s,'-]{1,200}$/.test(value)) out.face = value;
        continue;
      }
      if (key === "size" && tagName === "font") {
        if (/^[+-]?[1-7]$/.test(value.trim())) out.size = value.trim();
        continue;
      }
      if (key === "cite") {
        const href = safeHref(value);
        if (href) out.cite = href;
        continue;
      }
      if (value.length <= 1024) out[key] = value;
    }
    if (blocked) out["data-blocked"] = "";
    return { tagName, attribs: out };
  };

  // allowedEmptyAttributes is in sanitize-html 2.x but not yet in its published types.
  const config: sanitize.IOptions & { allowedEmptyAttributes: string[] } = {
    exclusiveFilter: (frame) => {
      if (frame.tag !== "img" || !isTrackerImage(frame.attribs, options.trackerHosts ?? [])) {
        return false;
      }
      trackers += 1;
      if (frame.attribs["data-blocked"] !== undefined) blockedImages -= 1;
      return true;
    },
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { "*": GLOBAL_ATTRS, ...TAG_ATTRS },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https", "data"] },
    allowedSchemesAppliedToAttributes: ["href", "src", "cite", "background"],
    allowProtocolRelative: false,
    allowedEmptyAttributes: ["alt", "data-blocked"],
    disallowedTagsMode: "discard",
    nonTextTags: [...DROPPED],
    parseStyleAttributes: false,
    transformTags: {
      a: (tagName, attribs) => {
        const href = safeHref(attribs.href ?? "");
        const out: sanitize.Attributes = { ...attribs };
        delete out.href;
        delete out.rel;
        delete out.target;
        if (href) Object.assign(out, { href, rel: "noopener noreferrer", target: "_blank" });
        return { tagName, attribs: out };
      },
      img: (tagName, attribs) => {
        const out: sanitize.Attributes = { ...attribs };
        delete out.src;
        delete out.srcset;
        let blocked = false;
        const src = attribs.src ? imageVerdict(attribs.src, options) : null;
        if (src && "keep" in src) out.src = src.keep;
        else if (src) {
          out["data-src"] = src.block;
          blocked = true;
        }
        const srcset = attribs.srcset ? srcsetVerdict(attribs.srcset, options) : null;
        if (srcset && "keep" in srcset) out.srcset = srcset.keep;
        else if (srcset) {
          out["data-srcset"] = srcset.block;
          blocked = true;
        }
        if (blocked) {
          blockedImages += 1;
          out["data-blocked"] = "";
        }
        return { tagName, attribs: out };
      },
      "*": transformAll,
    },
  };
  const html = sanitize(prepared.html, config);

  let css = "";
  let blockedCss = "";
  for (const style of prepared.styles) {
    const sheet = cleanStylesheet(style, policy);
    if (sheet.css) css += `${css ? "\n" : ""}${sheet.css}`;
    if (sheet.blocked) blockedCss += `${blockedCss ? "\n" : ""}${sheet.blocked}`;
    blockedImages += sheet.blockedImages;
  }
  const head =
    (css ? `<style>${css}</style>` : "") +
    (blockedCss ? `<style media="not all" data-blocked="">${blockedCss}</style>` : "");
  return {
    html: `${head}${html.trim()}`,
    quoted: prepared.quoted,
    blockedImages,
    trackers,
    dropped: prepared.dropped,
  };
}

/** The style attribute alone, for callers that only have a declaration list. */
export function sanitizeStyle(style: string, options: SanitizeOptions = {}): string {
  return cleanInlineStyle(style, { url: (target) => imageVerdict(target, options) }).style;
}
