// CSS from a Message, cleaned: the inline style attribute and the <style>
// blocks newsletters lay themselves out with. Parsing is postcss (the same
// parser sanitize-html uses); what survives is a fixed list of properties
// whose values carry no escape hatch (no expression(), no escapes, no
// comments, no angle brackets). url() is allowed in the background
// properties only, and only for what the image rule allows: a small inline
// data: image, or an http(s) image when remote images are on. A remote
// url() while they are off is not dropped but set aside, so "Show images"
// can put it back without asking the Server again.
//
// A <style> block is scoped to the message: every selector is prefixed with
// the class of the element the reader renders the body into (MAIL_SCOPE),
// html and body selectors become that element, and only @media survives of
// the at-rules (no @import, no @font-face: both load from the web).

import postcss, {
  type AtRule,
  type ChildNode,
  type Container,
  type Declaration,
  type Root,
} from "postcss";

/** The class of the element the reader wraps a body in; scoped selectors hang off it. */
export const MAIL_SCOPE = "monday-mail";

/** What one url() may become. */
export type UrlVerdict = { keep: string } | { block: string } | null;

export interface CssPolicy {
  /** Classifies the target of one url(); null drops the declaration. */
  url(target: string): UrlVerdict;
}

const PROPERTIES = new Set([
  "background",
  "background-color",
  "background-image",
  "background-position",
  "background-repeat",
  "background-size",
  "border",
  "border-collapse",
  "border-color",
  "border-radius",
  "border-spacing",
  "border-style",
  "border-width",
  "box-shadow",
  "box-sizing",
  "caption-side",
  "clear",
  "color",
  "direction",
  "display",
  "empty-cells",
  "float",
  "font",
  "font-family",
  "font-size",
  "font-stretch",
  "font-style",
  "font-variant",
  "font-weight",
  "height",
  "hyphens",
  "letter-spacing",
  "line-height",
  "list-style",
  "list-style-position",
  "list-style-type",
  "margin",
  "max-height",
  "max-width",
  "min-height",
  "min-width",
  "opacity",
  "outline",
  "overflow",
  "overflow-wrap",
  "overflow-x",
  "overflow-y",
  "padding",
  "table-layout",
  "text-align",
  "text-decoration",
  "text-decoration-color",
  "text-decoration-line",
  "text-decoration-style",
  "text-indent",
  "text-overflow",
  "text-shadow",
  "text-transform",
  "unicode-bidi",
  "vertical-align",
  "visibility",
  "white-space",
  "width",
  "word-break",
  "word-spacing",
  "word-wrap",
]);

/** Longhands of margin, padding and border by side and corner. */
const SIDED =
  /^(margin|padding)-(top|right|bottom|left)$|^border-(top|right|bottom|left)(-(color|style|width))?$|^border-(top|bottom)-(left|right)-radius$/;

/** The properties a url() may appear in. */
const URL_PROPERTIES = new Set(["background", "background-image"]);

const FORBIDDEN =
  /expression\(|javascript:|vbscript:|livescript:|@import|\\|\/\*|<|>|&#|behavior|-moz-binding|image-set|cross-fade|element\(|attr\(|var\(|env\(|src\(/;
const SAFE_VALUE = /^[\w\s#%.,()'"!/:+-]*$/;
const URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]*))\s*\)/gi;
const MAX_VALUE = 4096;

export function isAllowedProperty(property: string): boolean {
  return PROPERTIES.has(property) || SIDED.test(property);
}

/** Drops C0 controls and DEL, which browsers ignore inside a scheme ("java\tscript:"). */
export function stripControls(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out;
}

