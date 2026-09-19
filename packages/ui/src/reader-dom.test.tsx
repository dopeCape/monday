/// <reference types="bun-types" />
// The reader's Message over sanitised html, through the DOM (happy-dom): the
// blocked images come back on Show images, the quoted history folds and
// unfolds, and a link click goes to the opener rather than the webview.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Message as MessageData } from "@monday/shared";
import { act } from "react";
import type { Root } from "react-dom/client";
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

describe("Message over html", () => {
  test("Show images puts the src back and lifts the blocked mark the stylesheet hides", async () => {
    await mount(
      <Message
        message={message(
          '<p>Hi</p><img data-src="https://x.test/a.png" data-blocked="" alt="a"><img src="data:image/png;base64,AA" alt="b">',
        )}
        now={NOW}
      />,
    );
    const blocked = document.querySelector<HTMLImageElement>("img[alt=a]");
    expect(blocked?.hasAttribute("data-blocked")).toBe(true);
    expect(blocked?.getAttribute("src")).toBeNull();
    expect(button("Show images")).not.toBeNull();
    await act(async () => button("Show images")?.click());
    expect(blocked?.getAttribute("src")).toBe("https://x.test/a.png");
    expect(blocked?.hasAttribute("data-blocked")).toBe(false);
    expect(button("Show images")).toBeNull();
  });

  test("quoted history starts folded under the Setting and the button toggles it", async () => {
    const html = '<p>Reply</p><div class="quoted"><p>Earlier</p></div>';
    await mount(<Message message={message(html)} now={NOW} collapseQuoted />);
    expect(document.querySelector(".msg-body")?.getAttribute("data-quoted")).toBe("collapsed");
    await act(async () => button("Show quoted text")?.click());
    expect(document.querySelector(".msg-body")?.getAttribute("data-quoted")).toBe("open");
    expect(button("Hide quoted text")).not.toBeNull();
    await act(async () => root?.unmount());
    root = null;
    await mount(<Message message={message(html)} now={NOW} collapseQuoted={false} />);
    expect(document.querySelector(".msg-body")?.getAttribute("data-quoted")).toBe("open");
  });

  test("a link in the body opens through the opener, never in the webview", async () => {
    const opened: string[] = [];
    await mount(
      <Message
        message={message('<p><a href="https://x.test/doc">doc</a></p>')}
        now={NOW}
        onOpenLink={(href) => opened.push(href)}
      />,
    );
    const link = document.querySelector<HTMLAnchorElement>(".msg-body a");
    let prevented = false;
    await act(async () => {
      const e = new MouseEvent("click", { bubbles: true, cancelable: true });
      link?.dispatchEvent(e);
      prevented = e.defaultPrevented;
    });
    expect(opened).toEqual(["https://x.test/doc"]);
    expect(prevented).toBe(true);
  });

  test("an inline part resolves through attachmentSrc once the body is in", async () => {
    await mount(
      <Message
        message={message('<p>See</p><img src="/attachments/att-9" alt="inline">')}
        now={NOW}
        attachmentSrc={async (id) => `blob:resolved-${id}`}
      />,
    );
    const img = document.querySelector<HTMLImageElement>("img[alt=inline]");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(img?.getAttribute("src")).toBe("blob:resolved-att-9");
  });
});
