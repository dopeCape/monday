/// <reference types="bun-types" />
// The window's own frame through the DOM, over the Platform seam: with a
// frame (the desktop app) the strip shows minimize, maximize and close, each
// calling the frame, the maximize button turning into restore when a resize
// leaves the window maximized; a press on the strip drags the window and a
// double press maximizes it, while presses on the buttons do neither. With no
// frame (the browser dev server, tests) nothing renders and no strip is kept.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { type WindowFrame as Frame, fakePlatform, type Platform } from "../platform/tauri.ts";
import { StaticShell } from "./Shell.tsx";
import { WindowFrame } from "./WindowFrame.tsx";

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

interface FakeFrame extends Frame {
  calls: string[];
  maximized: boolean;
  resize(): void;
}

function fakeFrame(): FakeFrame {
  const listeners = new Set<() => void>();
  const frame: FakeFrame = {
    calls: [],
    maximized: false,
    minimize: async () => {
      frame.calls.push("minimize");
    },
    toggleMaximize: async () => {
      frame.calls.push("toggleMaximize");
    },
    close: async () => {
      frame.calls.push("close");
    },
    startDragging: async () => {
      frame.calls.push("startDragging");
    },
    isMaximized: async () => frame.maximized,
    onResized: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    resize: () => {
      for (const l of listeners) l();
    },
  };
  return frame;
}

const settle = () => act(async () => Bun.sleep(10));

async function mount(p: Platform) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  const load = () => Promise.resolve(p);
  await act(async () =>
    r.render(
      <StaticShell>
        <WindowFrame load={load} />
      </StaticShell>,
    ),
  );
  await settle();
}

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>(".titlebar .win-btn")];
const byLabel = (label: string) => buttons().find((b) => b.getAttribute("aria-label") === label);

function press(el: Element, detail = 1) {
  el.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail }),
  );
}

describe("WindowFrame", () => {
  test("hidden without a frame, and no strip is reserved", async () => {
    await mount(fakePlatform(""));
    expect(document.querySelector(".titlebar")).toBeNull();
    expect(document.documentElement.dataset.titlebar).toBeUndefined();
  });

  test("minimize, maximize and close call the frame, from the strings Settings", async () => {
    const frame = fakeFrame();
    await mount(fakePlatform("", { frame }));
    expect(document.documentElement.dataset.titlebar).toBe("custom");
    expect(buttons().map((b) => b.getAttribute("aria-label"))).toEqual([
      "Minimize",
      "Maximize",
      "Close",
    ]);
    await act(async () => byLabel("Minimize")?.click());
    await act(async () => byLabel("Maximize")?.click());
    await act(async () => byLabel("Close")?.click());
    expect(frame.calls).toEqual(["minimize", "toggleMaximize", "close"]);
  });

  test("the maximize button turns into restore when the window is maximized, and back", async () => {
    const frame = fakeFrame();
    await mount(fakePlatform("", { frame }));
    const middle = () => buttons()[1] as HTMLButtonElement;
    expect(middle().getAttribute("data-state")).toBe("normal");
    const square = middle().innerHTML;
    frame.maximized = true;
    await act(async () => frame.resize());
    await settle();
    expect(middle().getAttribute("aria-label")).toBe("Restore");
    expect(middle().getAttribute("data-state")).toBe("maximized");
    // The glyph changes with it: the square, then the two overlapping ones.
    expect(middle().innerHTML).not.toBe(square);
    frame.maximized = false;
    await act(async () => frame.resize());
    await settle();
    expect(middle().getAttribute("aria-label")).toBe("Maximize");
    expect(middle().innerHTML).toBe(square);
  });

  test("a press on the strip drags, a double press maximizes, a press on a button does neither", async () => {
    const frame = fakeFrame();
    await mount(fakePlatform("", { frame }));
    const strip = document.querySelector(".titlebar") as HTMLElement;
    await act(async () => press(strip));
    await act(async () => press(strip, 2));
    await act(async () => press(byLabel("Close") as HTMLElement));
    expect(frame.calls).toEqual(["startDragging", "toggleMaximize"]);
  });

  test("the buttons are real buttons the keyboard reaches", async () => {
    await mount(fakePlatform("", { frame: fakeFrame() }));
    for (const b of buttons()) {
      expect(b.tagName).toBe("BUTTON");
      expect(b.type).toBe("button");
      expect(b.tabIndex).toBe(0);
    }
  });

  test("unmounting gives the strip's height back", async () => {
    await mount(fakePlatform("", { frame: fakeFrame() }));
    expect(document.documentElement.dataset.titlebar).toBe("custom");
    const r = root;
    await act(async () => r?.unmount());
    root = null;
    expect(document.documentElement.dataset.titlebar).toBeUndefined();
  });
});