/** A URL made safe to sit inside url('...'): no quotes, parens or spaces left raw. */
function cssUrl(url: string): string {
  return url.replace(/['"()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

export type DeclarationVerdict =
  | { kind: "keep"; value: string }
  | { kind: "block"; value: string; urls: number }
  | null;

/** One declaration: kept (maybe with its url() rewritten), set aside until images are shown, or dropped. */
export function cleanDeclaration(
  rawProperty: string,
  rawValue: string,
  policy: CssPolicy,
): DeclarationVerdict {
  const property = rawProperty.trim().toLowerCase();
  if (!isAllowedProperty(property)) return null;
  const value = rawValue.trim();
  if (value.length === 0 || value.length > MAX_VALUE) return null;
  const lower = value.toLowerCase().replace(/\s+/g, "");
  if (FORBIDDEN.test(lower)) return null;
  let blocked = 0;
  let dropped = false;
  let urls = 0;
  const rewritten = value.replace(URL, (_all, dq: string, sq: string, bare: string) => {
    urls += 1;
    const verdict = policy.url(stripControls((dq ?? sq ?? bare ?? "").trim()));
    if (!verdict) {
      dropped = true;
      return "";
    }
    if ("block" in verdict) {
      blocked += 1;
      return `url('${cssUrl(verdict.block)}')`;
    }
    return `url('${cssUrl(verdict.keep)}')`;
  });
  if (dropped) return null;
  if (urls > 0 && !URL_PROPERTIES.has(property)) return null;
  // Whatever is left outside the url()s must be plain words, numbers and colours.
  const outside = rewritten.replace(/url\('[^']*'\)/g, "");
  if (/url\(/i.test(outside) || !SAFE_VALUE.test(outside)) return null;
  const clean = rewritten.replace(/"/g, "'");
  return blocked > 0
    ? { kind: "block", value: clean, urls: blocked }
    : { kind: "keep", value: clean };
}

export interface CleanStyle {
  /** What the element renders with now. */
  style: string;
  /** Declarations that load a remote image, for when the user shows images. */
  blocked: string;
  blockedImages: number;
}

/** The style attribute of one element, cleaned. */
export function cleanInlineStyle(style: string, policy: CssPolicy): CleanStyle {
  const keep: string[] = [];
  const blocked: string[] = [];
  let blockedImages = 0;
  let declarations: Declaration[] = [];
  try {
    const root = postcss.parse(`x{${style}}`);
    const first = root.first;
    if (first?.type === "rule") {
      declarations = (first.nodes ?? []).filter((n): n is Declaration => n.type === "decl");
    }
  } catch {
    return { style: "", blocked: "", blockedImages: 0 };
  }
  for (const d of declarations) {
    const verdict = cleanDeclaration(d.prop, d.value + (d.important ? " !important" : ""), policy);
    if (!verdict) continue;
    const line = `${d.prop.trim().toLowerCase()}: ${verdict.value}`;
    if (verdict.kind === "keep") keep.push(line);
    else {
      blocked.push(line);
      blockedImages += verdict.urls;
    }
  }
  return { style: keep.join("; "), blocked: blocked.join("; "), blockedImages };
}

/** A selector hung off the scope: html, :root and body become the scope element itself. */
export function scopeSelector(selector: string, scope = `.${MAIL_SCOPE}`): string | null {
  const s = selector.trim();
  if (s.length === 0 || s.length > 500 || /[<\\]|\/\*/.test(s)) return null;
  const root = s.match(/^(?:(?:html|:root)(?![\w-]))?\s*(?:body(?![\w-]))?/i)?.[0] ?? "";
  if (root.trim() === "") return `${scope} ${s}`;
  const rest = s.slice(root.length);
  return `${scope}${rest}`;
}

const MEDIA_PARAMS = /^[\w\s(),:.-]{0,300}$/;

export interface CleanSheet {
  css: string;
  /** Rules whose remote images wait for "Show images". */
  blocked: string;
  blockedImages: number;
}

/** A <style> block, cleaned and scoped. */
export function cleanStylesheet(css: string, policy: CssPolicy): CleanSheet {
  let root: Root;
  try {
    root = postcss.parse(css);
  } catch {
    return { css: "", blocked: "", blockedImages: 0 };
  }
  const blockedRoot = postcss.root();
  let blockedImages = 0;

  const walk = (container: Container, blockedContainer: Container) => {
    for (const node of [...(container.nodes ?? [])] as ChildNode[]) {
      if (node.type === "comment" || node.type === "decl") {
        node.remove();
        continue;
      }
      if (node.type === "atrule") {
        const at = node as AtRule;
        if (at.name.toLowerCase() !== "media" || !MEDIA_PARAMS.test(at.params) || !at.nodes) {
          at.remove();
          continue;
        }
        const twin = postcss.atRule({ name: "media", params: at.params });
        walk(at, twin);
        if ((at.nodes ?? []).length === 0) at.remove();
        if ((twin.nodes ?? []).length > 0) blockedContainer.append(twin);
        continue;
      }
      // A rule.
      const selectors = node.selectors.map((s) => scopeSelector(s));
      if (selectors.some((s) => s === null)) {
        node.remove();
        continue;
      }
      node.selectors = selectors as string[];
      const twin = postcss.rule({ selectors: node.selectors });
      for (const child of [...(node.nodes ?? [])]) {
        if (child.type !== "decl") {
          child.remove();
          continue;
        }
        const verdict = cleanDeclaration(
          child.prop,
          child.value + (child.important ? " !important" : ""),
          policy,
        );
        child.remove();
        if (!verdict) continue;
        const decl = postcss.decl({ prop: child.prop.trim().toLowerCase(), value: verdict.value });
        if (verdict.kind === "keep") node.append(decl);
        else {
          twin.append(decl);
          blockedImages += verdict.urls;
        }
      }
      if ((node.nodes ?? []).length === 0) node.remove();
      if ((twin.nodes ?? []).length > 0) blockedContainer.append(twin);
    }
  };
  walk(root, blockedRoot);
  // One compact layout whatever the sender's whitespace was.
  const print = (r: Root) => {
    if ((r.nodes ?? []).length === 0) return "";
    r.walk((node) => {
      if (node.type === "decl") node.raws = { before: " ", between: ": " };
      else if (node.type === "rule") {
        node.raws = { before: "\n", between: " ", after: " ", semicolon: true };
      } else if (node.type === "atrule") {
        node.raws = { before: "\n", between: " ", afterName: " ", after: "\n" };
      }
    });
    return r.toString().trim();
  };
  return { css: print(root), blocked: print(blockedRoot), blockedImages };
}
