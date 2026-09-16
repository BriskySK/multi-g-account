import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAccountTools } from "./tools-accounts.js";
import { registerCalendarTools } from "./tools-calendar.js";
import { registerGmailTools } from "./tools-gmail.js";
import type { Deps } from "./util.js";

/**
 * Builds a fresh McpServer instance with all tools registered.
 * The HTTP layer creates one per request (stateless Streamable HTTP mode).
 */
export function buildMcpServer(deps: Deps): McpServer {
  const server = new McpServer({
    name: "multi-g-account",
    version: "0.1.0",
  });
  registerAccountTools(server, deps);
  registerGmailTools(server, deps);
  registerCalendarTools(server, deps);
  return server;
}
