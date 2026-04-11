/**
 * MCP Tool definitions and execution logic.
 * v3.0 - API v2025-09-03+ with data_source paradigm.
 *
 * Tools (consolidated for token efficiency):
 *   READ:   search_pages, read_page, get_children, query_database, list_databases, get_database_schema
 *   WRITE:  create_page, update_page, update_database, create_database, duplicate_page, move_page
 *   VIEWS:  views (action: create/update/delete)
 *   SOCIAL: comments (action: get/create/reply)
 *   FILES:  upload_file
 */

import { NotionClient, NotionApiError } from "./notion.js";
import {
  blocksToMarkdown,
  markdownToBlocks,
  richTextToMarkdown,
  simplifyProperties,
  extractTitle,
} from "./markdown.js";
import {
  buildNotionProperties,
  fetchDatabaseSchema,
} from "./properties.js";
import type {
  McpToolDefinition,
  McpToolResult,
  NotionRichText,
  WorkspaceId,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS (schemas loaded into Claude's context window)
// ═══════════════════════════════════════════════════════════════════════════════

export const TOOL_DEFINITIONS: McpToolDefinition[] = [
  // ─── READ TOOLS ──────────────────────────────────────────────────────────

  {
    name: "search_pages",
    description:
      "Search across the workspace by text query. Returns matching pages and databases with titles, URLs, types, and last-edited timestamps. Searches page titles and body content (not database property values). Use get_children to browse the page tree instead.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search text to match against page titles and content.",
        },
        page_size: {
          type: "number",
          description: "Number of results (default 5, max 20).",
        },
        start_cursor: {
          type: "string",
          description:
            "Pagination cursor from a previous search result to get the next page of results.",
        },
      },
      required: ["query"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "read_page",
    description:
      "Read a Notion page's full content as markdown. Returns the title, all properties (as flat key-value pairs), parent location, and the entire page body converted to markdown. Works for both standalone pages and database rows. Use this when you have a page ID.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: {
          type: "string",
          description:
            "Notion page ID (32 hex chars, with or without dashes).",
        },
      },
      required: ["page_id"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "get_children",
    description:
      "Browse the workspace page tree. Returns all child pages and child databases nested under a given page, with their titles, IDs, types, and last-edited times. Call with no page_id to list top-level workspace items. Use this to discover the workspace structure.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: {
          type: "string",
          description:
            "Parent page ID to list children of. Omit to list top-level workspace pages and databases.",
        },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "query_database",
    description:
      "Query a Notion database with optional filters and sorts. Returns rows with flat key-value properties. Supports Notion's full filter syntax including compound and/or filters. Use list_databases or get_children to find database IDs, then get_database_schema to see available properties and valid filter values before querying.",
    inputSchema: {
      type: "object",
      properties: {
        database_id: {
          type: "string",
          description: "Notion database ID (32 hex chars).",
        },
        filter: {
          type: "object",
          description:
            'Notion filter object. Simple: {"property": "Status", "status": {"equals": "In progress"}}. Compound: {"and": [{"property": "Status", "status": {"equals": "Done"}}, {"property": "Priority", "select": {"equals": "P1"}}]}',
        },
        sorts: {
          type: "array",
          description:
            'Sort array. Example: [{"property": "Due Date", "direction": "ascending"}]',
          items: { type: "object" },
        },
        page_size: {
          type: "number",
          description: "Rows to return (default 10, max 50).",
        },
        start_cursor: {
          type: "string",
          description:
            "Pagination cursor from a previous query to get the next page of results.",
        },
      },
      required: ["database_id"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "list_databases",
    description:
      "List all databases visible to the integration with their names, IDs, and property names/types. Use this for a quick overview of available databases. For detailed property schemas with valid option values, use get_database_schema on a specific database.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Optional: filter databases by title. Leave empty to list all.",
        },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "get_database_schema",
    description:
      "Get the full schema of a specific database, including all property names, types, and valid option values for select/multi_select/status fields. Essential before creating or updating database rows - tells you exactly what properties exist and what values they accept. Also returns the database title and parent location.",
    inputSchema: {
      type: "object",
      properties: {
        database_id: {
          type: "string",
          description: "Notion database ID (32 hex chars).",
        },
      },
      required: ["database_id"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },

  // ─── WRITE TOOLS ─────────────────────────────────────────────────────────

  {
    name: "create_page",
    description:
      "Create a new page or database row. For standalone pages: provide title and optional parent_id + markdown content. For database rows: provide database_id with properties as flat key-value pairs (the server converts to Notion format automatically). Properties support all types: text, numbers, select, multi_select, status, dates, checkboxes, URLs, emails, phone numbers, relations (by name or ID), and people (by name or ID). Use get_database_schema first to see valid property names and option values.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "Page title or database row title. Required for standalone pages; for database rows this sets the title property.",
        },
        parent_id: {
          type: "string",
          description:
            "Parent page ID to nest this page under. Creates a child page. Cannot be used with database_id.",
        },
        database_id: {
          type: "string",
          description:
            "Database ID to create a row in. Cannot be used with parent_id.",
        },
        properties: {
          type: "object",
          description:
            'Flat key-value properties for database rows. Example: {"Status": "In progress", "Priority": "P1", "Due Date": "2026-04-15", "Assigned To": "Tharun"}. The server auto-formats these for Notion\'s API and resolves names to IDs for relation/people fields.',
        },
        content: {
          type: "string",
          description:
            "Markdown content for the page body. Supports headings, lists, to-dos, code blocks, quotes, callouts, tables, dividers, images, and bookmarks.",
        },
        icon: {
          type: "string",
          description:
            "Page icon. Use an emoji (e.g., '🚀') or an external URL for a custom icon image.",
        },
        cover_url: {
          type: "string",
          description:
            "Cover image URL for the page banner at the top.",
        },
      },
      required: ["title"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "update_page",
    description:
      "Update an existing page or database row. Can update any combination of: properties (flat key-value pairs, same format as create_page), title, page content (append or replace), and archive status. For database rows, use properties to change Status, Priority, Dates, Assignee, or any other field. The server auto-formats properties and resolves names to IDs.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: {
          type: "string",
          description: "Notion page or database row ID to update.",
        },
        properties: {
          type: "object",
          description:
            'Flat key-value properties to update. Example: {"Status": "Done", "Priority": "P0"}. Only include properties you want to change - others stay unchanged.',
        },
        title: {
          type: "string",
          description: "New title for the page (replaces existing title).",
        },
        append_content: {
          type: "string",
          description:
            "Markdown content to add at the bottom of the page.",
        },
        replace_content: {
          type: "string",
          description:
            "Markdown content to replace the entire page body with. Deletes all existing content first, then writes this. Use with caution.",
        },
        archived: {
          type: "boolean",
          description:
            "Set to true to archive (soft-delete) the page, false to unarchive.",
        },
        icon: {
          type: "string",
          description:
            "Page icon. Use an emoji (e.g., '🚀') or an external URL for a custom icon image.",
        },
        cover_url: {
          type: "string",
          description:
            "Cover image URL for the page banner at the top.",
        },
      },
      required: ["page_id"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "update_database",
    description:
      "Modify a database's structure: add new properties, rename existing ones, change select/status options, or remove properties. Use this when you need to add a column or update the available options in a select/status field. Does NOT modify database rows - use update_page for that.",
    inputSchema: {
      type: "object",
      properties: {
        database_id: {
          type: "string",
          description: "Notion database ID to modify.",
        },
        title: {
          type: "string",
          description: "New title for the database.",
        },
        add_properties: {
          type: "object",
          description:
            'Properties to add. Format: {"Property Name": {"type": "select", "select": {"options": [{"name": "Option1"}, {"name": "Option2"}]}}}. For simple types: {"Notes": {"type": "rich_text"}, "Due Date": {"type": "date"}, "Done": {"type": "checkbox"}}.',
        },
        update_properties: {
          type: "object",
          description:
            'Properties to rename or reconfigure. To rename: {"Old Name": {"name": "New Name"}}. To add select options: {"Status": {"select": {"options": [{"name": "New Option"}]}}}.',
        },
        remove_properties: {
          type: "array",
          description:
            "List of property names to remove from the database. Removes the column and all its data - use with caution.",
          items: { type: "string" },
        },
      },
      required: ["database_id"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "create_database",
    description:
      "Create a new database inside a parent page. Define the database title and its columns (properties) upfront. Each property needs a name and type. Supports all property types: title, rich_text, number, select, multi_select, status, date, checkbox, url, email, phone_number, people, files, relation. After creation, use create_page with the new database_id to add rows.",
    inputSchema: {
      type: "object",
      properties: {
        parent_id: {
          type: "string",
          description:
            "Page ID to create the database under. Databases must live inside a page.",
        },
        title: {
          type: "string",
          description: "Title for the new database.",
        },
        properties: {
          type: "object",
          description:
            'Property definitions for the database columns. Format: {"Property Name": {"type": "select", "select": {"options": [{"name": "Option1"}]}}}. Simple types: {"Notes": {"type": "rich_text"}, "Due": {"type": "date"}, "Done": {"type": "checkbox"}}. A title property is always created automatically.',
        },
      },
      required: ["parent_id", "title"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "duplicate_page",
    description:
      "Duplicate a page or database row. Creates a copy under the same parent with '(copy)' appended to the title. For database rows, all writable properties are copied (formulas, rollups, and auto-generated fields are skipped). Page content (blocks) is also copied up to 2 levels deep.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: {
          type: "string",
          description: "ID of the page or database row to duplicate.",
        },
      },
      required: ["page_id"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "move_page",
    description:
      "Move a page to a new parent (another page or database). This re-parents the page - it keeps its content and ID but changes where it lives. When moving to a database, the page becomes a row in that database.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: {
          type: "string",
          description: "ID of the page to move.",
        },
        new_parent_id: {
          type: "string",
          description: "ID of the new parent page or database.",
        },
        parent_type: {
          type: "string",
          enum: ["page_id", "database_id"],
          description:
            "Type of the new parent. Use 'page_id' to move under a page, 'database_id' to move into a database. Default: 'page_id'.",
        },
      },
      required: ["page_id", "new_parent_id"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "views",
    description:
      "Manage database views (tabs). Actions: 'create' a new view, 'update' an existing view's type/name/filters/sorts, or 'delete' a view. View types: table, board (kanban), calendar, list, timeline, gallery. Use list_databases or query_database to find database IDs. Views control how rows are displayed without changing the data.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "update", "delete"],
          description: "What to do: create a new view, update an existing one, or delete one.",
        },
        database_id: {
          type: "string",
          description: "Database ID (required for 'create').",
        },
        view_id: {
          type: "string",
          description: "View ID (required for 'update' and 'delete').",
        },
        type: {
          type: "string",
          enum: ["table", "board", "calendar", "list", "timeline", "gallery"],
          description: "View type (required for 'create', optional for 'update').",
        },
        title: {
          type: "string",
          description: "View name shown as a tab in Notion (required for 'create', optional for 'update').",
        },
        filter: {
          type: "object",
          description: 'Notion filter. Same syntax as query_database. Example: {"property": "Status", "status": {"equals": "In progress"}}.',
        },
        sorts: {
          type: "array",
          description: 'Sort array. Example: [{"property": "Due Date", "direction": "ascending"}].',
          items: { type: "object" },
        },
      },
      required: ["action"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "comments",
    description:
      "Read and write comments on Notion pages. Actions: 'get' lists all comments on a page, 'create' adds a new comment to a page, 'reply' responds to an existing comment thread. Use this for review workflows, task discussions, and leaving notes. Page-level comments appear in the page's comment sidebar.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["get", "create", "reply"],
          description: "What to do: get comments, create a new comment, or reply to a thread.",
        },
        page_id: {
          type: "string",
          description: "Page ID (required for 'get' and 'create').",
        },
        discussion_id: {
          type: "string",
          description: "Discussion thread ID (required for 'reply'). Found in 'get' results.",
        },
        text: {
          type: "string",
          description: "Comment text (required for 'create' and 'reply'). Supports plain text.",
        },
      },
      required: ["action"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "upload_file",
    description:
      "Upload a file to Notion and attach it to a page as a block. Supports images (PNG, JPG, GIF, SVG, WebP), PDFs, and documents up to 20MB. Provide the file as a base64-encoded string or a URL. The file is uploaded to Notion's storage and embedded in the page. Use this for attaching product photos, generated images, reports, or any file to a Notion page.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: {
          type: "string",
          description: "Page ID to attach the file to.",
        },
        filename: {
          type: "string",
          description: "Filename with extension (e.g., 'photo.png', 'report.pdf').",
        },
        url: {
          type: "string",
          description: "URL of the file to upload. The server will fetch and upload it. Use this OR base64, not both.",
        },
        base64: {
          type: "string",
          description: "Base64-encoded file content. Use this OR url, not both.",
        },
        content_type: {
          type: "string",
          description: "MIME type (e.g., 'image/png', 'application/pdf'). Auto-detected from filename if omitted.",
        },
      },
      required: ["page_id", "filename"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL EXECUTION
// ═══════════════════════════════════════════════════════════════════════════════

const CHARACTER_LIMIT = 30000;

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  client: NotionClient,
  workspace: WorkspaceId
): Promise<McpToolResult> {
  try {
    switch (toolName) {
      case "search_pages":
        return await searchPages(client, args, workspace);
      case "read_page":
        return await readPage(client, args, workspace);
      case "get_children":
        return await getChildren(client, args, workspace);
      case "query_database":
        return await queryDatabase(client, args, workspace);
      case "list_databases":
        return await listDatabases(client, args, workspace);
      case "get_database_schema":
        return await getDatabaseSchema(client, args, workspace);
      case "create_page":
        return await createPage(client, args, workspace);
      case "update_page":
        return await updatePage(client, args, workspace);
      case "update_database":
        return await updateDatabase(client, args, workspace);
      case "create_database":
        return await createDatabase(client, args, workspace);
      case "duplicate_page":
        return await duplicatePage(client, args, workspace);
      case "move_page":
        return await movePage(client, args, workspace);
      case "views":
        return await handleViews(client, args, workspace);
      case "comments":
        return await handleComments(client, args, workspace);
      case "upload_file":
        return await handleUploadFile(client, args, workspace);
      default:
        return errorResult(
          `Unknown tool: ${toolName}. Available tools: ${TOOL_DEFINITIONS.map((t) => t.name).join(", ")}`
        );
    }
  } catch (err) {
    if (err instanceof NotionApiError) {
      return errorResult(err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Unexpected error: ${message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WORKSPACE LABEL
// ═══════════════════════════════════════════════════════════════════════════════

const WORKSPACE_LABELS: Record<WorkspaceId, string> = {
  personal: "Tharun Personal Workspace",
  koodu: "Koodu Architecture Workspace",
  waves: "Waves Company Workspace",
};

function wsHeader(workspace: WorkspaceId): string {
  return `> **${WORKSPACE_LABELS[workspace]}**\n\n`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// READ TOOLS
// ═══════════════════════════════════════════════════════════════════════════════

async function searchPages(
  client: NotionClient,
  args: Record<string, unknown>,
  workspace: WorkspaceId
): Promise<McpToolResult> {
  const query = String(args.query || "");
  const pageSize = Math.min(Number(args.page_size) || 5, 20);
  const startCursor = args.start_cursor ? String(args.start_cursor) : undefined;

  if (!query) {
    return errorResult("query is required for search_pages.");
  }

  const data = await client.search(query, pageSize, undefined, startCursor);

  if (data.results.length === 0) {
    return textResult(
      wsHeader(workspace) + `No pages found matching "${query}".`
    );
  }

  const results = data.results.map((item) => {
    const title = extractSearchTitle(item);
    return {
      id: item.id.replace(/-/g, ""),
      title,
      url: item.url,
      last_edited: item.last_edited_time,
      type: item.object,
      parent: formatParentInfo(item.parent),
    };
  });

  const lines = [wsHeader(workspace) + `## Search results for "${query}"`, ""];
  for (const r of results) {
    lines.push(`**${r.title}** (${r.type})`);
    lines.push(`ID: \`${r.id}\` | [Open](${r.url})`);
    lines.push(`Last edited: ${r.last_edited} | Parent: ${r.parent}`);
    lines.push("");
  }

  if (data.has_more && data.next_cursor) {
    lines.push(
      `*More results available. Use start_cursor: "${data.next_cursor}" to get the next page.*`
    );
  }

  return textResult(lines.join("\n"));
}

async function readPage(
  client: NotionClient,
  args: Record<string, unknown>,
  workspace: WorkspaceId
): Promise<McpToolResult> {
  const pageId = normalizePageId(String(args.page_id || ""));
  if (!pageId) {
    return errorResult("page_id is required for read_page.");
  }

  const [page, blocks] = await Promise.all([
    client.getPage(pageId),
    client.getAllBlockChildren(pageId),
  ]);

  const title = extractTitle(
    page.properties as Record<string, Record<string, unknown>>
  );
  const content = blocksToMarkdown(blocks);

  // Build simplified properties (exclude title to avoid duplication)
  const props = simplifyProperties(
    page.properties as Record<string, Record<string, unknown>>
  );
  delete props["title"];
  delete props["Name"];
  delete props["Title"];

  const parentInfo = formatParentInfo(page.parent);

  const lines = [wsHeader(workspace) + `# ${title}`, ""];

  // Parent context
  lines.push(`**Location:** ${parentInfo}`);
  lines.push(`**URL:** ${page.url}`);
  lines.push(`**Last edited:** ${page.last_edited_time}`);
  lines.push(`**ID:** \`${pageId}\``);
  lines.push("");

  // Add non-empty properties
  const propEntries = Object.entries(props).filter(
    ([, v]) => v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)
  );
  if (propEntries.length > 0) {
    lines.push("**Properties:**");
    for (const [key, value] of propEntries) {
      const display = Array.isArray(value) ? value.join(", ") : String(value);
      lines.push(`- **${key}:** ${display}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");

  if (content) {
    lines.push(content);
  } else {
    lines.push("*(empty page)*");
  }

  let result = lines.join("\n");
  if (result.length > CHARACTER_LIMIT) {
    result =
      result.slice(0, CHARACTER_LIMIT) +
      `\n\n...(truncated at ${CHARACTER_LIMIT} characters. Page has more content.)`;
  }

  return textResult(result);
}

async function getChildren(
  client: NotionClient,
  args: Record<string, unknown>,
  workspace: WorkspaceId
): Promise<McpToolResult> {
  const pageId = args.page_id ? normalizePageId(String(args.page_id)) : null;

  if (!pageId) {
    // Top-level: list all pages and databases via search
    const [pages, databases] = await Promise.all([
      client.searchAll("", { property: "object", value: "page" }, 100),
      client.searchAll("", { property: "object", value: "data_source" }, 100),
    ]);

    // Filter to workspace-level items (parent type = workspace)
    const topPages = pages.results.filter(
      (p) => p.parent?.type === "workspace"
    );
    const topDbs = databases.results.filter(
      (d) => d.parent?.type === "workspace"
    );

    const lines = [
      wsHeader(workspace) + `## Top-level workspace items`,
      "",
    ];

    if (topPages.length > 0) {
      lines.push("### Pages");
      for (const p of topPages) {
        const title = extractSearchTitle(p);
        lines.push(
          `- 📄 **${title}** | ID: \`${p.id.replace(/-/g, "")}\` | [Open](${p.url})`
        );
      }
      lines.push("");
    }

    if (topDbs.length > 0) {
      lines.push("### Databases");
      for (const d of topDbs) {
        const title = d.title
          ? richTextToMarkdown(d.title as unknown as NotionRichText[])
          : "Untitled Database";
        lines.push(
          `- 🗃️ **${title}** | ID: \`${d.id.replace(/-/g, "")}\` | [Open](${d.url})`
        );
      }
      lines.push("");
    }

    if (topPages.length === 0 && topDbs.length === 0) {
      lines.push(
        "No top-level items found. The integration may not have access to workspace-level pages."
      );
    }

    lines.push(
      `\n*To see children of a specific page, call get_children with that page's ID.*`
    );

    return textResult(lines.join("\n"));
  }

  // Specific page: list its child pages and child databases
  const blocks = await client.getAllBlockChildren(pageId, 1);

  const childPages: Array<{ title: string; id: string }> = [];
  const childDatabases: Array<{ title: string; id: string }> = [];
  const otherBlocks: string[] = [];

  for (const block of blocks) {
    if (block.type === "child_page") {
      const data = block["child_page"] as { title?: string } | undefined;
      childPages.push({
        title: data?.title || "Untitled",
        id: block.id.replace(/-/g, ""),
      });
    } else if (block.type === "child_database") {
      const data = block["child_database"] as { title?: string } | undefined;
      childDatabases.push({
        title: data?.title || "Untitled Database",
        id: block.id.replace(/-/g, ""),
      });
    } else {
      // Track content block types for context
      if (!otherBlocks.includes(block.type)) {
        otherBlocks.push(block.type);
      }
    }
  }

  const lines = [
    wsHeader(workspace) +
      `## Children of page \`${pageId}\``,
    "",
  ];

  if (childPages.length > 0) {
    lines.push("### Child Pages");
    for (const p of childPages) {
      lines.push(`- 📄 **${p.title}** | ID: \`${p.id}\``);
    }
    lines.push("");
  }

  if (childDatabases.length > 0) {
    lines.push("### Child Databases");
    for (const d of childDatabases) {
      lines.push(`- 🗃️ **${d.title}** | ID: \`${d.id}\``);
    }
    lines.push("");
  }

  if (otherBlocks.length > 0) {
    lines.push(
      `*Page also contains content blocks: ${otherBlocks.join(", ")}. Use read_page to see the full content.*`
    );
  }

  if (childPages.length === 0 && childDatabases.length === 0) {
    lines.push(
      otherBlocks.length > 0
        ? "No child pages or databases. The page contains content blocks - use read_page to see them."
        : "This page has no children."
    );
  }

  return textResult(lines.join("\n"));
}

async function queryDatabase(
  client: NotionClient,
  args: Record<string, unknown>,
  workspace: WorkspaceId
): Promise<McpToolResult> {
  const dbId = normalizePageId(String(args.database_id || ""));
  if (!dbId) {
    return errorResult("database_id is required for query_database.");
  }

  const pageSize = Math.min(Number(args.page_size) || 10, 50);
  const startCursor = args.start_cursor ? String(args.start_cursor) : undefined;

  const data = await client.queryDatabase(
    dbId,
    args.filter,
    args.sorts as unknown[] | undefined,
    pageSize,
    startCursor
  );

  if (data.results.length === 0) {
    return textResult(
      wsHeader(workspace) +
        "No results found in this database with the given filters."
    );
  }

  const rows = data.results.map((page) => {
    const props = simplifyProperties(
      page.properties as Record<string, Record<string, unknown>>
    );
    const title = extractTitle(
      page.properties as Record<string, Record<string, unknown>>
    );
    return {
      id: page.id.replace(/-/g, ""),
      url: page.url,
      title,
      properties: props,
    };
  });

  const lines: string[] = [
    wsHeader(workspace) +
      `## Database query results (${rows.length} rows)`,
    "",
  ];

  for (const row of rows) {
    lines.push(`### ${row.title}`);
    lines.push(`ID: \`${row.id}\` | [Open](${row.url})`);

    for (const [key, value] of Object.entries(row.properties)) {
      if (
        value === null ||
        value === "" ||
        (Array.isArray(value) && value.length === 0)
      )
        continue;
      const lower = key.toLowerCase();
      if (lower === "name" || lower === "title") continue;

      const display =
        typeof value === "object" ? JSON.stringify(value) : String(value);
      lines.push(`- **${key}:** ${display}`);
    }
    lines.push("");
  }

  if (data.has_more && data.next_cursor) {
    lines.push(
      `*More results available. Use start_cursor: "${data.next_cursor}" to get the next page.*`
    );
  }

  let result = lines.join("\n");
  if (result.length > CHARACTER_LIMIT) {
    result =
      result.slice(0, CHARACTER_LIMIT) +
      "\n\n...(truncated. Use filters or reduce page_size.)";
  }

  return textResult(result);
}

async function listDatabases(
  client: NotionClient,
  args: Record<string, unknown>,
  workspace: WorkspaceId
): Promise<McpToolResult> {
  const query = String(args.query || "");
  const data = await client.listDatabases(query);

  if (data.results.length === 0) {
    return textResult(
      wsHeader(workspace) +
        (query
          ? `No databases found matching "${query}".`
          : "No databases found. Make sure databases are shared with the integration.")
    );
  }

  const lines: string[] = [
    wsHeader(workspace) +
      `## Databases in workspace (${data.results.length})`,
    "",
  ];

  for (const db of data.results) {
    const title = db.title
      ? richTextToMarkdown(db.title as unknown as NotionRichText[])
      : "Untitled Database";

    lines.push(`**${title}**`);
    lines.push(`ID: \`${db.id.replace(/-/g, "")}\` | [Open](${db.url})`);

    const props = db.properties as
      | Record<string, { type: string }>
      | undefined;
    if (props) {
      const propList = Object.entries(props)
        .map(([name, p]) => `${name} (${p.type})`)
        .join(", ");
      lines.push(`Properties: ${propList}`);
    }
    lines.push("");
  }

  lines.push(
    `*Use get_database_schema with a database ID to see full property details including valid option values.*`
  );

  return textResult(lines.join("\n"));
}

async function getDatabaseSchema(
  client: NotionClient,
  args: Record<string, unknown>,
  workspace: WorkspaceId
): Promise<McpToolResult> {
  const dbId = normalizePageId(String(args.database_id || ""));
  if (!dbId) {
    return errorResult("database_id is required for get_database_schema.");
  }

  const schema = await fetchDatabaseSchema(client, dbId);

  const lines: string[] = [
    wsHeader(workspace) + `## Database Schema: ${schema.title}`,
    `ID: \`${schema.id}\``,
    "",
    "### Properties",
    "",
  ];

  for (const [name, prop] of Object.entries(schema.properties)) {
    const type = prop.type;
    lines.push(`**${name}** (\`${type}\`)`);

    // Show additional details based on type
    switch (type) {
      case "select": {
        const options = (
          prop.select as { options?: Array<{ name: string; color?: string }> }
        )?.options;
        if (options && options.length > 0) {
          lines.push(
            `  Options: ${options.map((o) => `\`${o.name}\``).join(", ")}`
          );
        } else {
          lines.push(`  Options: (none defined - Notion auto-creates on use)`);
        }
        break;
      }
      case "multi_select": {
        const msOptions = (
          prop.multi_select as {
            options?: Array<{ name: string; color?: string }>;
          }
        )?.options;
        if (msOptions && msOptions.length > 0) {
          lines.push(
            `  Options: ${msOptions.map((o) => `\`${o.name}\``).join(", ")}`
          );
        } else {
          lines.push(`  Options: (none defined - Notion auto-creates on use)`);
        }
        break;
      }
      case "status": {
        const statusConfig = prop.status as {
          options?: Array<{ name: string; color?: string }>;
          groups?: Array<{
            name: string;
            option_ids: string[];
            color?: string;
          }>;
        };
        if (statusConfig?.options && statusConfig.options.length > 0) {
          lines.push(
            `  Options: ${statusConfig.options.map((o) => `\`${o.name}\``).join(", ")}`
          );
        }
        if (statusConfig?.groups && statusConfig.groups.length > 0) {
          lines.push(
            `  Groups: ${statusConfig.groups.map((g) => g.name).join(", ")}`
          );
        }
        break;
      }
      case "relation": {
        const relConfig = prop.relation as {
          database_id?: string;
          type?: string;
        };
        if (relConfig?.database_id) {
          lines.push(
            `  Related database: \`${relConfig.database_id.replace(/-/g, "")}\` (${relConfig.type || "single_property"})`
          );
        }
        break;
      }
      case "formula": {
        const fConfig = prop.formula as { expression?: string };
        if (fConfig?.expression) {
          lines.push(`  Formula: ${fConfig.expression}`);
        }
        lines.push(`  *(read-only - computed automatically)*`);
        break;
      }
      case "rollup": {
        const rConfig = prop.rollup as {
          relation_property_name?: string;
          rollup_property_name?: string;
          function?: string;
        };
        if (rConfig) {
          lines.push(
            `  Rollup: ${rConfig.function || "?"} of "${rConfig.rollup_property_name || "?"}" via "${rConfig.relation_property_name || "?"}"`
          );
        }
        lines.push(`  *(read-only - computed automatically)*`);
        break;
      }
      case "number": {
        const nConfig = prop.number as { format?: string };
        if (nConfig?.format && nConfig.format !== "number") {
          lines.push(`  Format: ${nConfig.format}`);
        }
        break;
      }
      case "unique_id": {
        const uidConfig = prop.unique_id as { prefix?: string };
        if (uidConfig?.prefix) {
          lines.push(`  Prefix: ${uidConfig.prefix}`);
        }
        lines.push(`  *(read-only - auto-generated)*`);
        break;
      }
      case "created_time":
      case "created_by":
      case "last_edited_time":
      case "last_edited_by":
        lines.push(`  *(read-only - managed by Notion)*`);
        break;
    }
    lines.push("");
  }

  // Add writable vs read-only summary
  const writable = Object.entries(schema.properties).filter(
    ([, p]) => !READ_ONLY_TYPES.has(p.type)
  );
  const readOnly = Object.entries(schema.properties).filter(([, p]) =>
    READ_ONLY_TYPES.has(p.type)
  );

  lines.push("### Summary");
  lines.push(`- **Writable properties (${writable.length}):** ${writable.map(([n]) => n).join(", ")}`);
  if (readOnly.length > 0) {
    lines.push(
      `- **Read-only properties (${readOnly.length}):** ${readOnly.map(([n]) => n).join(", ")}`
    );
  }

  return textResult(lines.join("\n"));
}

const READ_ONLY_TYPES = new Set([
  "formula",
  "rollup",
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
  "unique_id",
  "verification",
]);

// ═══════════════════════════════════════════════════════════════════════════════
// WRITE TOOLS
// ═══════════════════════════════════════════════════════════════════════════════

async function createPage(
  client: NotionClient,
  args: Record<string, unknown>,
  workspace: WorkspaceId
): Promise<McpToolResult> {
  const title = String(args.title || "");
  if (!title) {
    return errorResult("title is required for create_page.");
  }

  const parentId = args.parent_id
    ? normalizePageId(String(args.parent_id))
    : null;
  const databaseId = args.database_id
    ? normalizePageId(String(args.database_id))
    : null;
  const content = args.content ? String(args.content) : null;
  const flatProps = (args.properties as Record<string, unknown>) || {};

  if (parentId && databaseId) {
    return errorResult(
      "Cannot use both parent_id and database_id. Use parent_id for child pages, database_id for database rows."
    );
  }

  // Build icon/cover objects
  const iconArg = args.icon ? String(args.icon) : null;
  const coverUrl = args.cover_url ? String(args.cover_url) : null;
  const icon = iconArg
    ? isUrl(iconArg)
      ? { type: "external", external: { url: iconArg } }
      : { type: "emoji", emoji: iconArg }
    : undefined;
  const cover = coverUrl
    ? { type: "external", external: { url: coverUrl } }
    : undefined;

  let page;

  if (databaseId) {
    // Create database row
    const schema = await fetchDatabaseSchema(client, databaseId);
    const { properties, errors } = await buildNotionProperties(
      { ...flatProps },
      schema.properties,
      client
    );

    // Add title
    const titlePropName = findTitleProperty(schema.properties);
    if (titlePropName) {
      properties[titlePropName] = {
        title: [{ type: "text", text: { content: title } }],
      };
    }

    if (errors.length > 0) {
      return errorResult(
        `Property errors:\n${errors.map((e) => `- ${e}`).join("\n")}\n\nThe row was NOT created. Fix the errors and try again.`
      );
    }

    page = await client.createPage(databaseId, title, true, { icon, cover });
    // Update with formatted properties (createPage only sets title)
    if (Object.keys(properties).length > 0) {
      await client.updatePage(page.id, { properties });
    }
  } else {
    // Create standalone page
    page = await client.createPage(parentId, title, false, { icon, cover });
  }

  // Append content if provided
  if (content) {
    const blocks = markdownToBlocks(content);
    if (blocks.length > 0) {
      await client.appendBlockChildren(page.id, blocks);
    }
  }

  const resultLines = [
    wsHeader(workspace) + `Page created: **${title}**`,
    `ID: \`${page.id.replace(/-/g, "")}\``,
    `URL: ${page.url}`,
    databaseId ? `Created as row in database \`${databaseId}\`` : "",
  ].filter(Boolean);

  return textResult(resultLines.join("\n"));
}

async function updatePage(
  client: NotionClient,
  args: Record<string, unknown>,
  workspace: WorkspaceId
): Promise<McpToolResult> {
  const pageId = normalizePageId(String(args.page_id || ""));
  if (!pageId) {
    return errorResult("page_id is required for update_page.");
  }

  const hasProperties = args.properties !== undefined;
  const hasTitle = args.title !== undefined;
  const hasArchived = args.archived !== undefined;
  const hasAppendContent = args.append_content !== undefined;
  const hasReplaceContent = args.replace_content !== undefined;
  const hasIcon = args.icon !== undefined;
  const hasCover = args.cover_url !== undefined;

  if (
    !hasProperties &&
    !hasTitle &&
    !hasArchived &&
    !hasAppendContent &&
    !hasReplaceContent &&
    !hasIcon &&
    !hasCover
  ) {
    return errorResult(
      "At least one of properties, title, archived, append_content, replace_content, icon, or cover_url must be provided."
    );
  }

  if (hasAppendContent && hasReplaceContent) {
    return errorResult(
      "Cannot use both append_content and replace_content. Choose one."
    );
  }

  const actions: string[] = [];

  // Handle properties update
  if (hasProperties || hasTitle) {
    const flatProps = (args.properties as Record<string, unknown>) || {};
    let notionProps: Record<string, unknown> = {};

    if (hasProperties && Object.keys(flatProps).length > 0) {
      // Fetch the page to find its parent database
      const page = await client.getPage(pageId);
      const parentDbId = page.parent?.database_id;

      if (parentDbId) {
        const schema = await fetchDatabaseSchema(client, parentDbId);
        const { properties, errors } = await buildNotionProperties(
          flatProps,
          schema.properties,
          client
        );

        if (errors.length > 0) {
          return errorResult(
            `Property errors:\n${errors.map((e) => `- ${e}`).join("\n")}\n\nNo changes were made. Fix the errors and try again.`
          );
        }
        notionProps = properties;
      } else {
        // Standalone page - only title can be updated
        return errorResult(
          "This page is not a database row. Only database rows support property updates. Use title, append_content, or replace_content for standalone pages."
        );
      }
      actions.push(
        `properties updated: ${Object.keys(flatProps).join(", ")}`
      );
    }

    if (hasTitle) {
      notionProps["title"] = {
        title: [{ type: "text", text: { content: String(args.title) } }],
      };
      actions.push(`title updated to "${args.title}"`);
    }

    // Build icon/cover for this call
    const iconVal = hasIcon ? buildIconObject(String(args.icon)) : undefined;
    const coverVal = hasCover ? { type: "external", external: { url: String(args.cover_url) } } : undefined;

    await client.updatePage(pageId, {
      properties: notionProps,
      archived: hasArchived ? Boolean(args.archived) : undefined,
      icon: iconVal,
      cover: coverVal,
    });
  } else if (hasArchived || hasIcon || hasCover) {
    const iconVal = hasIcon ? buildIconObject(String(args.icon)) : undefined;
    const coverVal = hasCover ? { type: "external", external: { url: String(args.cover_url) } } : undefined;

    await client.updatePage(pageId, {
      archived: hasArchived ? Boolean(args.archived) : undefined,
      icon: iconVal,
      cover: coverVal,
    });
  }

  if (hasArchived) {
    actions.push(args.archived ? "archived" : "unarchived");
  }
  if (hasIcon) {
    actions.push(`icon set to "${args.icon}"`);
  }
  if (hasCover) {
    actions.push("cover image updated");
  }

  // Handle content replacement (delete all blocks then append)
  if (hasReplaceContent) {
    // Fetch all existing blocks
    const existingBlocks = await client.getAllBlockChildren(pageId, 1);
    // Delete each block
    for (const block of existingBlocks) {
      await client.deleteBlock(block.id);
    }
    // Append new content
    const newBlocks = markdownToBlocks(String(args.replace_content));
    if (newBlocks.length > 0) {
      await client.appendBlockChildren(pageId, newBlocks);
    }
    actions.push("content replaced");
  }

  // Handle content append
  if (hasAppendContent) {
    const blocks = markdownToBlocks(String(args.append_content));
    if (blocks.length > 0) {
      await client.appendBlockChildren(pageId, blocks);
    }
    actions.push("content appended");
  }

  return textResult(
    wsHeader(workspace) +
      `Page \`${pageId}\` updated: ${actions.join(", ")}.`
  );
}

async function updateDatabase(
  client: NotionClient,
  args: Record<string, unknown>,
  workspace: WorkspaceId
): Promise<McpToolResult> {
  const dbId = normalizePageId(String(args.database_id || ""));
  if (!dbId) {
    return errorResult("database_id is required for update_database.");
  }

  const updates: Record<string, unknown> = {};
  const actions: string[] = [];

  // Title update
  if (args.title !== undefined) {
    updates.title = [
      { type: "text", text: { content: String(args.title) } },
    ];
    actions.push(`title updated to "${args.title}"`);
  }

  // Property additions and updates
  const propUpdates: Record<string, unknown> = {};

  if (args.add_properties) {
    const addProps = args.add_properties as Record<string, unknown>;
    for (const [name, config] of Object.entries(addProps)) {
      propUpdates[name] = normalizePropertyConfig(config);
      actions.push(`added property "${name}"`);
    }
  }

  if (args.update_properties) {
    const updateProps = args.update_properties as Record<string, unknown>;
    for (const [name, config] of Object.entries(updateProps)) {
      propUpdates[name] = config;
      actions.push(`updated property "${name}"`);
    }
  }

  // Property removals
  if (args.remove_properties) {
    const removeProps = args.remove_properties as string[];
    for (const name of removeProps) {
      propUpdates[name] = null; // null removes the property
      actions.push(`removed property "${name}"`);
    }
  }

  if (Object.keys(propUpdates).length > 0) {
    updates.properties = propUpdates;
  }

  if (Object.keys(updates).length === 0) {
    return errorResult(
      "No changes specified. Provide title, add_properties, update_properties, or remove_properties."
    );
  }

  await client.updateDatabase(dbId, updates);

  return textResult(
    wsHeader(workspace) +
      `Database \`${dbId}\` updated: ${actions.join(", ")}.`
  );
}

async function createDatabase(
  client: NotionClient,
  args: Record<string, unknown>,
  workspace: WorkspaceId
): Promise<McpToolResult> {
  const parentId = normalizePageId(String(args.parent_id || ""));
  const title = String(args.title || "");

  if (!parentId) {
    return errorResult("parent_id is required for create_database.");
  }
  if (!title) {
    return errorResult("title is required for create_database.");
  }

  // Build properties - always include a title column
  const rawProps = (args.properties as Record<string, unknown>) || {};
  const notionProps: Record<string, unknown> = {
    Name: { title: {} }, // Every database needs a title property
  };

  for (const [name, config] of Object.entries(rawProps)) {
    notionProps[name] = normalizePropertyConfig(config);
  }

  const db = await client.createDatabase(parentId, title, notionProps);
  const dbId = (db.id as string).replace(/-/g, "");

  return textResult(
    wsHeader(workspace) +
      `Database created: **${title}**\nID: \`${dbId}\`\nURL: ${db.url}\nProperties: ${Object.keys(notionProps).join(", ")}`
  );
}

async function duplicatePage(
  client: NotionClient,
  args: Record<string, unknown>,
  workspace: WorkspaceId
): Promise<McpToolResult> {
  const pageId = normalizePageId(String(args.page_id || ""));
  if (!pageId) {
    return errorResult("page_id is required for duplicate_page.");
  }

  const newPage = await client.duplicatePage(pageId);
  const newTitle = extractTitle(
    newPage.properties as Record<string, Record<string, unknown>>
  );

  return textResult(
    wsHeader(workspace) +
      `Page duplicated: **${newTitle}**\nNew ID: \`${newPage.id.replace(/-/g, "")}\`\nURL: ${newPage.url}\nOriginal: \`${pageId}\``
  );
}

async function movePage(
  client: NotionClient,
  args: Record<string, unknown>,
  workspace: WorkspaceId
): Promise<McpToolResult> {
  const pageId = normalizePageId(String(args.page_id || ""));
  const newParentId = normalizePageId(String(args.new_parent_id || ""));
  const parentType = (args.parent_type as "page_id" | "database_id") || "page_id";

  if (!pageId) {
    return errorResult("page_id is required for move_page.");
  }
  if (!newParentId) {
    return errorResult("new_parent_id is required for move_page.");
  }

  const page = await client.movePage(pageId, newParentId, parentType);

  return textResult(
    wsHeader(workspace) +
      `Page \`${pageId}\` moved to ${parentType === "database_id" ? "database" : "page"} \`${newParentId}\`.\nURL: ${page.url}`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSOLIDATED TOOLS: VIEWS, COMMENTS, FILES
// ═══════════════════════════════════════════════════════════════════════════════

async function handleViews(
  client: NotionClient,
  args: Record<string, unknown>,
  workspace: WorkspaceId
): Promise<McpToolResult> {
  const action = String(args.action || "");
  const validTypes = ["table", "board", "calendar", "list", "timeline", "gallery"];

  switch (action) {
    case "create": {
      const dbId = normalizePageId(String(args.database_id || ""));
      const viewType = String(args.type || "");
      const title = String(args.title || "");

      if (!dbId) return errorResult("database_id is required for views create.");
      if (!viewType) return errorResult("type is required for views create.");
      if (!title) return errorResult("title is required for views create.");
      if (!validTypes.includes(viewType)) {
        return errorResult(`Invalid view type "${viewType}". Must be one of: ${validTypes.join(", ")}.`);
      }

      // On v2025-09-03, the ID users pass is the data_source_id.
      // The views API needs the REAL database_id from parent.database_id.
      const { realDatabaseId, dataSourceId } = await client.resolveViewIds(dbId);

      const reqBody: Record<string, unknown> = {
        database_id: realDatabaseId,
        data_source_id: dataSourceId,
        type: viewType,
        name: title,
      };
      if (args.filter) reqBody.filter = args.filter;
      if (args.sorts) reqBody.sorts = args.sorts;

      const view = await client.createView(reqBody);
      const viewId = (view.id as string).replace(/-/g, "");
      return textResult(
        wsHeader(workspace) +
          `View created: **${title}** (${viewType})\nView ID: \`${viewId}\`\nDatabase: \`${dbId}\``
      );
    }

    case "update": {
      const viewId = normalizePageId(String(args.view_id || ""));
      if (!viewId) return errorResult("view_id is required for views update.");

      const updates: Record<string, unknown> = {};
      const actions: string[] = [];

      if (args.type !== undefined) {
        if (!validTypes.includes(String(args.type))) {
          return errorResult(`Invalid view type "${args.type}". Must be one of: ${validTypes.join(", ")}.`);
        }
        updates.type = args.type;
        actions.push(`type changed to "${args.type}"`);
      }
      if (args.title !== undefined) {
        updates.name = String(args.title);
        actions.push(`title updated to "${args.title}"`);
      }
      if (args.filter !== undefined) {
        updates.filter = args.filter;
        actions.push("filter updated");
      }
      if (args.sorts !== undefined) {
        updates.sorts = args.sorts;
        actions.push("sorts updated");
      }

      if (Object.keys(updates).length === 0) {
        return errorResult("No changes specified. Provide type, title, filter, or sorts.");
      }

      await client.updateView(viewId, updates);
      return textResult(wsHeader(workspace) + `View \`${viewId}\` updated: ${actions.join(", ")}.`);
    }

    case "delete": {
      const viewId = normalizePageId(String(args.view_id || ""));
      if (!viewId) return errorResult("view_id is required for views delete.");

      await client.deleteView(viewId);
      return textResult(wsHeader(workspace) + `View \`${viewId}\` deleted.`);
    }

    default:
      return errorResult(`Unknown views action "${action}". Use: create, update, or delete.`);
  }
}

async function handleComments(
  client: NotionClient,
  args: Record<string, unknown>,
  workspace: WorkspaceId
): Promise<McpToolResult> {
  const action = String(args.action || "");

  switch (action) {
    case "get": {
      const pageId = normalizePageId(String(args.page_id || ""));
      if (!pageId) return errorResult("page_id is required for comments get.");

      const data = await client.getComments(pageId);

      if (data.results.length === 0) {
        return textResult(wsHeader(workspace) + "No comments on this page.");
      }

      const lines = [wsHeader(workspace) + `## Comments (${data.results.length})`, ""];

      for (const comment of data.results) {
        const author = comment.created_by?.id || "Unknown";
        const time = comment.created_time;
        const text = comment.rich_text
          .map((rt) => rt.plain_text)
          .join("");
        const discussionId = comment.discussion_id;

        lines.push(`**${author}** at ${time}`);
        lines.push(`Discussion: \`${discussionId}\``);
        lines.push(text);
        lines.push("");
      }

      if (data.has_more) {
        lines.push("*More comments available. Use start_cursor for pagination.*");
      }

      return textResult(lines.join("\n"));
    }

    case "create": {
      const pageId = normalizePageId(String(args.page_id || ""));
      const text = String(args.text || "");
      if (!pageId) return errorResult("page_id is required for comments create.");
      if (!text) return errorResult("text is required for comments create.");

      const comment = await client.createComment({
        parent: { page_id: pageId },
        rich_text: [{ type: "text", text: { content: text } }],
      });

      return textResult(
        wsHeader(workspace) +
          `Comment added to page \`${pageId}\`.\nComment ID: \`${comment.id}\`\nDiscussion: \`${comment.discussion_id}\``
      );
    }

    case "reply": {
      const discussionId = String(args.discussion_id || "");
      const text = String(args.text || "");
      if (!discussionId) return errorResult("discussion_id is required for comments reply.");
      if (!text) return errorResult("text is required for comments reply.");

      const comment = await client.createComment({
        discussion_id: discussionId,
        rich_text: [{ type: "text", text: { content: text } }],
      });

      return textResult(
        wsHeader(workspace) +
          `Reply added to discussion \`${discussionId}\`.\nComment ID: \`${comment.id}\``
      );
    }

    default:
      return errorResult(`Unknown comments action "${action}". Use: get, create, or reply.`);
  }
}

async function handleUploadFile(
  client: NotionClient,
  args: Record<string, unknown>,
  workspace: WorkspaceId
): Promise<McpToolResult> {
  const pageId = normalizePageId(String(args.page_id || ""));
  const filename = String(args.filename || "");

  if (!pageId) return errorResult("page_id is required for upload_file.");
  if (!filename) return errorResult("filename is required for upload_file.");

  // Detect content type from filename
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const mimeMap: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", svg: "image/svg+xml", webp: "image/webp",
    pdf: "application/pdf", doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    csv: "text/csv", txt: "text/plain", mp4: "video/mp4",
  };
  const contentType = args.content_type
    ? String(args.content_type)
    : mimeMap[ext] || "application/octet-stream";

  // Get file data from URL or base64
  let fileData: ArrayBuffer;
  if (args.url) {
    const response = await fetch(String(args.url));
    if (!response.ok) {
      return errorResult(`Failed to fetch file from URL: ${response.status} ${response.statusText}`);
    }
    fileData = await response.arrayBuffer();
  } else if (args.base64) {
    const binary = atob(String(args.base64));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    fileData = bytes.buffer;
  } else {
    return errorResult("Either url or base64 is required for upload_file.");
  }

  // Check size (20MB limit for simple upload)
  const sizeMB = fileData.byteLength / (1024 * 1024);
  if (sizeMB > 20) {
    return errorResult(`File too large (${sizeMB.toFixed(1)}MB). Maximum is 20MB for simple upload.`);
  }

  // Step 1: Create upload object
  const upload = await client.createFileUpload(filename, contentType);

  // Step 2: Send file content
  await client.sendFileContent(upload.id, fileData, filename, contentType);

  // Step 3: Attach to page as a file block
  const isImage = contentType.startsWith("image/");
  const block = isImage
    ? {
        type: "image",
        image: {
          type: "file_upload",
          file_upload: { id: upload.id },
        },
      }
    : {
        type: "file",
        file: {
          type: "file_upload",
          file_upload: { id: upload.id },
          name: filename,
        },
      };

  await client.appendBlockChildren(pageId, [block]);

  return textResult(
    wsHeader(workspace) +
      `File uploaded: **${filename}** (${sizeMB.toFixed(1)}MB, ${contentType})\nAttached to page \`${pageId}\` as ${isImage ? "image" : "file"} block.`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function textResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): McpToolResult {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}

function normalizePageId(id: string): string {
  return id.replace(/-/g, "").trim();
}

function isUrl(s: string): boolean {
  return s.startsWith("http://") || s.startsWith("https://");
}

function buildIconObject(icon: string): Record<string, unknown> {
  return isUrl(icon)
    ? { type: "external", external: { url: icon } }
    : { type: "emoji", emoji: icon };
}

function extractSearchTitle(item: Record<string, unknown>): string {
  if (item.title && Array.isArray(item.title)) {
    const rt = item.title as NotionRichText[];
    const text = richTextToMarkdown(rt);
    if (text) return text;
  }
  const props = item.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (props) {
    return extractTitle(props);
  }
  return "Untitled";
}

function formatParentInfo(
  parent: Record<string, unknown> | undefined
): string {
  if (!parent) return "Unknown";
  const type = parent.type as string;
  switch (type) {
    case "workspace":
      return "Workspace root";
    case "page_id":
      return `Child of page \`${String(parent.page_id || "").replace(/-/g, "")}\``;
    case "database_id":
      return `Row in database \`${String(parent.database_id || "").replace(/-/g, "")}\``;
    case "data_source_id":
      return `Row in database \`${String(parent.data_source_id || "").replace(/-/g, "")}\``;
    case "block_id":
      return `Inside block \`${String(parent.block_id || "").replace(/-/g, "")}\``;
    default:
      return type;
  }
}

/**
 * Normalize a simplified property config to Notion API format.
 * Accepts both simplified ({"type": "checkbox"}) and native ({"checkbox": {}}) formats.
 * Simple types that need no extra config: checkbox, rich_text, number, url, email,
 * phone_number, date, files, people, created_time, created_by, last_edited_time, last_edited_by.
 */
function normalizePropertyConfig(config: unknown): unknown {
  if (!config || typeof config !== "object") return config;
  const cfg = config as Record<string, unknown>;

  // If it has a "type" field but no matching type key, convert to Notion format
  // e.g. {"type": "checkbox"} → {"checkbox": {}}
  // e.g. {"type": "select", "select": {"options": [...]}} is already correct
  const type = cfg.type as string | undefined;
  if (type && cfg[type] === undefined) {
    const result: Record<string, unknown> = { [type]: {} };
    // Copy over any extra keys (except "type") that might have config
    for (const [k, v] of Object.entries(cfg)) {
      if (k !== "type") result[k] = v;
    }
    return result;
  }

  return config;
}

function findTitleProperty(
  schema: Record<string, { type: string; [k: string]: unknown }>
): string | null {
  for (const [name, prop] of Object.entries(schema)) {
    if (prop.type === "title") return name;
  }
  return null;
}
