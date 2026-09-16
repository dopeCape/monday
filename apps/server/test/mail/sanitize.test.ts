import { describe, expect, test } from "bun:test";
import {
  displayBody,
  linkify,
  quoteStart,
  safeHref,
  sanitizeHtml,
  sanitizeStyle,
  textToHtml,
} from "../../src/mail/index.ts";

/** Payloads from the usual cheat sheets; none may survive as an executable vector. */
const XSS: string[] = [
  `<script>alert(1)</script>`,
  `<img src=x onerror=alert(1)>`,
  `<a href="javascript:alert(1)">x</a>`,
  `<a href="JaVaScRiPt:alert(1)">x</a>`,
  `<a href="java&#x09;script:alert(1)">x</a>`,
  `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>`,
  `<svg onload=alert(1)><circle r=1/></svg>`,
  `<iframe src="https://evil.test"></iframe>`,
  `<object data="https://evil.test/x.swf"></object>`,
  `<embed src="https://evil.test/x.swf">`,
  `<div style="background:url(javascript:alert(1))">x</div>`,
  `<div style="width: expression(alert(1))">x</div>`,
  `<p style="behavior:url(x.htc)">x</p>`,
  `<style>body{background:url("javascript:alert(1)")}</style>`,
  `<form action="https://evil.test"><input name=q><button>go</button></form>`,
  `<math><mi xlink:href="javascript:alert(1)">x</mi></math>`,
  `<body onload=alert(1)>x</body>`,
  `<img src="x" onmouseover="alert(1)">`,
  `<a href="https://ok.test" onclick="alert(1)">x</a>`,
  `<div onfocus=alert(1) tabindex=0>x</div>`,
  `<meta http-equiv="refresh" content="0;url=https://evil.test">`,
  `<link rel="stylesheet" href="https://evil.test/x.css">`,
  `<base href="https://evil.test/">`,
  `<textarea><script>alert(1)</script></textarea>`,
  `<noscript><p title="</noscript><img src=x onerror=alert(1)>">`,
  `<p><!-- <script>alert(1)</script> -->x</p>`,
  `<img src="https://evil.test/track.gif">`,
  `<video><source onerror=alert(1)></video>`,
  `<a href="  javascript:alert(1)">x</a>`,
  `<div style="color: red; background-image: url('https://evil.test/a.png')">x</div>`,
  `<x-custom onclick=alert(1)>x</x-custom>`,
  `<template><img src=x onerror=alert(1)></template>`,
];

