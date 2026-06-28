import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import { SalonRunnerClient } from "./salonrunner/client.js";
import { registerTools } from "./tools/index.js";

/** One authenticated SalonRunner session, reused across MCP requests. */
export function createClient(): SalonRunnerClient {
  return new SalonRunnerClient(loadConfig());
}

/** Build a fully-wired MCP server (shared by the stdio and HTTP entrypoints). */
export function createServer(client: SalonRunnerClient = createClient()): McpServer {
  const server = new McpServer({ name: "salonrunner-mcp", version: "0.1.0" });
  registerTools(server, client);
  return server;
}
