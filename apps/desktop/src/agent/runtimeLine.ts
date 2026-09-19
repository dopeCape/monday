// The header line of the panel or column (docs/spec/agent-composer.md): the
// Runtime in use, the model answering when it is known, and the Workspace
// address. From the Session once one exists, from the Settings before that.
// Also the Runtime the Settings ask for, which the composer compares with
// the Session's to switch it mid-Session.

import type { HostedProvider, Runtime, RuntimeInfo, Settings } from "@monday/shared";
import { resolveTaskModel } from "@monday/shared";

const PROVIDER_LABEL: Record<HostedProvider, string> = {
  anthropic: "Anthropic",
  gemini: "Gemini",
  openai: "OpenAI",
  kimi: "Kimi",
  openrouter: "OpenRouter",
};

const CLI_LABEL: Record<Settings["ai.local.cli"], string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export type RuntimeSettings = Pick<
  Settings,
  | "ai.mode"
  | "ai.local.cli"
  | "ai.hosted.provider"
  | "ai.local.model.claude-code"
  | "ai.local.model.codex"
  | "ai.local.model.opencode"
>;

/** "Claude Code (claude-opus-5)" or "Anthropic claude-sonnet-5". */
export function runtimeLabel(runtime: Runtime, model: string | null = null): string {
  if (runtime.kind === "hosted") return `${PROVIDER_LABEL[runtime.provider]} ${runtime.model}`;
  const known = model ?? runtime.model ?? null;
  return known ? `${CLI_LABEL[runtime.cli]} (${known})` : CLI_LABEL[runtime.cli];
}

export function runtimeLine(
  info: RuntimeInfo | null,
  settings: RuntimeSettings,
  address: string,
): string {
  const label = info
    ? runtimeLabel(info.runtime, info.model)
    : settings["ai.mode"] === "local"
      ? runtimeLabel({ kind: "local", cli: settings["ai.local.cli"] }, null)
      : PROVIDER_LABEL[settings["ai.hosted.provider"]];
  return `${label} · ${address}`;
}

/** The Runtime the Settings ask for: the Local CLI, or the Hosted provider with the composer's model. */
export function desiredRuntime(settings: Settings): Runtime {
  if (settings["ai.mode"] === "local") {
    const cli = settings["ai.local.cli"];
    const model = settings[`ai.local.model.${cli}`];
    return { kind: "local", cli, ...(model ? { model } : {}) };
  }
  const choice = resolveTaskModel(settings, "composer");
  return { kind: "hosted", provider: choice.provider, model: choice.model };
}

/** Whether two Runtimes are the same place to send a turn (a model name learned later does not count). */
export function sameRuntime(a: Runtime, b: Runtime): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "local" && b.kind === "local") return a.cli === b.cli;
  if (a.kind === "hosted" && b.kind === "hosted") return a.provider === b.provider;
  return false;
}
