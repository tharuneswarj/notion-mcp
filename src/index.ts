/**
 * Notion MCP Server - Cloudflare Worker Entry Point
 *
 * Serves MCP (Model Context Protocol) over Streamable HTTP for multiple
 * Notion workspaces under a single deployment.
 *
 * URL structure:
 *   POST /notion/<workspace>/mcp  → workspace whose token is stored in the
 *                                   NOTION_TOKEN_<WORKSPACE> secret
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
const SERVER_NAME = "notion-mcp";
const SERVER_VERSION = "3.0.1";

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
        })
      );
    }

    // Parse workspace from path: /notion/{workspace}/mcp
    const match = path.match(/^\/notion\/([a-z0-9][a-z0-9-]*)\/mcp$/);
    if (!match) {
      return corsResponse(
        jsonResponse(
          {
            error: "Not found",
            hint: "Valid endpoints: /notion/<workspace>/mcp",
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
            error: `Workspace "${workspace}" is not configured. Set the ${notionTokenSecretName(workspace)} secret.`,
          },
          404
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
  // Fail closed: a deployment without MCP_ACCESS_TOKEN would otherwise expose
  // full read/write access to every connected Notion workspace.
  if (!env.MCP_ACCESS_TOKEN) {
    return jsonResponse(
      {
        error:
          "Server misconfigured: MCP_ACCESS_TOKEN is not set. " +
          "Run: wrangler secret put MCP_ACCESS_TOKEN",
      },
      503
    );
  }

  const authHeader = request.headers.get("Authorization");

  if (!authHeader) {
    return jsonResponse(
      { error: "Missing Authorization header. Use: Authorization: Bearer <token>" },
      401
    );
  }

  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token || !timingSafeEqual(token, env.MCP_ACCESS_TOKEN)) {
    return jsonResponse({ error: "Invalid bearer token." }, 403);
  }

  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  // Length comparison leaks only the token length, not its contents.
  if (aBytes.byteLength !== bBytes.byteLength) {
    return false;
  }
  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function notionTokenSecretName(workspace: WorkspaceId): string {
  return `NOTION_TOKEN_${workspace.toUpperCase().replace(/-/g, "_")}`;
}

function getNotionToken(env: Env, workspace: WorkspaceId): string | undefined {
  return env[notionTokenSecretName(workspace)];
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
