// A local (stdio) MCP server for tests: one tool that says which key and
// argument it was started with, so a test can tell the sealed input reached
// the process.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "whoami", description: "Says which key it runs with", inputSchema: { type: "object" } },
    { name: "echo", description: "Echoes its argument", inputSchema: { type: "object" } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "whoami") {
    const text = `key=${process.env.FIXTURE_KEY ?? ""} region=${process.argv[2] ?? ""}`;
    return { content: [{ type: "text", text }] };
  }
  return { content: [{ type: "text", text: JSON.stringify(request.params.arguments ?? {}) }] };
});
await server.connect(new StdioServerTransport());
