// Whether a remote MCP server signs in with OAuth: its protected-resource
// metadata says so, or, on a server written to the earlier spec (Atlassian's
// answers 401 with no resource_metadata), its authorization server's metadata
// sits at the site's root.

import { describe, expect, test } from "bun:test";
import { offersOAuth } from "../src/workflows/mcp-connections.ts";

const json = (value: unknown) => Response.json(value);
const missing = () => new Response("not found", { status: 404 });

describe("offersOAuth", () => {
  test("protected-resource metadata naming an authorization server", async () => {
    const fetchFn = async (url: string | URL) =>
      new URL(String(url)).pathname.startsWith("/.well-known/oauth-protected-resource")
        ? json({
            resource: "https://mcp.example.test/mcp",
            authorization_servers: ["https://auth.example.test"],
          })
        : missing();
    expect(await offersOAuth(new URL("https://mcp.example.test/mcp"), fetchFn)).toBe(true);
  });

  test("no resource metadata, but authorization server metadata at the root", async () => {
    const fetchFn = async (url: string | URL) =>
      new URL(String(url)).pathname === "/.well-known/oauth-authorization-server"
        ? json({
            issuer: "https://mcp.example.test",
            authorization_endpoint: "https://mcp.example.test/authorize",
            token_endpoint: "https://mcp.example.test/token",
            response_types_supported: ["code"],
          })
        : missing();
    expect(await offersOAuth(new URL("https://mcp.example.test/v1/sse"), fetchFn)).toBe(true);
  });

  test("neither: no OAuth on offer", async () => {
    expect(await offersOAuth(new URL("https://mcp.example.test/mcp"), async () => missing())).toBe(
      false,
    );
  });
});
