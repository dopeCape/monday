/// <reference types="bun-types" />
// The exit hook reads the motion tokens off the root: with transitions on, a
// closed overlay stays mounted with the leaving class until its animation
// ends; with the Setting off (data-transitions="off" zeroes the tokens) it
// leaves at once. Needs a DOM, so happy-dom and the tokens stylesheet load.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { motionMs } from "@monday/ui";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { useExit, useExitValue } from "./useExit.ts";

const tokensCss = readFileSync(
  new URL("../../../../../packages/ui/src/tokens.css", import.meta.url).pathname,
  "utf8",
).replace(/^@import[^\n]*\n/gm, "");

let createRoot: Awaited<ReturnType<typeof dom>>["createRoot"];
beforeAll(async () => {
  ({ createRoot } = await dom());
});

let root: Root | null = null;
let host: HTMLElement | null = null;
let style: HTMLStyleElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  style?.remove();
  style = null;
  document.documentElement.removeAttribute("data-transitions");
});

function loadTokens(transitions: "auto" | "off") {
  style = document.createElement("style");
  style.textContent = tokensCss;
  document.head.appendChild(style);
  document.documentElement.setAttribute("data-transitions", transitions);
}

function Sheet({ open, onLeft }: { open: boolean; onLeft?: () => void }) {
  const exit = useExit(open, "--t-med", onLeft);
  if (!exit.mounted) return null;
  return (
    <div className={exit.leaving ? "sheet leaving" : "sheet"} onAnimationEnd={exit.onEnd}>
      sheet
    </div>
  );
}

function Held({ value }: { value: string | null }) {
  const exit = useExitValue(value, "--t-fast");
  if (!exit.value) return null;
  return <div className={exit.leaving ? "held leaving" : "held"}>{exit.value}</div>;
}

async function mount(node: React.ReactNode) {
  if (!root) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  const r = root;
  await act(async () => r.render(node));
}

const sheet = () => document.querySelector<HTMLElement>(".sheet");

describe("useExit", () => {
  test("with transitions on, a closed sheet leaves after its animation ends", async () => {
    loadTokens("auto");
    expect(motionMs("--t-med")).toBe(220);
    let left = 0;
    await mount(<Sheet open onLeft={() => left++} />);
    expect(sheet()?.classList.contains("leaving")).toBe(false);
    await mount(<Sheet open={false} onLeft={() => left++} />);
    expect(sheet()?.classList.contains("leaving")).toBe(true);
    expect(left).toBe(0);
    await act(async () => {
      sheet()?.dispatchEvent(new Event("animationend", { bubbles: true }));
    });
    expect(sheet()).toBeNull();
    expect(left).toBe(1);
  });

  test("a child's animation ending is not the sheet's", async () => {
    loadTokens("auto");
    await mount(<Sheet open />);
    await mount(<Sheet open={false} />);
    const child = document.createElement("span");
    sheet()?.appendChild(child);
    await act(async () => {
      child.dispatchEvent(new Event("animationend", { bubbles: true }));
    });
    expect(sheet()).not.toBeNull();
  });

  test("reopening during the leave keeps the sheet", async () => {
    loadTokens("auto");
    await mount(<Sheet open />);
    await mount(<Sheet open={false} />);
    expect(sheet()?.classList.contains("leaving")).toBe(true);
    await mount(<Sheet open />);
    expect(sheet()?.classList.contains("leaving")).toBe(false);
  });

  test("with the Setting off the tokens read zero and the sheet leaves at once", async () => {
    loadTokens("off");
    expect(motionMs("--t-med")).toBe(0);
    expect(motionMs("--t-fast")).toBe(0);
    let left = 0;
    await mount(<Sheet open onLeft={() => left++} />);
    await mount(<Sheet open={false} onLeft={() => left++} />);
    expect(sheet()).toBeNull();
    expect(left).toBe(1);
  });

  test("without a stylesheet at all (a test page) nothing waits", async () => {
    await mount(<Sheet open />);
    await mount(<Sheet open={false} />);
    expect(sheet()).toBeNull();
  });

  test("useExitValue holds the last value while it leaves", async () => {
    loadTokens("auto");
    await mount(<Held value="d1" />);
    expect(document.querySelector(".held")?.textContent).toBe("d1");
    await mount(<Held value={null} />);
    const held = document.querySelector<HTMLElement>(".held");
    expect(held?.textContent).toBe("d1");
    expect(held?.classList.contains("leaving")).toBe(true);
  });
});
