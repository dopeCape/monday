// The header line of the panel or column (docs/spec/agent-composer.md): the
// Runtime in use and the Workspace address. From the Session once one
// exists, from the Settings before that.

import type { HostedProvider, SessionSummary, Settings } from "@monday/shared";

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

export function runtimeLine(
  session: SessionSummary | null,
  settings: Pick<Settings, "ai.mode" | "ai.local.cli" | "ai.hosted.provider">,
  address: string,
): string {
  const runtime = session?.runtime;
  const label = runtime
    ? runtime.kind === "hosted"
      ? `${PROVIDER_LABEL[runtime.provider]} ${runtime.model}`
      : CLI_LABEL[runtime.cli]
    : settings["ai.mode"] === "local"
      ? CLI_LABEL[settings["ai.local.cli"]]
      : PROVIDER_LABEL[settings["ai.hosted.provider"]];
  return `${label} · ${address}`;
}