describe("sanitizeHtml", () => {
  test("no payload in the corpus survives", () => {
    for (const payload of XSS) {
      const { html } = sanitizeHtml(payload);
      const lower = html.toLowerCase();
      expect(lower).not.toContain("<script");
      expect(lower).not.toContain("javascript:");
      expect(lower).not.toMatch(/\son[a-z]+=/);
      expect(lower).not.toContain("<iframe");
      expect(lower).not.toContain("<object");
      expect(lower).not.toContain("<embed");
      expect(lower).not.toContain("<svg");
      expect(lower).not.toContain("<math");
      expect(lower).not.toContain("<form");
      expect(lower).not.toContain("<meta");
      expect(lower).not.toContain("<link");
      expect(lower).not.toContain("<base");
      expect(lower).not.toContain("<style");
      expect(lower).not.toContain("expression(");
      expect(lower).not.toContain("url(");
      expect(lower).not.toContain("behavior");
      expect(lower).not.toMatch(/\ssrc="https?:/);
      expect(lower).not.toContain("alert(1)");
    }
  });

  test("keeps the allowlist and re-escapes text", () => {
    const { html } = sanitizeHtml(
      `<p>Hi <b>there</b> &amp; <i>you</i> <br> 1 &lt; 2 <span title="t">s</span></p><ul><li>a</li></ul><table><tr><td colspan="2">c</td></tr></table>`,
    );
    expect(html).toBe(
      `<p>Hi <b>there</b> &amp; <i>you</i> <br> 1 &lt; 2 <span title="t">s</span></p><ul><li>a</li></ul><table><tbody><tr><td colspan="2">c</td></tr></tbody></table>`
        .replace("<tbody>", "")
        .replace("</tbody>", ""),
    );
  });

  test("unknown tags are stripped but their text stays", () => {
    const { html } = sanitizeHtml(`<html><body><o:p>hello</o:p><custom>x</custom></body></html>`);
    expect(html).toBe("hellox");
  });

  test("links get rel and target and only safe schemes", () => {
    const { html } = sanitizeHtml(
      `<a href="https://ok.test/a?b=1&c=2">ok</a> <a href="mailto:a@b.c">m</a> <a href="ftp://x">f</a>`,
    );
    expect(html).toContain(
      `<a href="https://ok.test/a?b=1&amp;c=2" rel="noopener noreferrer" target="_blank">ok</a>`,
    );
    expect(html).toContain(
      `<a href="mailto:a@b.c" rel="noopener noreferrer" target="_blank">m</a>`,
    );
    expect(html).toContain("<a>f</a>");
  });

  test("cid images resolve to the attachment route; remote images are blocked by default", () => {
    const { html, blockedImages } = sanitizeHtml(
      `<img src="cid:part1@x" alt="a"><img src="https://r.test/i.png"><img src="cid:unknown">`,
      { cidUrl: (id) => (id === "part1@x" ? "/attachments/att-1" : null) },
    );
    expect(html).toContain(`<img src="/attachments/att-1" alt="a">`);
    expect(html).toContain(`<img data-src="https://r.test/i.png" data-blocked="">`);
    expect(html).not.toMatch(/\ssrc="https:\/\/r\.test/);
    expect(html).toContain("<img>");
    expect(blockedImages).toBe(1);
    const allowed = sanitizeHtml(`<img src="https://r.test/i.png">`, { allowRemoteImages: true });
    expect(allowed.html).toBe(`<img src="https://r.test/i.png">`);
    expect(allowed.blockedImages).toBe(0);
  });

  test("small data: images pass, other data: URIs do not", () => {
    const ok = sanitizeHtml(`<img src="data:image/png;base64,iVBORw0KGgo=">`);
    expect(ok.html).toContain("data:image/png;base64,iVBORw0KGgo=");
    const bad = sanitizeHtml(`<img src="data:text/html;base64,PHNjcmlwdD4=">`);
    expect(bad.html).toBe("<img>");
  });

  test("style keeps listed properties only", () => {
    expect(
      sanitizeStyle("color: red; background: url(x); font-size: 12px; position: absolute"),
    ).toBe("color: red; font-size: 12px");
    expect(sanitizeStyle('font-family: "Inter", sans-serif')).toBe(
      "font-family: 'Inter', sans-serif",
    );
  });

  test("gmail, apple and outlook quotes are wrapped as quoted history", () => {
    const gmail = sanitizeHtml(
      `<div dir="ltr">Reply</div><div class="gmail_quote"><div>On Mon, X wrote:</div><blockquote>old</blockquote></div>`,
    );
    expect(gmail.quoted).toBe(true);
    expect(gmail.html).toBe(
      `<div dir="ltr">Reply</div><div class="quoted"><div><div>On Mon, X wrote:</div><blockquote>old</blockquote></div></div>`,
    );
    const apple = sanitizeHtml(`<div>Reply</div><blockquote type="cite">old</blockquote>`);
    expect(apple.quoted).toBe(true);
    expect(apple.html).toContain(
      `<div class="quoted"><blockquote type="cite">old</blockquote></div>`,
    );
    const outlook = sanitizeHtml(
      `<div><p>Reply</p><div id="divRplyFwdMsg"><b>From:</b> x</div><hr><p>old</p></div>`,
    );
    expect(outlook.quoted).toBe(true);
    expect(outlook.html).toBe(
      `<div><p>Reply</p><div class="quoted"><div><b>From:</b> x</div><hr><p>old</p></div></div>`,
    );
    expect(sanitizeHtml("<p>no quote</p>").quoted).toBe(false);
  });

  test("safeHref", () => {
    expect(safeHref("https://a.b/c")).toBe("https://a.b/c");
    expect(safeHref("HTTP://a.b")).toBe("HTTP://a.b");
    expect(safeHref("javascript:x")).toBeNull();
    expect(safeHref("vbscript:x")).toBeNull();
    expect(safeHref("//a.b")).toBeNull();
    expect(safeHref("")).toBeNull();
  });
});

describe("textToHtml", () => {
  test("paragraphs, breaks and links", () => {
    const { html, quoted } = textToHtml(
      "Hi Tejas,\nSee https://example.com/a?b=1. Or mail me@example.com\n\nBest,\nAoife <b>",
    );
    expect(quoted).toBe(false);
    expect(html).toBe(
      `<p>Hi Tejas,<br>See <a href="https://example.com/a?b=1" rel="noopener noreferrer" target="_blank">https://example.com/a?b=1</a>. Or mail <a href="mailto:me@example.com" rel="noopener noreferrer" target="_blank">me@example.com</a></p><p>Best,<br>Aoife &lt;b&gt;</p>`,
    );
  });

  test("linkify keeps balanced parens and drops trailing punctuation", () => {
    expect(linkify("see (https://en.test/Foo_(bar)) now")).toContain(
      `href="https://en.test/Foo_(bar)"`,
    );
    expect(linkify("www.example.com, ok")).toContain(`href="http://www.example.com"`);
    expect(linkify("www.example.com, ok")).toContain(`>www.example.com</a>, ok`);
  });

  test("On ... wrote: starts the quoted history", () => {
    const { html, quoted } = textToHtml(
      "Sounds good.\n\nOn Mon, Sep 14, 2026 at 09:41, Aoife Brennan <aoife@northlight.dev> wrote:\n> Thanks for the brief.\n> I will have it back by Wednesday.\n>\n> > earlier\n",
    );
    expect(quoted).toBe(true);
    expect(html).toBe(
      `<p>Sounds good.</p><div class="quoted"><p>On Mon, Sep 14, 2026 at 09:41, Aoife Brennan &lt;<a href="mailto:aoife@northlight.dev" rel="noopener noreferrer" target="_blank">aoife@northlight.dev</a>&gt; wrote:</p><blockquote><p>Thanks for the brief.<br>I will have it back by Wednesday.</p><blockquote><p>earlier</p></blockquote></blockquote></div>`,
    );
  });

  test("a wrapped wrote: line and an Outlook header block are found", () => {
    const wrapped = [
      "Reply",
      "",
      "On Mon, Sep 14, 2026 at 09:41 Aoife Brennan",
      "<a@b.c> wrote:",
      "> old",
    ];
    expect(quoteStart(wrapped)).toBe(2);
    const outlook = [
      "Reply",
      "",
      "From: Aoife",
      "Sent: Monday",
      "To: Tejas",
      "Subject: Re: x",
      "",
      "old",
    ];
    expect(quoteStart(outlook)).toBe(2);
    const rule = ["Reply", "________________________________", "From: Aoife", "Sent: x"];
    expect(quoteStart(rule)).toBe(1);
    const original = ["Reply", "-----Original Message-----", "From: x"];
    expect(quoteStart(original)).toBe(1);
    expect(quoteStart(["From: the top", "nothing else"])).toBe(-1);
    expect(quoteStart(["Reply", "On the other hand, fine.", "next"])).toBe(-1);
  });

  test("a trailing run of > lines without a wrote line is history too", () => {
    const { html, quoted } = textToHtml("Yes.\n\n> Can you?\n> Please.");
    expect(quoted).toBe(true);
    expect(html).toBe(
      `<p>Yes.</p><div class="quoted"><blockquote><p>Can you?<br>Please.</p></blockquote></div>`,
    );
  });
});

describe("displayBody", () => {
  test("prefers html and resolves cids by attachment", () => {
    const out = displayBody({ text: "plain", html: `<p>rich <img src="cid:ABC"></p>` }, [
      {
        id: "att-9",
        messageId: "m",
        name: "a.png",
        size: 1,
        mediaType: "image/png",
        contentId: "abc",
        inline: true,
      },
    ]);
    expect(out.html).toBe(`<p>rich <img src="/attachments/att-9"></p>`);
  });

  test("falls back to the text part", () => {
    const out = displayBody({ text: "one\n\ntwo", html: null }, []);
    expect(out.html).toBe("<p>one</p><p>two</p>");
    expect(out.quoted).toBe(false);
  });
});
