// Real mail through the reader's sanitizer: a newsletter the way ESPs send
// it keeps its layout, remote images wait for "Show images" wherever they
// hide (img, srcset, the background attribute, inline CSS, the <style>
// block), and the <style> block is scoped to the reader's element.

import { describe, expect, test } from "bun:test";
import { cleanStylesheet, scopeSelector } from "../../src/mail/css.ts";
import { sanitizeHtml } from "../../src/mail/index.ts";
import { NEWSLETTER } from "./fixtures.ts";

/** The markup a browser acts on: the stash "Show images" reads from is inert until then. */
function live(html: string): string {
  return html
    .replace(/<style media="not all" data-blocked="">[\s\S]*?<\/style>/g, "")
    .replace(/\sdata-[a-z-]+="[^"]*"/g, "");
}

const render = (allowRemoteImages = false) =>
  sanitizeHtml(NEWSLETTER, {
    cidUrl: (id) => (id === "chart@example.com" ? "/attachments/att-chart" : null),
    allowRemoteImages,
  });

describe("a newsletter", () => {
  test("keeps its tables, their attributes, inline styles, center and font", () => {
    const { html } = render();
    expect(html).toContain("<center>");
    expect(html).toContain(
      `<table class="container" width="600" align="center" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="border-collapse: collapse; margin: 0 auto">`,
    );
    expect(html).toContain(`valign="top" height="120"`);
    expect(html).toContain(
      `style="padding: 32px; font-family: Helvetica,Arial,sans-serif; font-size: 16px; line-height: 24px; color: #333333; text-align: left"`,
    );
    expect(html).toContain(
      `<font face="Georgia, serif" color="#666666" size="2">Set in Georgia.</font>`,
    );
    expect(html).toContain(
      `style="background-color: #0066ff; color: #ffffff; border-radius: 4px; padding: 12px 24px; display: inline-block; text-decoration: none"`,
    );
    expect(html).toContain(`style="display: none; max-height: 0; overflow: hidden"`);
    // The body's backdrop survives on a div.
    expect(html).toContain(`<div bgcolor="#f4f4f4" style="margin: 0">`);
    // Nothing from the head shows: no title text, no link, no meta, no comment.
    expect(html).not.toContain("The Weekly</");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<meta");
    expect(html).not.toContain("preheader");
  });

  test("its style block is scoped to the reader's element; imports, fonts, keyframes and position go", () => {
    const { html } = render();
    const css = html.match(/^<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    expect(css).toContain(".monday-mail {");
    expect(css).toContain("background-color: #f4f4f4");
    expect(css).toContain(".monday-mail .container {");
    expect(css).toContain(".monday-mail h1.title, .monday-mail .hero td {");
    expect(css).toContain("@media only screen and (max-width: 620px)");
    expect(css).toContain("width: 100% !important");
    expect(css).toContain(".monday-mail a:hover {");
    expect(css).not.toContain("@import");
    expect(css).not.toContain("@font-face");
    expect(css).not.toContain("@keyframes");
    expect(css).not.toContain("position");
    expect(css).not.toContain("url(");
  });

  test("remote images are blocked and counted: img, srcset, background attribute, inline and block CSS", () => {
    const { html, blockedImages } = render();
    expect(live(html)).not.toMatch(/https:\/\/cdn\.example\.com|https:\/\/tracker\.example/);
    expect(html).toContain(`data-src="https://cdn.example.com/logo.png"`);
    expect(html).toContain(
      `data-srcset="https://cdn.example.com/logo.png 1x, https://cdn.example.com/logo@2x.png 2x"`,
    );
    expect(html).toContain(`data-background="https://cdn.example.com/bg.jpg"`);
    expect(html).toContain(
      `data-blocked-style="background: #333 url('https://cdn.example.com/bg.jpg') no-repeat center"`,
    );
    expect(html).toMatch(
      /<style media="not all" data-blocked="">\.monday-mail \.banner \{\s*background-image: url\('https:\/\/cdn\.example\.com\/banner\.png'\)/,
    );
    // The sender's own data-src never reaches the reader.
    expect(html).not.toContain("tracker.example/pixel");
    // logo (src and srcset, one image), open.gif, the td's background attribute, its inline background, the banner rule.
    expect(blockedImages).toBe(5);
    // The inline part resolves to the attachment route.
    expect(html).toContain(`src="/attachments/att-chart"`);
  });

  test("with remote images on, everything loads in place and nothing is set aside", () => {
    const { html, blockedImages } = render(true);
    expect(blockedImages).toBe(0);
    expect(html).not.toContain("data-blocked");
    expect(html).toContain(`src="https://cdn.example.com/logo.png"`);
    expect(html).toContain(`background="https://cdn.example.com/bg.jpg"`);
    expect(html).toContain(`url('https://cdn.example.com/banner.png')`);
  });
});

describe("CSS", () => {
  test("an inline data: image survives despite the semicolon in its URL", () => {
    const { html } = sanitizeHtml(
      `<div style="background-image:url(data:image/png;base64,iVBORw0KGgo=);color:red">x</div>`,
    );
    expect(html).toBe(
      `<div style="background-image: url('data:image/png;base64,iVBORw0KGgo='); color: red">x</div>`,
    );
  });

  test("a sender's data attributes and a url() outside the background properties are dropped", () => {
    const { html } = sanitizeHtml(
      `<p data-blocked-style="position:fixed" style="list-style-image:url(https://x.test/a.png);color:blue">x</p>`,
    );
    expect(html).toBe(`<p style="color: blue">x</p>`);
  });

  test("scopeSelector", () => {
    expect(scopeSelector("body")).toBe(".monday-mail");
    expect(scopeSelector("html body .x")).toBe(".monday-mail .x");
    expect(scopeSelector(":root")).toBe(".monday-mail");
    expect(scopeSelector("table td > p")).toBe(".monday-mail table td > p");
    expect(scopeSelector(".body")).toBe(".monday-mail .body");
    expect(scopeSelector("bodyish")).toBe(".monday-mail bodyish");
    expect(scopeSelector('a[title="</style>"]')).toBeNull();
  });

  test("a style block cannot close itself or smuggle markup", () => {
    const sheet = cleanStylesheet(
      `p { color: red } /* </style><script>alert(1)</script> */ a[x="<"] { color: blue } @media screen { p { content: "x" } }`,
      { url: () => null },
    );
    expect(sheet.css).toBe(".monday-mail p { color: red; }");
    expect(sheet.blocked).toBe("");
    const { html } = sanitizeHtml(
      `<style>p{color:red}</style><style>i{font-family:"</style><script>alert(1)</script>"}</style><p>x</p>`,
    );
    expect(html.toLowerCase()).not.toContain("<script");
    // The parser ends a style at its first </style>, as a browser does; the rest is text.
    expect(html).toBe(`<style>.monday-mail p { color: red; }</style>"}<p>x</p>`);
  });
});
