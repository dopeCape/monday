// pg_dump for the upgrade export (ADR 0008). The embedded Postgres ships
// initdb, pg_ctl and postgres; pg_dump rides along in the bundled resources
// when the build includes it, and a pg_dump on PATH does as well. Custom
// format (-Fc) so pg_restore can reorder and skip; no owners or ACLs so the
// Cloud's role can restore it. Node APIs only; entry-only.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { type PgBinaries, postgresBinaries } from "./resources.ts";

const exe = process.platform === "win32" ? ".exe" : "";

/** The pg_dump binary beside the embedded Postgres, else on PATH, else null. */
export async function findPgDump(): Promise<{ path: string; lib: string | null } | null> {
  let bin: PgBinaries | null = null;
  try {
    bin = await postgresBinaries();
  } catch {
    bin = null;
  }
  if (bin) {
    const beside = join(bin.root, "bin", `pg_dump${exe}`);
    if (existsSync(beside)) return { path: beside, lib: join(bin.root, "lib") };
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, `pg_dump${exe}`);
    if (existsSync(candidate)) return { path: candidate, lib: null };
  }
  return null;
}

/** Runs pg_dump of `sourceUrl` into `path`; resolves with the file size. */
export function pgDump(binary: {
  path: string;
  lib: string | null;
}): (sourceUrl: string, path: string) => Promise<number> {
  return async (sourceUrl, path) => {
    await mkdir(dirname(path), { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (binary.lib && process.platform === "linux") {
      env.LD_LIBRARY_PATH = [binary.lib, env.LD_LIBRARY_PATH].filter(Boolean).join(":");
    }
    if (binary.lib && process.platform === "darwin") {
      env.DYLD_LIBRARY_PATH = [binary.lib, env.DYLD_LIBRARY_PATH].filter(Boolean).join(":");
    }
    await new Promise<void>((resolve, reject) => {
      const p = spawn(
        binary.path,
        ["--format=custom", "--no-owner", "--no-acl", `--file=${path}`, `--dbname=${sourceUrl}`],
        { env, stdio: ["ignore", "ignore", "pipe"] },
      );
      let err = "";
      p.stderr.on("data", (d) => {
        err += String(d);
      });
      p.on("error", reject);
      p.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`pg_dump exited ${code}: ${err.trim()}`)),
      );
    });
    return (await stat(path)).size;
  };
}
