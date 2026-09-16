# External MCP server

monday exposes its tools to other agents. This is the second transport on the Agent host seam (ADR 0009); the tools, Tiers and approvals are the ones from ADR 0002.

## Tools exposed

- The same tool set the internal Agent uses, filtered by the credential's scope. Read scope exposes read-only tools; act scope adds reversible and always-ask tools.
- Always-ask tools called from outside still ask: the approval card appears in the monday client of the owner with the caller's name, and the external call blocks until answered or times out after a Setting (default 5 minutes). If no client is open, the call returns a pending status and the approval waits in the Agent's pending items with a desktop notification.
- Every external call is written to the Activity log with the credential name as the actor.

## Where it listens

- Sidecar: streamable HTTP on loopback plus a stdio launcher (`monday mcp`) for local clients such as Claude Code, Codex and OpenCode. The launcher connects to the running Sidecar; it never starts a second server.
- Cloud: streamable HTTP at `/mcp` on the Server URL over HTTPS, for remote agents.

## Auth

Two credential types, both separate from Device tokens (ADR 0006).

- **Key.** Created in Settings › AI › External access: name, scope (read or act), Workspaces (one, several or all), expiry (default 90 days, never allowed), and shown once with a copy button. Revocable from the list, which shows last use. The Agent can create a key when asked ("make a read-only key for my assistant") through a reversible tool that shows the key once in a card.
- **Interactive.** OAuth 2.1 with PKCE and dynamic client registration, which is what the MCP specification expects from remote servers. The client is sent to a consent page served by the Server (or the Sidecar's pairing UI) that names the client, the requested scope and Workspaces; the owner approves from an open monday client or by pairing code. The result is a token with the same scope model as a key, listed in the same place.

## Limits

- Per credential: 60 calls per minute by default, a Setting. Search results capped at 50 per call. Bodies returned are limited to the Cache and Server policy the internal Agent sees.
- Developer mode never applies to external callers.
