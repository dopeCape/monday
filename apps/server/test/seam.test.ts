// The envelope has one door. Only src/crypto may touch node:crypto's cipher
// functions; everyone else goes through the Mailstore's storeContent.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const ENTRY = fileURLToPath(new URL("../entry", import.meta.url));
const FORBIDDEN = /createCipheriv|createDecipheriv|crypto\.subtle\.(encrypt|decrypt)/;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.[cm]?[jt]s$/.test(name)) yield path;
  }
}

describe("crypto seam", () => {
  test("no file outside src/crypto calls a cipher", () => {
    const offenders: string[] = [];
    for (const root of [SRC, ENTRY]) {
      for (const file of walk(root)) {
        const rel = relative(SRC, file);
        if (rel.startsWith("crypto/")) continue;
        if (FORBIDDEN.test(readFileSync(file, "utf8"))) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("src/crypto/aead.ts is where the cipher lives", () => {
    expect(FORBIDDEN.test(readFileSync(join(SRC, "crypto", "aead.ts"), "utf8"))).toBe(true);
  });
});
