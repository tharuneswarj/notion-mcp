// ─── Cloudflare Worker Environment ───────────────────────────────────────────

export interface Env {
  NOTION_API_VERSION: string;
  MCP_ACCESS_TOKEN: string;
  NOTION_TOKEN_PERSONAL?: string;
  NOTION_TOKEN_KOODU?: string;
  NOTION_TOKEN_WAVES?: string;
}

export type WorkspaceId = "personal" | "koodu" | "waves";

// ─── JSON-RPC / MCP Protocol ────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ─── Notion API Types ───────────────────────────────────────────────────────

export interface NotionRichText {
  type: string;
  plain_text: string;
  text?: { content: string; link?: { url: string } | null };
  annotations?: {
    bold: boolean;
    italic: boolean;
    strikethrough: boolean;
    underline: boolean;
    code: boolean;
  };
  href?: string | null;
}

export interface NotionBlock {
  id: string;
  type: string;
  has_children: boolean;
  [key: string]: unknown;
}

export interface NotionPage {
  id: string;
  url: string;
  last_edited_time: string;
  properties: Record<string, NotionProperty>;
  parent: { type: string; page_id?: string; database_id?: string; workspace?: boolean };
}

export interface NotionProperty {
  type: string;
  [key: string]: unknown;
}

export interface NotionSearchResult {
  results: Array<{
    id: string;
    object: string;
    url: string;
    last_edited_time: string;
    properties?: Record<string, NotionProperty>;
    title?: Array<NotionRichText>;
    parent?: { type: string };
  }>;
  has_more: boolean;
  next_cursor: string | null;
}

export interface NotionBlocksResponse {
  results: NotionBlock[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface NotionDatabaseQueryResponse {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}
