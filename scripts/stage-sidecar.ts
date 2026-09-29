// Builds the server as the Tauri sidecar and stages its resources.
// Usage: bun scripts/stage-sidecar.ts [--target <rust-triple>]
// Output: apps/desktop/src-tauri/binaries/monday-server-<triple>
//         apps/desktop/src-tauri/resources/{pg,drizzle,server-build}
//
// server-build is the compiled binary's hash: the app compares it with the
// running background service's build and replaces an older one (ADR 0013).

import { createHash } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const root = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
const targetIdx = args.indexOf("--target");
const rustTriple = targetIdx >= 0 ? (args[targetIdx + 1] ?? "") : hostTriple();

const bunTargets: Record<string, string> = {
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
};
const pgPackages: Record<string, string> = {
  "x86_64-unknown-linux-gnu": "linux-x64",
  "aarch64-unknown-linux-gnu": "linux-arm64",
  "x86_64-apple-darwin": "darwin-x64",
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-pc-windows-msvc": "windows-x64",
};

function hostTriple(): string {
  const os = process.platform;
  const arch = process.arch;
  if (os === "linux") return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  if (os === "darwin") return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  if (os === "win32") return "x86_64-pc-windows-msvc";
  throw new Error(`unsupported host ${os}/${arch}`);
}

const bunTarget = bunTargets[rustTriple];
const pgPackage = pgPackages[rustTriple];
if (!bunTarget || !pgPackage) throw new Error(`unknown target ${rustTriple}`);

const tauri = join(root, "apps/desktop/src-tauri");
const exe = rustTriple.includes("windows") ? ".exe" : "";
const out = join(tauri, "binaries", `monday-server-${rustTriple}${exe}`);
mkdirSync(join(tauri, "binaries"), { recursive: true });

// A Sidecar started from this very file (by hand, or before ADR 0013) holds it
// open for execution; say so instead of failing with a bare "Text file busy".
if (existsSync(out)) {
  try {
    closeSync(openSync(out, "r+"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ETXTBSY" || code === "EBUSY") {
      console.error(
        [
          `monday's Sidecar is running from ${out}, so it cannot be replaced.`,
          "Stop it first, then stage again:",
          "  systemctl --user stop monday-sidecar      (Linux with systemd)",
          `  ${out} stop`,
          "  or Settings > Sync server > Background service > Stop",
          "See docs/dev/sidecar.md.",
        ].join("\n"),
      );
      process.exit(1);
    }
    throw error;
  }
}

console.log(`compiling server for ${bunTarget}`);
// --smol: Bun collects garbage sooner and keeps a smaller heap; the Sidecar
// runs all day beside the app, where memory matters more than peak speed.
// On Windows the service has no console window (it starts at login from the Run key).
const hideConsole = rustTriple.includes("windows") ? ["--windows-hide-console"] : [];
await $`bun build --compile --compile-exec-argv=--smol ${hideConsole} --target=${bunTarget} ${join(root, "apps/server/entry/bun.ts")} --outfile ${out}`.cwd(
  root,
);

const pgSrc = join(root, "apps/server/node_modules/@embedded-postgres", pgPackage, "native");
if (!existsSync(pgSrc)) throw new Error(`postgres binaries for ${pgPackage} not installed at ${pgSrc}`);
const res = join(tauri, "resources");
rmSync(res, { recursive: true, force: true });
mkdirSync(res, { recursive: true });
cpSync(pgSrc, join(res, "pg"), { recursive: true });
cpSync(join(root, "apps/server/drizzle"), join(res, "drizzle"), { recursive: true });
const build = createHash("sha256").update(readFileSync(out)).digest("hex").slice(0, 16);
writeFileSync(join(res, "server-build"), `${build}\n`);
console.log(`staged ${out} and ${res}/{pg,drizzle,server-build} (build ${build})`);
