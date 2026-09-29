/// <reference types="bun-types" />
// Every dropdown in the app is monday's own Select (@monday/ui), never the
// browser's unstyled <select>: no source under apps/desktop/src or
// packages/ui/src renders one, outside comments.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [join(import.meta.dir), join(import.meta.dir, "../../../packages/ui/src")];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

// Built from parts so this file never matches itself.
const TAG = new RegExp(`<${"select"}[\\s>/]`);
const CREATE = new RegExp(`createElement\\(["']${"select"}["']`);

describe("no native select", () => {
  test("no source renders the browser's select", () => {
    const found: string[] = [];
    for (const root of ROOTS) {
      for (const file of sources(root)) {
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            const code = line.trim();
            if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
            if (TAG.test(code) || CREATE.test(code)) found.push(`${file}:${i + 1}`);
          });
      }
    }
    expect(found).toEqual([]);
  });
});
