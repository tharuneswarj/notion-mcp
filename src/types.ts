// ─── Cloudflare Worker Environment ───────────────────────────────────────────

export interface Env {
  NOTION_API_VERSION: string;
  /** Bearer token for MCP auth. Unset → server refuses all requests (503). */
  MCP_ACCESS_TOKEN?: string;
  /** One NOTION_TOKEN_<WORKSPACE> secret per workspace; the set of secrets
   *  defines which /notion/<workspace>/mcp routes exist. */
  [key: string]: string | undefined;
}

/** Workspace slug from the route path (lowercase letters, digits, hyphens). */
export type WorkspaceId = string;

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
  parent: {
    type: string;
    page_id?: string;
    database_id?: string;
    data_source_id?: string;
    workspace?: boolean;
  };
}

export interface NotionProperty {
  type: string;
  [key: string]: unknown;
}

export interface NotionSearchResult {
  results: Array<{
    id: string;
    object: string; // "page" | "data_source" (was "database" on old API)
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

// ─── Comments ──────────────────────────────────────────────────────────────

export interface NotionComment {
  id: string;
  parent: { type: string; page_id?: string; block_id?: string };
  discussion_id: string;
  rich_text: NotionRichText[];
  created_time: string;
  created_by: { id: string; object: string };
}

export interface NotionCommentsResponse {
  results: NotionComment[];
  has_more: boolean;
  next_cursor: string | null;
}

// ─── File Upload ───────────────────────────────────────────────────────────

export interface NotionFileUpload {
  id: string;
  status: string;
  upload_url?: string;
}

// ─── Data Source (v2025-09-03+) ────────────────────────────────────────────

export interface NotionDataSource {
  id: string;
  object: "data_source";
  url: string;
  title?: NotionRichText[];
  properties?: Record<string, NotionProperty>;
  parent?: { type: string; database_id?: string };
  last_edited_time: string;
}
