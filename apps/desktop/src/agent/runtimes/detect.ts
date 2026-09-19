// Detection of the Local runtimes on this Device (docs/spec/settings.md,
// "the detected CLIs and their status"): whether each binary runs, which
// version it is, and whether it is logged in where the CLI says so. Each
// check is one short command the capability allows by name; monday never
// reads a credential file. The reasons are the Settings strings, so the
// composer header and the AI settings page say the same thing.

import type { LocalCli, RuntimeStatus } from "@monday/shared";
import { type ProcessRunner, runToEnd } from "./process.ts";
import { CLI_LABEL, spawnTarget } from "./session.ts";

export interface DetectStrings {
  notInstalled: string;
  notLoggedIn: string;
}

export interface DetectOptions {
  runner: ProcessRunner;
  /** ai.local.path.<cli> per CLI. */
  commands: Record<LocalCli, string>;
  strings: DetectStrings;
  timeoutMs?: number | undefined;
}

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");

/** The first version-looking token of a `--version` line, such as "2.1.223" from "2.1.223 (Claude Code)". */
export function versionOf(output: string): string | null {
  const m = /(\d+\.\d+(?:\.\d+)?(?:[-+.][\w.]+)?)/.exec(output);
  return m?.[1] ?? null;
}

/** `claude auth status` prints JSON with `loggedIn`; older builds print prose. */
export function claudeLoggedIn(output: string): boolean | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { loggedIn?: unknown };
    if (typeof parsed.loggedIn === "boolean") return parsed.loggedIn;
  } catch {
    // Not JSON; fall through to the words.
  }
  if (/not logged in|logged out/i.test(trimmed)) return false;
  if (/logged in/i.test(trimmed)) return true;
  return null;
}

/** `codex login status` prints "Logged in using ChatGPT" or "Not logged in". */
export function codexLoggedIn(output: string, code: number | null): boolean | null {
  if (/not logged in/i.test(output)) return false;
  if (/logged in/i.test(output)) return true;
  return code === 0 ? true : null;
}

/** `opencode auth list` lists credentialed providers; an empty list means nothing to run on. */
export function opencodeLoggedIn(output: string): boolean | null {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  return lines.some((l) => !/no credentials|nothing|^\W*$/i.test(l));
}

export async function detectRuntime(cli: LocalCli, options: DetectOptions): Promise<RuntimeStatus> {
  const command = options.commands[cli];
  const target = spawnTarget(cli === "claude-code" ? "claude" : cli, command);
  const pathPrefix = target.pathPrefix;
  const label = CLI_LABEL[cli];
  const version = await runToEnd(options.runner, `${target.name}-version`, ["--version"], {
    pathPrefix,
    timeoutMs: options.timeoutMs,
  });
  if (version.failed !== null || version.code !== 0) {
    return {
      cli,
      command,
      installed: false,
      version: null,
      loggedIn: null,
      reason: fill(options.strings.notInstalled, { runtime: label }),
    };
  }
  const check =
    cli === "claude-code"
      ? { name: "claude-auth", args: ["auth", "status"] }
      : cli === "codex"
        ? { name: "codex-login", args: ["login", "status"] }
        : { name: "opencode-auth", args: ["auth", "list"] };
  const auth = await runToEnd(options.runner, check.name, check.args, {
    pathPrefix,
    timeoutMs: options.timeoutMs,
  });
  const output = `${auth.stdout}\n${auth.stderr}`;
  const loggedIn =
    auth.failed !== null
      ? null
      : cli === "claude-code"
        ? claudeLoggedIn(auth.stdout)
        : cli === "codex"
          ? codexLoggedIn(output, auth.code)
          : opencodeLoggedIn(auth.stdout);
  return {
    cli,
    command,
    installed: true,
    version: versionOf(version.stdout || version.stderr),
    loggedIn,
    reason: loggedIn === false ? fill(options.strings.notLoggedIn, { runtime: label }) : null,
  };
}

export async function detectRuntimes(
  options: DetectOptions,
): Promise<Record<LocalCli, RuntimeStatus>> {
  const [claude, codex, opencode] = await Promise.all([
    detectRuntime("claude-code", options),
    detectRuntime("codex", options),
    detectRuntime("opencode", options),
  ]);
  return { "claude-code": claude, codex, opencode };
}
