---
status: accepted
---

# Approvals live inside monday's tools, and the Agent sees only those tools

The Agent can run on Claude Code, Codex, OpenCode or a Hosted runtime, and each of those has its own permission system with different shapes. We decided that monday's tools are served once, over a loopback MCP server, and that every approval is enforced inside the tool implementation before it acts, not in the runtime's permission layer. Each runtime's built-in tools (shell, file edits, web search) are stripped by its adapter, so the Agent sees exactly monday's tool set everywhere, and mail content, which is untrusted, can never reach the user's shell. A per-session Developer mode may re-enable the runtime's built-ins after an explicit warning.

## Considered options

- Use each runtime's native approval hook (canUseTool, requestApproval, permission.asked). Rejected: four different UIs and semantics, and Codex's headless surfaces have no hook at all.
- Let runtimes keep their built-in tools. Rejected: behavior would differ per runtime, and a prompt injection in an email could run commands.

## Consequences

- Tool tiers are fixed per tool: always-ask (leaves the mailbox or reaches a third party), reversible (apply with Undo), read-only (silent). Users can promote a tool to always-ask but never demote one.
- The runtime's own permission system is used for one thing: denying everything that is not a monday tool.
- The same tool server is what Hosted runtime calls hit, so Workflows on the Server get identical semantics, including standing approvals per Workflow step.
