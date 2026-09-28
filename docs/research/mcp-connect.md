# Connecting MCP servers: registry, authorization, SDK

Research for "Connect a tool" (docs/spec/settings.md, "MCP servers"). Primary sources only, checked live on 2026-09-28.

## 1. The official MCP Registry

- Production `https://registry.modelcontextprotocol.io`, docs at [/docs](https://registry.modelcontextprotocol.io/docs), [openapi.yaml](https://registry.modelcontextprotocol.io/openapi.yaml). The [API changelog](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/CHANGELOG.md) (2025-10-17): "`/v0.1/` will remain stable with only additive, backward-compatible changes"; production clients should use `/v0.1/`.
- `GET /v0.1/servers?search=&limit=&cursor=&version=latest&updated_since=`. `limit` 1 to 100 (default 30). `search` is a "case-insensitive substring search on server names … intentionally simple" ([API reference](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/official-registry-api.md)). `GET /v0.1/servers/{name}/versions/latest` for one entry (name URL-encoded).
- Envelope: `{servers: [{server: <server.json>, _meta: {"io.modelcontextprotocol.registry/official": {status, isLatest, publishedAt, updatedAt}}}], metadata: {nextCursor, count}}`.
- `server.json` ([schema 2025-12-11](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json)): `name` (reverse DNS, one slash), `title`, `description`, `version`, `websiteUrl`, `repository`, `icons[]`.
  - `remotes[]`: `{type: "streamable-http" | "sse", url, headers?: [{name, description, isRequired, isSecret, value?, variables?}], variables?}`; the URL may hold `{var}` templates.
  - `packages[]`: `{registryType: npm | pypi | oci | nuget | mcpb, identifier, version, runtimeHint: npx | uvx | docker | dnx, transport: {type: "stdio"} | {type: "streamable-http", url}, runtimeArguments[], packageArguments[], environmentVariables[]}`. Inputs carry `isRequired`, `isSecret`, `default`, `choices`, `format`; an input with `value` is not for the user to fill, except its `{variables}`.
- No documented rate limit; responses carry `x-registry-cache`. The registry is **in preview** ("breaking changes or data resets may occur").
- Live use from hosts: the [about page](https://modelcontextprotocol.io/registry/about) says the registry "is intended to be consumed primarily by downstream aggregators" and "is not intended to be directly consumed by host applications"; host apps should consume a subregistry "conforming to the official MCP Registry's OpenAPI spec". The [aggregator guide](https://modelcontextprotocol.io/registry/registry-aggregators) says it gives "no uptime or data durability guarantees".
  - **Consequence for monday:** the registry base URL is a Setting (any subregistry with the same OpenAPI works), queries go through the Server with a short cache, and search degrades to "Add by URL / Add by command" when it is down.
- Name search is noisy: "github" and "notion" return `ai.smithery/*` proxies (remote plus a Smithery key) first. Other catalogs: Smithery, PulseMCP, Glama and the [GitHub MCP Registry](https://github.com/mcp) (which feeds VS Code) curate on top of the official one, which calls itself the unopinionated upstream.

## 2. MCP authorization (current revision 2026-07-28, SDK speaks 2025-11-25)

Pages: [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) (split into discovery, client registration, security), [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization).

- **Protected Resource Metadata (RFC 9728).** Use `resource_metadata` from the 401's `WWW-Authenticate` when present, else `/.well-known/oauth-protected-resource/<path>` then `/.well-known/oauth-protected-resource`.
- **Authorization server metadata.** RFC 8414 and OIDC discovery, in the spec's order: `oauth-authorization-server`, then `openid-configuration`, path-inserted before path-appended. 2026-07-28 requires `issuer` to equal the identifier used.
- **Client registration**, in order:
  1. Pre-registered.
  2. Client ID Metadata Documents, when the authorization server says `client_id_metadata_document_supported`. The client id is an https URL.
  3. Dynamic Client Registration (RFC 7591), which 2026-07-28 deprecates for new implementations but servers still widely offer. Native apps set `application_type: "native"`.
  4. Ask the user.
- **PKCE** with S256 is a MUST; refuse when support is not advertised.
- **`resource` (RFC 8707)** is a MUST in the authorize and token requests: the server's canonical URI.
- **Scope:** the 401's `scope`, else `scopes_supported`, else none. A 403 `insufficient_scope` means step up.
- **Refresh:** ask for `refresh_token` in `grant_types`; never assume one is issued; public clients get rotated refresh tokens.
- **RFC 9207 `iss` check** on the callback (new in 2026-07-28). Verify `state`.
- **Redirects** must be localhost or https. Native apps use loopback (`http://127.0.0.1:<port>/callback`, OAuth 2.1 native apps section).

## 3. What the TypeScript SDK (1.30.0, as installed) already does

- `OAuthClientProvider` (`client/auth.d.ts`):
  - `redirectUrl`, `clientMetadata`, `clientInformation`/`saveClientInformation`, `tokens`/`saveTokens`, `redirectToAuthorization`, `saveCodeVerifier`/`codeVerifier`.
  - Optional: `state`, `clientMetadataUrl` (CIMD), `invalidateCredentials`, `discoveryState`/`saveDiscoveryState`, `validateResourceURL`.
- `auth(provider, {serverUrl, authorizationCode?, scope?, resourceMetadataUrl?, fetchFn?})` returns `"AUTHORIZED" | "REDIRECT"`. It runs PRM discovery, authorization server discovery, CIMD or DCR, PKCE and the resource parameter. A second call with `authorizationCode` exchanges the code; it needs the same `redirectUrl`, the saved client and the saved verifier.
- `StreamableHTTPClientTransport({authProvider})` sends `tokens().access_token`. On a 401 it calls `auth()`, which refreshes when a `refresh_token` exists and otherwise asks for a redirect (the transport then throws `UnauthorizedError`). It steps up on a 403 `insufficient_scope`.
  - There is **no proactive refresh** (no `expires_in` handling): refresh happens on the 401.
- Gaps monday covers itself:
  - The SDK never checks `state` or `iss`: the callback route does.
  - DCR's `redirect_uris` must match the loopback URI used, so a new port means registering again.
  - A background call must not overwrite an in-flight sign-in's verifier.

## 4. How good clients present it

- **Claude** ([custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)): a directory plus "add by URL"; Connect opens OAuth in the browser; tools toggle per conversation.
- **Cursor** ([MCP docs](https://cursor.com/docs/context/mcp)): a directory with one-click install; OAuth with a fixed localhost callback; secrets as `${env:NAME}`; tool calls approved by default.
- **VS Code** ([MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)): `@mcp` in Extensions searches a gallery backed by the GitHub MCP Registry; secrets are prompted as input variables; "Configure Tools" toggles each tool.
- **The pattern:**
  1. Search.
  2. One card per server (icon, title, publisher, one line, remote or local).
  3. Connect, which either opens the browser for OAuth or asks only for the declared inputs, with secrets masked.
  4. The discovered tools, each with a toggle, and a status with reconnect.
