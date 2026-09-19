/// <reference types="bun-types" />
// Motion is a Setting: the tokens in tokens.css carry every duration, the
// root's data-transitions="off" zeroes them, and the mail screens' rules name
// the tokens rather than a number. Needs a DOM for the computed values, so
// this file registers happy-dom and loads the stylesheets into the page.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dom } from "./test-dom.ts";

const here = new URL("./", import.meta.url).pathname;
// The font imports are not for the test page.
const tokensCss = readFileSync(`${here}tokens.css`, "utf8").replace(/^@import[^\n]*\n/gm, "");
const appCss = readFileSync(`${here}app.css`, "utf8");

beforeAll(async () => {
  await dom();
});

let style: HTMLStyleElement | null = null;
afterEach(() => {
  style?.remove();
  style = null;
  document.documentElement.removeAttribute("data-transitions");
});

function load(css: string) {
  style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

describe("the motion tokens", () => {
  test("carry the durations, and data-transitions=off zeroes every one", () => {
    load(tokensCss);
    document.documentElement.setAttribute("data-transitions", "auto");
    expect(token("--t-fast")).toBe("120ms");
    expect(token("--t-med")).toBe("220ms");
    expect(token("--t-slow")).toBe("320ms");
    document.documentElement.setAttribute("data-transitions", "off");
    expect(token("--t-fast")).toBe("0ms");
    expect(token("--t-med")).toBe("0ms");
    expect(token("--t-slow")).toBe("0ms");
  });

  test("the mail screens' rules name a token, never a number", () => {
    // Every rule whose selector is one of the mail screens' pieces: buttons,
    // chips, rows, the reader, the overlays, toasts, pickers, the compose box.
    const mine =
      /^(\.btn|\.chip|\.row|\.reader|\.scrim|\.cmdk|\.toast|\.pop|\.sec|\.compose|\.batch|\.att|\.msg|\.brief|\.reply|\.switch|\.seg|\.tabs|:root\[data-list)/;
    const rules = appCss.matchAll(/([^{}]+)\{([^{}]*)\}/g);
    const offenders: string[] = [];
    for (const [, selector = "", body = ""] of rules) {
      const sel = selector.trim();
      if (!mine.test(sel)) continue;
      if (!/transition|animation/.test(body)) continue;
      for (const line of body.split(";")) {
        if (!/transition|animation/.test(line)) continue;
        if (/\b\d+(\.\d+)?m?s\b/.test(line)) offenders.push(`${sel}: ${line.trim()}`);
        if (/animation:/.test(line) && !/var\(--t-/.test(line))
          offenders.push(`${sel}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
