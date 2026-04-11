/**
 * MCP Tool definitions and execution logic.
 * 9 tools per workspace - comprehensive Notion access with smart property handling.
 *
 * Tools:
 *   READ:   search_pages, read_page, get_children, query_database, list_databases, get_database_schema
 *   WRITE:  create_page, update_page, update_database, create_database, duplicate_page, move_page, create_view, update_view
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
    name: "create_view",
    description:
      "Create a new view for a database. Views control how database rows are displayed - as a table, board (kanban), calendar, list, timeline, or gallery. You can set filters, sorts, and which properties are visible. The database must already exist.",
    inputSchema: {
      type: "object",
      properties: {
        database_id: {
          type: "string",
          description: "Database ID to create the view for.",
        },
        type: {
          type: "string",
          enum: ["table", "board", "calendar", "list", "timeline", "gallery"],
          description:
            "View type. 'table' for spreadsheet, 'board' for kanban, 'calendar' for date-based, 'list' for simple list, 'timeline' for gantt-style, 'gallery' for card grid.",
        },
        title: {
          type: "string",
          description: "Name for the view (shown as a tab in Notion).",
        },
        filter: {
          type: "object",
          description:
            'Optional Notion filter. Same syntax as query_database filters. Example: {"property": "Status", "status": {"equals": "In progress"}}.',
        },
        sorts: {
          type: "array",
          description:
            'Optional sort array. Same syntax as query_database sorts. Example: [{"property": "Due Date", "direction": "ascending"}].',
          items: { type: "object" },
        },
      },
      required: ["database_id", "type", "title"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "update_view",
    description:
      "Update an existing database view. Can change the view type, title, filters, and sorts. Use query_database or list_databases to find view IDs. Only include the fields you want to change.",
    inputSchema: {
      type: "object",
      properties: {
        view_id: {
          type: "string",
          description: "ID of the view to update.",
        },
        type: {
          type: "string",
          enum: ["table", "board", "calendar", "list", "timeline", "gallery"],
          description: "Change the view type.",
        },
        title: {
          type: "string",
          description: "New name for the view.",
        },
        filter: {
          type: "object",
          description: "New filter for the view. Same syntax as query_database filters.",
        },
        sorts: {
          type: "array",
          description: "New sorts for the view. Same syntax as query_database sorts.",
          items: { type: "object" },
        },
      },
      required: ["view_id"],
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
      case "create_view":
        return await createView(client, args, workspace);
      case "update_view":
        return await updateView(client, args, workspace);
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
      client.searchAll("", { property: "object", value: "database" }, 100),
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

    page = await client.createPage(databaseId, title, true);
    // Update with formatted properties (createPage only sets title)
    if (Object.keys(properties).length > 0) {
      await client.updatePage(page.id, { properties });
    }
  } else {
    // Create standalone page
    page = await client.createPage(parentId, title, false);
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

  if (
    !hasProperties &&
    !hasTitle &&
    !hasArchived &&
    !hasAppendContent &&
    !hasReplaceContent
  ) {
    return errorResult(
      "At least one of properties, title, archived, append_content, or replace_content must be provided."
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

    await client.updatePage(pageId, {
      properties: notionProps,
      archived: hasArchived ? Boolean(args.archived) : undefined,
    });
  } else if (hasArchived) {
    await client.updatePage(pageId, {
      archived: Boolean(args.archived),
    });
  }

  if (hasArchived) {
    actions.push(args.archived ? "archived" : "unarchived");
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

async function createView(
  client: NotionClient,
  args: Record<string, unknown>,
  workspace: WorkspaceId
): Promise<McpToolResult> {
  const dbId = normalizePageId(String(args.database_id || ""));
  const viewType = String(args.type || "");
  const title = String(args.title || "");

  if (!dbId) {
    return errorResult("database_id is required for create_view.");
  }
  if (!viewType) {
    return errorResult("type is required for create_view.");
  }
  if (!title) {
    return errorResult("title is required for create_view.");
  }

  const validTypes = ["table", "board", "calendar", "list", "timeline", "gallery"];
  if (!validTypes.includes(viewType)) {
    return errorResult(
      `Invalid view type "${viewType}". Must be one of: ${validTypes.join(", ")}.`
    );
  }

  const body: Record<string, unknown> = {
    database_id: dbId,
    data_source_id: dbId,
    type: viewType,
    name: title,
  };

  if (args.filter) {
    body.filter = args.filter;
  }
  if (args.sorts) {
    body.sorts = args.sorts;
  }

  const view = await client.createView(body);
  const viewId = (view.id as string).replace(/-/g, "");

  return textResult(
    wsHeader(workspace) +
      `View created: **${title}** (${viewType})\nView ID: \`${viewId}\`\nDatabase: \`${dbId}\``
  );
}

async function updateView(
  client: NotionClient,
  args: Record<string, unknown>,
  workspace: WorkspaceId
): Promise<McpToolResult> {
  const viewId = normalizePageId(String(args.view_id || ""));
  if (!viewId) {
    return errorResult("view_id is required for update_view.");
  }

  const updates: Record<string, unknown> = {};
  const actions: string[] = [];

  if (args.type !== undefined) {
    const validTypes = ["table", "board", "calendar", "list", "timeline", "gallery"];
    if (!validTypes.includes(String(args.type))) {
      return errorResult(
        `Invalid view type "${args.type}". Must be one of: ${validTypes.join(", ")}.`
      );
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
    return errorResult(
      "No changes specified. Provide type, title, filter, or sorts."
    );
  }

  await client.updateView(viewId, updates);

  return textResult(
    wsHeader(workspace) +
      `View \`${viewId}\` updated: ${actions.join(", ")}.`
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
