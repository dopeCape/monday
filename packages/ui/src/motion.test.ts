/// <reference types="bun-types" />
// The motion tokens through the DOM: the stylesheet's durations read back
// from the root, the off switch (data-transitions="off") zeroes every one
// of them, and motionMs, which code uses to keep something on screen while
// it leaves, follows the switch.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { motionMs, parseDuration } from "./motion.ts";
import { dom } from "./test-dom.ts";

const tokens = readFileSync(join(import.meta.dir, "tokens.css"), "utf8")
  // The font imports are for the bundler, not the DOM.
  .replace(/@import[^;]+;/g, "");
const app = readFileSync(join(import.meta.dir, "app.css"), "utf8");

let style: HTMLStyleElement | null = null;
beforeAll(async () => {
  await dom();
});
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

const root = () => getComputedStyle(document.documentElement);

describe("motion tokens", () => {
  test("parseDuration reads ms and s, and anything else as 0", () => {
    expect(parseDuration("220ms")).toBe(220);
    expect(parseDuration(" 0.32s ")).toBe(320);
    expect(parseDuration("0ms")).toBe(0);
    expect(parseDuration("")).toBe(0);
    expect(parseDuration("fast")).toBe(0);
  });

  test("the root carries the three durations, and the off switch reads them as 0", () => {
    load(tokens);
    expect(parseDuration(root().getPropertyValue("--t-fast"))).toBe(120);
    expect(parseDuration(root().getPropertyValue("--t-med"))).toBe(220);
    expect(parseDuration(root().getPropertyValue("--t-slow"))).toBe(320);
    expect(motionMs("--t-med")).toBe(220);

    document.documentElement.dataset.transitions = "off";
    expect(parseDuration(root().getPropertyValue("--t-fast"))).toBe(0);
    expect(parseDuration(root().getPropertyValue("--t-med"))).toBe(0);
    expect(parseDuration(root().getPropertyValue("--t-slow"))).toBe(0);
    expect(motionMs("--t-fast")).toBe(0);
    expect(motionMs("--t-med")).toBe(0);
    expect(motionMs("--t-slow")).toBe(0);
  });

  test("with the switch off every transition and animation in the app's stylesheet lasts 0", () => {
    load(`${tokens}\n${app}`);
    const host = document.createElement("div");
    document.body.appendChild(host);
    // A sample of what moves on the intelligence screens: the panel, a card, a chip, a decision row.
    host.innerHTML = [
      '<div class="agent-panel"></div>',
      '<div class="tool"></div>',
      '<button class="chip"></button>',
      '<div class="sample leaving"></div>',
      '<div class="choice-card"></div>',
    ].join("");
    // The DOM resolves the shorthands with the tokens substituted; the durations are read out of them.
    const durations = (el: Element, property: "animation" | "transition") =>
      (
        getComputedStyle(el)
          .getPropertyValue(property)
          .match(/\b\d+(?:\.\d+)?m?s\b/g) ?? []
      ).map(parseDuration);
    // With transitions on, the tokens resolve: the card enters over --t-med, the chip over --t-fast
    // (the shared button rule: background, color, border, shadow, opacity and press).
    expect(durations(host.children[1] as Element, "animation")).toEqual([220]);
    expect(durations(host.children[2] as Element, "transition")).toEqual([
      120, 120, 120, 120, 120, 120,
    ]);
    expect(durations(host.children[0] as Element, "animation")).toEqual([220]);

    document.documentElement.dataset.transitions = "off";
    for (const el of host.children) {
      for (const property of ["transition", "animation"] as const) {
        for (const ms of durations(el, property)) expect(ms).toBe(0);
      }
    }
    expect(durations(host.children[1] as Element, "animation")).toEqual([0]);
    expect(durations(host.children[3] as Element, "animation")).toEqual([0]);
    host.remove();
  });

  test("no literal duration lives in the app's stylesheet: every one is a token", () => {
    const literal = /\b\d+(?:\.\d+)?m?s\b/g;
    const offenders: string[] = [];
    for (const line of app.split("\n")) {
      if (!/transition|animation/.test(line)) continue;
      // The off switch itself pins durations to 0ms; that is the one place a literal belongs.
      if (line.includes("!important")) continue;
      const found = line.match(literal);
      if (found) offenders.push(line.trim());
    }
    expect(offenders).toEqual([]);
  });
});
