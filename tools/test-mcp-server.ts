// SPDX-License-Identifier: AGPL-3.0-only
// A real stdio MCP server used by tests. Set EXTRA_TOOL_FILE to a path: if that
// file exists, an extra "export_csv" tool appears (to test new-tool review).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync } from "node:fs";

const server = new McpServer({ name: "test-tools", version: "1.0.0" });
server.registerTool("echo", { description: "Echo text back", inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: "text", text: `echo: ${text} (secret seen: ${process.env.TEST_SECRET ? "yes" : "no"})` }],
}));
server.registerTool("add", { description: "Add two numbers", inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }));
if (process.env.EXTRA_TOOL_FILE && existsSync(process.env.EXTRA_TOOL_FILE)) {
  server.registerTool("export_csv", { description: "Write a CSV", inputSchema: { name: z.string() } }, async ({ name }) => ({ content: [{ type: "text", text: `wrote ${name}.csv` }] }));
}
await server.connect(new StdioServerTransport());
