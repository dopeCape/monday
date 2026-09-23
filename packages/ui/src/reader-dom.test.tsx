/// <reference types="bun-types" />
// The reader's Message over sanitised html, through the DOM (happy-dom). The
// body renders in a sandboxed iframe of its own: the blocked images come back
// on Show images, the quoted history folds and unfolds, a link click goes to
// the opener rather than the webview, inline parts resolve through the
// device token, the frame fits its content, and a Message that sets its own
// colours is laid on paper while a plain one takes the app's.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Message as MessageData } from "@monday/shared";
import { act } from "react";
import type { Root } from "react-dom/client";
import { mailDocument, ownsColors } from "./components/mail-frame.ts";
import { Message } from "./components/reader.tsx";
import { dom } from "./test-dom.ts";

let createRoot: Awaited<ReturnType<typeof dom>>["createRoot"];
beforeAll(async () => {
  ({ createRoot } = await dom());
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  await act(async () => r.render(node));
}

const NOW = new Date("2026-09-16T10:00:00");

function message(bodyHtml: string): MessageData {
  return {
    id: "m1",
    threadId: "t1",
    from: { name: "Aoife Brennan", email: "aoife@northlight.dev" },
    to: [{ name: "Tejas", email: "tejas@genai-labs.io" }],
    cc: [],
    date: "2026-09-16T09:41:00",
    bodyText: "Hello",
    bodyHtml,
    attachments: [],
  };
}

const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".msg-more .btn")].find(
    (b) => b.textContent === label,
  ) ?? null;

const frame = () => document.querySelector<HTMLIFrameElement>("iframe.msg-frame");

