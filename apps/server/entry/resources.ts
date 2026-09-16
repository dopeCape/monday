// Where the compiled server finds the files it cannot embed: the Postgres binaries
// and the SQL migrations. In development they come from node_modules and the source
// tree; compiled (bun build --compile) they sit in a resources directory next to the
// executable, which the Tauri bundle ships as resources and the container image copies.
//
// Resolution order for each: MONDAY_RESOURCES_DIR, then <exe dir>/resources, then the
// development locations.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function exeDir(): string {
  return dirname(process.execPath);
}

function candidates(sub: string): string[] {
  const out: string[] = [];
  if (process.env.MONDAY_RESOURCES_DIR) out.push(join(process.env.MONDAY_RESOURCES_DIR, sub));
  out.push(join(exeDir(), "resources", sub));
  // macOS .app: Contents/MacOS/<exe> next to Contents/Resources
  out.push(join(exeDir(), "..", "Resources", sub));
  return out;
}

export interface PgBinaries {
  initdb: string;
  postgres: string;
  pg_ctl: string;
  /** The directory that holds bin/, lib/ and share/; needed for LD paths on Linux. */
  root: string;
}

const exe = process.platform === "win32" ? ".exe" : "";

function pgFrom(root: string): PgBinaries | null {
  const bin = join(root, "bin");
  const initdb = join(bin, `initdb${exe}`);
  if (!existsSync(initdb)) return null;
  return {
    root,
    initdb,
    postgres: join(bin, `postgres${exe}`),
    pg_ctl: join(bin, `pg_ctl${exe}`),
  };
}

/** Postgres binaries: resources/pg/{bin,lib,share} when compiled, the platform package in dev. */
export async function postgresBinaries(): Promise<PgBinaries> {
  for (const dir of candidates("pg")) {
    const found = pgFrom(dir);
    if (found) return found;
  }
  // Development: the platform package under apps/server/node_modules (Bun keeps
  // optional platform packages beside the package that declares them, not hoisted).
  // A compiled binary has no node_modules, so this branch simply finds nothing.
  const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  const dev = pgFrom(resolve(here, "..", "node_modules", "@embedded-postgres", platform, "native"));
  if (dev) return dev;
  throw new Error(
    `Postgres binaries not found. Looked in ${candidates("pg").join(", ")}. Set MONDAY_RESOURCES_DIR or install @embedded-postgres for this platform.`,
  );
}

/** The drizzle migrations folder: resources/drizzle when compiled, apps/server/drizzle in dev. */
export function migrationsFolder(): string {
  for (const dir of candidates("drizzle")) {
    if (existsSync(join(dir, "meta", "_journal.json"))) return dir;
  }
  const dev = resolve(here, "..", "drizzle");
  if (existsSync(join(dev, "meta", "_journal.json"))) return dev;
  throw new Error(
    `Migrations folder not found. Looked in ${candidates("drizzle").join(", ")} and ${dev}.`,
  );
}
