#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

/**
 * Local stdio entrypoint — for Claude Desktop, Cursor, Copilot CLI, etc.
 * Configure with your salon credentials in the environment (see .env.example).
 */
async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio servers must not write to stdout; logs go to stderr.
  console.error("salonrunner-mcp running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
