/// <reference types="bun-types" />
// Motion (the appearance.transitions Setting): every duration in the shared
// CSS is a token, the off attribute zeroes each token and every running
// transition and animation, reduce-motion does the same, and the primitives
// that move (the toast's leave, the focus trap, Escape) behave. The CSS is
// read as text; the primitives run in happy-dom.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { act, useRef } from "react";
import type { Root } from "react-dom/client";
import { focusableIn, useEscape, useFocusTrap } from "./components/primitives.tsx";
import { leaveBeatMs, Toast } from "./components/toast.tsx";
import { dom } from "./test-dom.ts";

const tokensCss = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const appCss = readFileSync(new URL("./app.css", import.meta.url), "utf8");

const MOTION_TOKENS = ["--t-fast", "--t-med", "--t-slow", "--t-spin"];

/** The declarations inside one `selector { ... }` block of a stylesheet. */
function block(css: string, selector: string): string {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error(`no block ${selector}`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("motion tokens", () => {
  test("the root defines every motion token with a real duration", () => {
    const root = block(tokensCss, ":root {");
    for (const t of MOTION_TOKENS) expect(root).toMatch(new RegExp(`${t}: [1-9]\\d*ms;`));
    expect(root).toContain("--ease: cubic-bezier");
    expect(root).toContain("--ease-in: cubic-bezier");
  });

  test('data-transitions="off" zeroes every token, and app.css zeroes every running duration too', () => {
    const off = block(tokensCss, ':root[data-transitions="off"] {');
    for (const t of MOTION_TOKENS) expect(off).toContain(`${t}: 0ms;`);
    const reduce = block(appCss, "@media (prefers-reduced-motion: reduce)");
    for (const t of MOTION_TOKENS) expect(reduce).toContain(`${t}: 0ms;`);
    const hard = block(appCss, ':root[data-transitions="off"] *,');
    expect(hard).toContain("animation-duration: 0ms !important;");
    expect(hard).toContain("transition-duration: 0ms !important;");
  });

  test("no transition or animation in app.css carries a literal duration", () => {
    const literal = /^\s*(transition|animation)(-duration)?:[^;]*\b\d+(\.\d+)?m?s\b/gm;
    const offenders = [...appCss.matchAll(literal)]
      .map((m) => m[0].trim())
      .filter((line) => !/0ms( !important)?$/.test(line));
    expect(offenders).toEqual([]);
  });

  test("the primitives' states are covered: hover, pressed, focus-visible and disabled", () => {
    for (const sel of [".btn", ".chip", ".switch", ".seg button", ".tabs button"]) {
      expect(appCss, `${sel} focus-visible`).toContain(`${sel}:focus-visible`);
      expect(appCss, `${sel} disabled`).toContain(`${sel}:disabled`);
    }
    for (const sel of [".btn", ".chip", ".seg button"]) {
      expect(appCss, `${sel} pressed`).toContain(`${sel}:active:not(:disabled)`);
    }
    expect(appCss).toContain(".input:focus");
    expect(appCss).toContain(".toast.leaving");
    expect(appCss).toContain("@keyframes screen-in");
    expect(appCss).toContain(":root[data-theme-fade] body");
  });
});

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

async function render(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  await act(async () => r.render(node));
}

describe("Toast", () => {
  test("shows, offers Undo, marks itself leaving one beat before the end, and expires", async () => {
    const events: string[] = [];
    await render(
      <Toast
        text="Archived"
        undoLabel="Undo"
        undoKey="Z"
        ms={40}
        onUndo={() => events.push("undo")}
        onExpire={() => events.push("expire")}
      />,
    );
    const toast = document.querySelector(".toast") as HTMLElement;
    expect(toast.getAttribute("role")).toBe("status");
    expect(toast.textContent).toContain("Archived");
    expect(toast.textContent).toContain("Undo");
    await act(async () => (toast.querySelector("button") as HTMLButtonElement).click());
    expect(events).toEqual(["undo"]);
    await act(async () => Bun.sleep(60));
    expect(events).toEqual(["undo", "expire"]);
    // With no resolvable token (happy-dom, or transitions off) the leave beat is zero.
    expect(leaveBeatMs()).toBe(0);
  });

  test("without an undo the button is absent", async () => {
    await render(
      <Toast text="Undone" undoLabel="Undo" undoKey="Z" ms={1000} onExpire={() => {}} />,
    );
    expect(document.querySelector(".toast button")).toBeNull();
  });
});

function Sheet({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  useEscape(onClose);
  return (
    <div ref={ref} role="dialog" data-sheet>
      <button type="button" id="first">
        First
      </button>
      <input id="middle" />
      <button type="button" id="last">
        Last
      </button>
      <button type="button" disabled id="off">
        Off
      </button>
    </div>
  );
}

describe("useFocusTrap and useEscape", () => {
  test("focus enters the first control, Tab wraps both ways, Escape closes, focus returns", async () => {
    const outside = document.createElement("button");
    outside.id = "outside";
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement?.id).toBe("outside");
    const closes: number[] = [];
    await render(<Sheet onClose={() => closes.push(1)} />);
    expect(document.activeElement?.id).toBe("first");
    const sheet = document.querySelector<HTMLElement>("[data-sheet]") as HTMLElement;
    expect(focusableIn(sheet).map((el) => el.id)).toEqual(["first", "middle", "last"]);
    // Shift+Tab from the first wraps to the last.
    await act(async () => {
      sheet.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
      );
    });
    expect(document.activeElement?.id).toBe("last");
    // Tab from the last wraps to the first.
    await act(async () => {
      sheet.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(document.activeElement?.id).toBe("first");
    // Escape anywhere closes once.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(closes).toEqual([1]);
    // Unmounting hands focus back to where it was.
    if (root) await act(async () => root?.unmount());
    root = null;
    expect(document.activeElement?.id).toBe("outside");
    outside.remove();
  });
});
