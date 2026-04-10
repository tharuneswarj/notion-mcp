/**
 * Notion MCP Server - Cloudflare Worker Entry Point
 *
 * Serves MCP (Model Context Protocol) over Streamable HTTP for multiple
 * Notion workspaces under a single deployment at mcp.tha.run.
 *
 * URL structure:
 *   POST /notion/personal/mcp  → Personal workspace
 *   POST /notion/koodu/mcp     → Koodu Architecture workspace
 *   POST /notion/waves/mcp     → Waves Company workspace
 *
 * Protocol: MCP over Streamable HTTP (stateless JSON mode)
 *   - Each POST contains a JSON-RPC 2.0 message
 *   - Server responds with JSON-RPC 2.0 response
 *   - No sessions, no SSE - pure request/response
 */

import type { Env, WorkspaceId, JsonRpcRequest, JsonRpcResponse } from "./types.js";
import { NotionClient } from "./notion.js";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "notion-mcp-server";
const SERVER_VERSION = "2.1.0";

// ═══════════════════════════════════════════════════════════════════════════════
// WORKER ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return corsResponse(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === "/" || path === "/health") {
      return corsResponse(
        jsonResponse({
          status: "ok",
          server: SERVER_NAME,
          version: SERVER_VERSION,
          workspaces: ["personal", "koodu", "waves"],
        })
      );
    }

    // Parse workspace from path: /notion/{workspace}/mcp
    const match = path.match(/^\/notion\/(personal|koodu|waves)\/mcp$/);
    if (!match) {
      return corsResponse(
        jsonResponse(
          {
            error: "Not found",
            hint: "Valid endpoints: /notion/personal/mcp, /notion/koodu/mcp, /notion/waves/mcp",
          },
          404
        )
      );
    }

    const workspace = match[1] as WorkspaceId;

    // ─── Auth ─────────────────────────────────────────────────────────────
    const authError = validateAuth(request, env);
    if (authError) {
      return corsResponse(authError);
    }

    // ─── Resolve Notion token ─────────────────────────────────────────────
    const token = getNotionToken(env, workspace);
    if (!token) {
      return corsResponse(
        jsonResponse(
          {
            error: `Workspace "${workspace}" is not configured. Set the NOTION_TOKEN_${workspace.toUpperCase()} secret.`,
          },
          503
        )
      );
    }

    // ─── Handle MCP request ───────────────────────────────────────────────
    if (request.method === "GET") {
      // SSE endpoint - not supported in stateless mode
      return corsResponse(
        jsonResponse(
          {
            error: "This server operates in stateless mode. Use POST for all MCP requests.",
          },
          405
        )
      );
    }

    if (request.method !== "POST") {
      return corsResponse(
        jsonResponse({ error: "Method not allowed. Use POST." }, 405)
      );
    }

    try {
      const body = await request.json();
      const client = new NotionClient(token, env.NOTION_API_VERSION);

      // Handle batch requests (array of JSON-RPC messages)
      if (Array.isArray(body)) {
        const responses: JsonRpcResponse[] = [];
        for (const msg of body) {
          const resp = await handleJsonRpc(msg as JsonRpcRequest, client, workspace);
          if (resp) responses.push(resp);
        }
        return corsResponse(jsonResponse(responses));
      }

      // Handle single request
      const response = await handleJsonRpc(body as JsonRpcRequest, client, workspace);
      if (response) {
        return corsResponse(jsonResponse(response));
      }

      // Notification (no id) - return 202 Accepted
      return corsResponse(new Response(null, { status: 202 }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return corsResponse(
        jsonResponse(
          jsonRpcError(null, -32700, `Parse error: ${message}`),
          400
        )
      );
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// MCP JSON-RPC HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

async function handleJsonRpc(
  msg: JsonRpcRequest,
  client: NotionClient,
  workspace: WorkspaceId
): Promise<JsonRpcResponse | null> {
  const { method, params, id } = msg;

  // Notifications (no id) don't get a response
  if (id === undefined || id === null) {
    return null;
  }

  switch (method) {
    // ─── Initialize ─────────────────────────────────────────────────────
    case "initialize":
      return jsonRpcSuccess(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: `${SERVER_NAME}-${workspace}`,
          version: SERVER_VERSION,
        },
      });

    // ─── Ping ───────────────────────────────────────────────────────────
    case "ping":
      return jsonRpcSuccess(id, {});

    // ─── List Tools ─────────────────────────────────────────────────────
    case "tools/list":
      return jsonRpcSuccess(id, { tools: TOOL_DEFINITIONS });

    // ─── Call Tool ──────────────────────────────────────────────────────
    case "tools/call": {
      const toolName = (params?.name as string) || "";
      const toolArgs = (params?.arguments as Record<string, unknown>) || {};

      if (!toolName) {
        return jsonRpcError(id, -32602, "Missing tool name in params.name");
      }

      const result = await executeTool(toolName, toolArgs, client, workspace);
      return jsonRpcSuccess(id, result);
    }

    // ─── Unknown Method ─────────────────────────────────────────────────
    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════════

function validateAuth(request: Request, env: Env): Response | null {
  // If no MCP_ACCESS_TOKEN is configured, allow all requests (dev mode)
  if (!env.MCP_ACCESS_TOKEN) {
    return null;
  }

  const authHeader = request.headers.get("Authorization");

  if (!authHeader) {
    return jsonResponse(
      { error: "Missing Authorization header. Use: Authorization: Bearer <token>" },
      401
    );
  }

  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || token !== env.MCP_ACCESS_TOKEN) {
    return jsonResponse({ error: "Invalid bearer token." }, 403);
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function getNotionToken(env: Env, workspace: WorkspaceId): string | undefined {
  switch (workspace) {
    case "personal":
      return env.NOTION_TOKEN_PERSONAL;
    case "koodu":
      return env.NOTION_TOKEN_KOODU;
    case "waves":
      return env.NOTION_TOKEN_WAVES;
  }
}

function jsonRpcSuccess(id: string | number, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function corsResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id"
  );
  headers.set("Access-Control-Expose-Headers", "Mcp-Session-Id");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