/** The body's document once it has loaded and the reader has wired it. */
async function frameDoc(ready: (doc: Document) => boolean = () => true): Promise<Document> {
  for (let i = 0; i < 100; i++) {
    const doc = frame()?.contentDocument;
    // prepare() marks the fold state once it has wired the document.
    if (doc?.documentElement?.hasAttribute("data-quoted") && ready(doc)) return doc;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  throw new Error("the body's document never loaded");
}

describe("Message over html", () => {
  test("the body renders in a sandboxed frame with no scripts, apart from the app's DOM", async () => {
    await mount(<Message message={message("<p>Hi <b>there</b></p>")} now={NOW} />);
    const f = frame();
    expect(f?.getAttribute("sandbox")).toBe("allow-same-origin allow-popups");
    expect(f?.getAttribute("title")).toBe("Message body");
    const doc = await frameDoc();
    expect(doc.querySelector(".monday-mail b")?.textContent).toBe("there");
    // Nothing of the body is in the app's own document.
    expect(document.querySelector(".msg-body b")).toBeNull();
    const policy = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
    expect(policy?.getAttribute("content")).toContain("default-src 'none'");
    expect(policy?.getAttribute("content")).toContain("img-src data: blob:;");
  });

  test("Show images puts back every remote image the Server set aside", async () => {
    await mount(
      <Message
        message={message(
          [
            `<style media="not all" data-blocked="">.monday-mail .hero { background-image: url('https://x.test/bg.png'); }</style>`,
            '<p>Hi</p><img data-src="https://x.test/a.png" data-srcset="https://x.test/a.png 1x, https://x.test/a2.png 2x" data-blocked="" alt="a">',
            '<img src="data:image/png;base64,AA" alt="b">',
            `<table><tr><td data-background="https://x.test/td.png" data-blocked-style="background: url('https://x.test/td.png')" style="color: red" data-blocked="">x</td></tr></table>`,
          ].join(""),
        )}
        now={NOW}
      />,
    );
    let doc = await frameDoc();
    const before = doc.querySelector("img[alt=a]");
    expect(before?.hasAttribute("data-blocked")).toBe(true);
    expect(before?.getAttribute("src")).toBeNull();
    expect(button("Show images")).not.toBeNull();
    await act(async () => button("Show images")?.click());
    doc = await frameDoc((d) => d.querySelector("img[alt=a]")?.getAttribute("src") !== null);
    const img = doc.querySelector("img[alt=a]");
    expect(img?.getAttribute("src")).toBe("https://x.test/a.png");
    expect(img?.getAttribute("srcset")).toBe("https://x.test/a.png 1x, https://x.test/a2.png 2x");
    const td = doc.querySelector("td");
    expect(td?.getAttribute("background")).toBe("https://x.test/td.png");
    expect(td?.getAttribute("style")).toBe("color: red; background: url('https://x.test/td.png')");
    expect(doc.querySelector("style[media]")?.getAttribute("media")).toBe("all");
    expect(doc.querySelectorAll("[data-blocked]")).toHaveLength(0);
    expect(
      doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"),
    ).toContain("img-src data: blob: https: http:");
    expect(button("Show images")).toBeNull();
  });

  test("the reader.load_remote_images Setting shows them from the start", async () => {
    await mount(
      <Message
        message={message('<img data-src="https://x.test/a.png" data-blocked="" alt="a">')}
        now={NOW}
        loadRemoteImages
      />,
    );
    const doc = await frameDoc((d) => d.querySelector("img[alt=a]")?.getAttribute("src") !== null);
    expect(doc.querySelector("img[alt=a]")?.getAttribute("src")).toBe("https://x.test/a.png");
    expect(button("Show images")).toBeNull();
  });

  test("quoted history starts folded under the Setting and the button toggles it", async () => {
    const html = '<p>Reply</p><div class="quoted"><p>Earlier</p></div>';
    await mount(<Message message={message(html)} now={NOW} collapseQuoted />);
    const doc = await frameDoc();
    expect(document.querySelector(".msg-body")?.getAttribute("data-quoted")).toBe("collapsed");
    expect(doc.documentElement.getAttribute("data-quoted")).toBe("collapsed");
    await act(async () => button("Show quoted text")?.click());
    expect(document.querySelector(".msg-body")?.getAttribute("data-quoted")).toBe("open");
    expect(doc.documentElement.getAttribute("data-quoted")).toBe("open");
    expect(button("Hide quoted text")).not.toBeNull();
    await act(async () => root?.unmount());
    root = null;
    await mount(<Message message={message(html)} now={NOW} collapseQuoted={false} />);
    const open = await frameDoc();
    expect(open.documentElement.getAttribute("data-quoted")).toBe("open");
  });

  test("a link in the body opens through the opener, never in the webview", async () => {
    const opened: string[] = [];
    await mount(
      <Message
        message={message('<p><a href="https://x.test/doc"><b>doc</b></a></p>')}
        now={NOW}
        onOpenLink={(href) => opened.push(href)}
      />,
    );
    const doc = await frameDoc();
    const inner = doc.querySelector("a b");
    const view = doc.defaultView as (Window & typeof globalThis) | null;
    const Click = view?.MouseEvent ?? MouseEvent;
    let prevented = false;
    await act(async () => {
      const e = new Click("click", { bubbles: true, cancelable: true });
      inner?.dispatchEvent(e);
      prevented = e.defaultPrevented;
    });
    expect(opened).toEqual(["https://x.test/doc"]);
    expect(prevented).toBe(true);
  });

  test("an inline part resolves through attachmentSrc and is never fetched from the app's origin", async () => {
    const html = '<p>See</p><img src="/attachments/att-9" alt="inline">';
    // The document the frame parses never carries the attachment route as a src.
    expect(mailDocument(html, { images: false })).not.toContain('src="/attachments/');
    await mount(
      <Message
        message={message(html)}
        now={NOW}
        attachmentSrc={async (id) => `blob:resolved-${id}`}
      />,
    );
    const doc = await frameDoc(
      (d) => d.querySelector("img[alt=inline]")?.getAttribute("src") !== null,
    );
    expect(doc.querySelector("img[alt=inline]")?.getAttribute("src")).toBe("blob:resolved-att-9");
  });

  test("the frame fits its content and grows when an image loads", async () => {
    await mount(
      <Message
        message={message('<p>Tall</p><img src="data:image/png;base64,AA" alt="late">')}
        now={NOW}
      />,
    );
    const doc = await frameDoc();
    const scope = doc.querySelector(".monday-mail") as HTMLElement;
    let height = 480;
    scope.getBoundingClientRect = () => ({ height }) as DOMRect;
    const view = doc.defaultView as (Window & typeof globalThis) | null;
    const Loaded = view?.Event ?? Event;
    await act(async () => {
      doc.querySelector("img")?.dispatchEvent(new Loaded("load"));
    });
    expect(frame()?.style.height).toBe("480px");
    height = 912;
    await act(async () => {
      doc.querySelector("img")?.dispatchEvent(new Loaded("load"));
    });
    expect(frame()?.style.height).toBe("912px");
  });

  test("a Message with its own colours is laid on paper; a plain one takes the app's", async () => {
    expect(ownsColors('<table bgcolor="#ffffff"><tr><td>x</td></tr></table>')).toBe(true);
    expect(ownsColors('<p style="color: #333333">x</p>')).toBe(true);
    expect(ownsColors('<font color="#333333">x</font>')).toBe(true);
    // A grey signature reads on either theme: still a plain reply.
    expect(ownsColors('<p>Thanks</p><span style="color: rgb(136,136,136)">-- Tejas</span>')).toBe(
      false,
    );
    expect(ownsColors("<style>.monday-mail p { color: #222222; }</style><p>x</p>")).toBe(true);
    expect(ownsColors('<p style="border-color: red; text-decoration-color: blue">x</p>')).toBe(
      false,
    );
    expect(ownsColors("<p>Plain reply</p><blockquote>old</blockquote>")).toBe(false);

    await mount(<Message message={message("<p>Plain reply</p>")} now={NOW} />);
    const plain = await frameDoc();
    expect(plain.querySelector(".monday-mail")?.classList.contains("paper")).toBe(false);
    await act(async () => root?.unmount());
    root = null;
    await mount(
      <Message
        message={message('<table bgcolor="#f4f4f4"><tr><td>News</td></tr></table>')}
        now={NOW}
      />,
    );
    const paper = await frameDoc();
    expect(paper.querySelector(".monday-mail")?.classList.contains("paper")).toBe(true);
  });
});
