// The Local runtimes (CONTEXT.md, Local runtime; slice 15): the three
// adapters behind the AgentSession seam, their detection, and the settings
// they read. A Device picks one by `ai.local.cli`, spawns it through the
// platform's shell scope, and points it at monday's MCP server on the
// Sidecar's loopback port, so tiers, approvals and the Activity log are
// exactly the Hosted runtime's (ADR 0002).

import type { AgentSession, LocalCli, Settings } from "@monday/shared";
import { createClaudeCodeSession } from "./claudeCode.ts";
import { createCodexSession } from "./codex.ts";
import { createOpencodeSession } from "./opencode.ts";
import { CLI_LABEL, type LocalRuntimeDeps, type LocalRuntimeSettings } from "./session.ts";

export { createClaudeCodeSession } from "./claudeCode.ts";
export { createCodexSession } from "./codex.ts";
export { detectRuntime, detectRuntimes } from "./detect.ts";
export { apiSessionLink, type SessionLink } from "./link.ts";
export { createOpencodeSession } from "./opencode.ts";
export { fakeProcessRunner, type ProcessRunner } from "./process.ts";
export {
  CLI_LABEL,
  type LocalRuntimeDeps,
  type LocalRuntimeSettings,
  type McpEndpoint,
} from "./session.ts";

export function createLocalSession(cli: LocalCli, deps: LocalRuntimeDeps): AgentSession {
  switch (cli) {
    case "claude-code":
      return createClaudeCodeSession(deps);
    case "codex":
      return createCodexSession(deps);
    case "opencode":
      return createOpencodeSession(deps);
  }
}

/** The Settings one Local runtime reads, keyed per CLI in the schema. */
export function localRuntimeSettings(settings: Settings, cli: LocalCli): LocalRuntimeSettings {
  return {
    command: settings[`ai.local.path.${cli}`],
    model: settings[`ai.local.model.${cli}`],
    toolTimeoutSeconds: settings["ai.local.tool_timeout_seconds"],
    systemPrompt: settings["agent.system_prompt"],
  };
}

/** The loopback endpoint the CLIs are pointed at, from what the Tauri host said about the Sidecar. */
export function mcpEndpointOf(sidecar: { port: number; token: string }) {
  return { url: `http://127.0.0.1:${sidecar.port}/mcp/local`, token: sidecar.token };
}

export function cliLabel(cli: LocalCli): string {
  return CLI_LABEL[cli];
}
