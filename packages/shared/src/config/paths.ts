// Where monday.toml lives, per platform (ADR 0001). Pure functions over an
// environment snapshot so the desktop app, the server and tests share one rule.
//
// Precedence:
//   1. MONDAY_CONFIG, when set, is the file. Nothing else is consulted.
//   2. $XDG_CONFIG_HOME/monday/monday.toml, else ~/.config/monday/monday.toml,
//      wins on every platform when it exists (rices and dotfiles put it there).
//   3. The platform's native location: the same path on Linux,
//      ~/Library/Application Support/monday/monday.toml on macOS,
//      %APPDATA%\monday\monday.toml on Windows.
// When no candidate exists, the last candidate is where a new file would go.

export type Platform = "linux" | "macos" | "windows";

export interface PathEnv {
  MONDAY_CONFIG?: string | undefined;
  XDG_CONFIG_HOME?: string | undefined;
  HOME?: string | undefined;
  APPDATA?: string | undefined;
  /** Windows fallback for HOME. */
  USERPROFILE?: string | undefined;
}

export const CONFIG_FILE_NAME = "monday.toml";
export const CONFIG_DIR_NAME = "monday";

function sep(platform: Platform): string {
  return platform === "windows" ? "\\" : "/";
}

function join(platform: Platform, ...parts: string[]): string {
  const s = sep(platform);
  return parts
    .filter((p) => p !== "")
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")))
    .join(s);
}

function home(platform: Platform, env: PathEnv): string | undefined {
  const value = env.HOME || (platform === "windows" ? env.USERPROFILE : undefined);
  return value ? value : undefined;
}

/** Expand a leading `~/` or `~\` against HOME. Other paths are returned as given. */
export function expandHome(platform: Platform, env: PathEnv, path: string): string {
  if (path === "~") return home(platform, env) ?? path;
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    const h = home(platform, env);
    return h ? join(platform, h, path.slice(2)) : path;
  }
  return path;
}

/** The XDG-style path, honored on every platform. */
export function xdgConfigPath(platform: Platform, env: PathEnv): string | undefined {
  if (env.XDG_CONFIG_HOME) {
    return join(
      platform,
      expandHome(platform, env, env.XDG_CONFIG_HOME),
      CONFIG_DIR_NAME,
      CONFIG_FILE_NAME,
    );
  }
  const h = home(platform, env);
  return h ? join(platform, h, ".config", CONFIG_DIR_NAME, CONFIG_FILE_NAME) : undefined;
}

/** The platform's native location. */
export function nativeConfigPath(platform: Platform, env: PathEnv): string | undefined {
  switch (platform) {
    case "linux":
      return xdgConfigPath(platform, env);
    case "macos": {
      const h = home(platform, env);
      return h
        ? join(platform, h, "Library", "Application Support", CONFIG_DIR_NAME, CONFIG_FILE_NAME)
        : undefined;
    }
    case "windows": {
      if (env.APPDATA) return join(platform, env.APPDATA, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
      const h = home(platform, env);
      return h
        ? join(platform, h, "AppData", "Roaming", CONFIG_DIR_NAME, CONFIG_FILE_NAME)
        : undefined;
    }
  }
}

/** Every place the file may be, in precedence order, without duplicates. */
export function configCandidates(platform: Platform, env: PathEnv): string[] {
  if (env.MONDAY_CONFIG) return [expandHome(platform, env, env.MONDAY_CONFIG)];
  const out: string[] = [];
  for (const candidate of [xdgConfigPath(platform, env), nativeConfigPath(platform, env)]) {
    if (candidate && !out.includes(candidate)) out.push(candidate);
  }
  return out;
}

export interface ResolvedConfigPath {
  /** The file to read, or where to create one. */
  path: string;
  /** Whether `path` exists according to the caller's probe. */
  exists: boolean;
}

/**
 * Pick the config path: the first existing candidate, else the last candidate
 * (the platform's native location) as the place a new file would be created.
 * `exists` is the caller's filesystem probe; this module touches no filesystem.
 */
export function resolveConfigPath(
  platform: Platform,
  env: PathEnv,
  exists: (path: string) => boolean,
): ResolvedConfigPath | undefined {
  const candidates = configCandidates(platform, env);
  for (const candidate of candidates) {
    if (exists(candidate)) return { path: candidate, exists: true };
  }
  const fallback = candidates.at(-1);
  return fallback ? { path: fallback, exists: false } : undefined;
}
