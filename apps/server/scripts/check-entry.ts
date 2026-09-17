// Checks that a Cloud entry bundles for Node without reaching a Bun-only API
// (research 22, risk 8: the shared code runs on Bun and on Node 24). Bundles
// the entry with packages left external, then scans our own code in the
// output for `Bun.` and `bun:` references. Usage: bun scripts/check-entry.ts vercel|netlify

import { rmSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRIES: Record<string, string> = {
  vercel: "api/index.ts",
  netlify: "entry/netlify/api.ts",
  "netlify-tick": "entry/netlify/tick.ts",
};

async function check(name: string): Promise<boolean> {
  const entry = ENTRIES[name];
  if (!entry) throw new Error(`unknown entry ${name}; one of ${Object.keys(ENTRIES).join(", ")}`);
  const outdir = await mkdtemp(join(tmpdir(), `monday-check-${name}-`));
  try {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, "..", entry)],
      outdir,
      target: "node",
      format: "esm",
      packages: "external",
      sourcemap: "none",
    });
    if (!result.success) {
      for (const message of result.logs) console.error(String(message));
      return false;
    }
    let ok = true;
    for (const output of result.outputs) {
      const text = await readFile(output.path, "utf8");
      const hits = [...text.matchAll(/\bBun\.[a-zA-Z]+|["']bun:[a-z]+["']/g)].map((m) => m[0]);
      if (hits.length > 0) {
        ok = false;
        console.error(
          `${name}: Bun-only references in the bundle: ${[...new Set(hits)].join(", ")}`,
        );
      }
    }
    if (ok) console.log(`${name}: bundles for Node, no Bun-only references`);
    return ok;
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error("usage: bun scripts/check-entry.ts vercel|netlify|netlify-tick ...");
  process.exit(2);
}
let allOk = true;
for (const name of names) allOk = (await check(name)) && allOk;
process.exit(allOk ? 0 : 1);
