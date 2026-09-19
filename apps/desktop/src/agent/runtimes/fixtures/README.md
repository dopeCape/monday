# Recorded CLI streams

What each Local runtime really prints, so the adapters are tested against
the exact bytes without the CLI installed.

- `claude-code.stream.jsonl`: `claude -p --input-format stream-json --output-format stream-json --include-partial-messages --tools "" --strict-mcp-config --mcp-config <monday> --setting-sources "" --permission-mode dontAsk --allowedTools mcp__monday`, Claude Code 2.1.223, one turn ("archive every newsletter older than a week") against a fake monday MCP server. Recorded on 2026-09-19; the machine's paths and the CLI's menus were removed from the init line.
- `codex.app-server.jsonl` and `codex.sent.jsonl`: `codex app-server`, Codex 0.146.0, the same turn over JSON-RPC with the built-ins off in the thread config; `sent` is what monday wrote on stdin, in order. Codex asked before running the non-read-only MCP tool (`mcpServer/elicitation/request`) and monday accepted, since the approval lives inside the tool. Recorded on 2026-09-19.
- `opencode.acp.jsonl`: `opencode acp`, Agent Client Protocol v1. OpenCode was not installed on the recording machine; the lines follow the ACP v1 schema (`session/update`, `session/request_permission`, the prompt's `stopReason`) and OpenCode's documented `monday_<tool>` naming. Treat it as the expected shape, not a recording.
