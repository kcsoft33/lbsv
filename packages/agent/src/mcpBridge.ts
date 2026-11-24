/**
 * stdio ⇄ HTTP bridge for the hub's MCP server (SPEC §9 "stdio"): for MCP clients that only
 * launch local commands (Claude Desktop). Every request is forwarded to <hub>/mcp with the MCP
 * token; nothing is cached or stored here. stdout is the protocol channel: log to stderr only.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolRequestSchema, ListResourceTemplatesRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export interface BridgeOptions {
  hub: string;
  token: string;
  version: string;
  /** Tests pass an in-memory transport; the CLI uses stdio. */
  transport?: Transport;
  log?: (s: string) => void;
}

export function mcpUrl(hub: string): URL {
  const u = new URL(hub.trim());
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Hub URL must start with http:// or https://");
  u.pathname = u.pathname.replace(/\/+$/, "") + "/mcp"; u.search = ""; u.hash = "";
  return u;
}

export async function runBridge(o: BridgeOptions): Promise<{ close(): Promise<void> }> {
  const log = o.log ?? ((s: string) => process.stderr.write(s + "\n"));
  const upstream = new Client({ name: "lbsv-agent-mcp-bridge", version: o.version });
  await upstream.connect(new StreamableHTTPClientTransport(mcpUrl(o.hub), { requestInit: { headers: { authorization: `Bearer ${o.token}` } } }));
  const info = upstream.getServerVersion();
  const server = new Server(
    { name: info?.name ?? "lbsv", version: info?.version ?? o.version, title: info?.title },
    { capabilities: { tools: {}, resources: {} }, instructions: upstream.getInstructions() },
  );
  server.setRequestHandler(ListToolsRequestSchema, (req) => upstream.listTools(req.params));
  server.setRequestHandler(CallToolRequestSchema, (req) => upstream.callTool(req.params));
  server.setRequestHandler(ListResourcesRequestSchema, (req) => upstream.listResources(req.params));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, (req) => upstream.listResourceTemplates(req.params));
  server.setRequestHandler(ReadResourceRequestSchema, (req) => upstream.readResource(req.params));
  await server.connect(o.transport ?? new StdioServerTransport());
  log(`lbsv MCP bridge → ${mcpUrl(o.hub).href} (${info?.name ?? "?"} ${info?.version ?? ""})`);
  return { close: async () => { await server.close(); await upstream.close(); } };
}
