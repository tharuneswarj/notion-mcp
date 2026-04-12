---
name: notion-server
description: "Base skill for the custom Notion MCP server. Read this skill FIRST before performing any Notion operation on any workspace. It teaches Claude how to use the 15 custom MCP tools - the property format, workflow patterns, markdown syntax, and known limitations. Includes read, write, database views, comments, and file upload tools with icon/cover support. This skill is workspace-agnostic. Workspace-specific skills (waves-notion-manager, tharun-notion-manager, etc.) build on top of this. Triggers when Claude needs to read, write, search, query, or manage views and comments on any Notion workspace through the custom connectors (Notion-Workspace-Tharun, Notion-Workspace-Waves, Notion-Workspace-Koodu)."
---

# Notion MCP Server - Base Skill

## What This Is

This is the reference guide for the custom Notion MCP server deployed at `notion-mcp-server.tharun-mcp.workers.dev`. It connects 3 Notion workspaces to Claude through separate connectors. All workspace-specific skills (Waves, Tharun Personal, Koodu) depend on this skill for tool usage patterns.

**Read this skill before any Notion operation. Workspace skills should reference this skill, not duplicate its content.**

---

## ⚠️ CRITICAL: Data Source Paradigm (Notion API v2025-09-03)

**READ THIS SECTION FIRST. Every tool interaction depends on understanding this.**

Notion API v2025-09-03 introduced a "data_source" layer between databases and their properties. This affects how IDs work across the server:

### The Dual-ID System

Every database in Notion now has TWO IDs:

| ID Type | Where You Get It | What It Represents |
|---|---|---|
| **data_source_id** | `list_databases`, `query_database` results | The data layer that holds properties, rows, and schema |
| **database_id** | `page.parent.database_id`, Notion URLs | The container object (metadata, title, icon) |

**These are DIFFERENT IDs for the SAME database.** Mixing them up causes "not found" errors.

### What the Server Does Automatically

**The server handles all ID resolution transparently.** You do NOT need to manually convert between ID types. Specifically:

- **`query_database`** - accepts either ID type (tries data_source endpoint first, falls back to database endpoint)
- **`get_database_schema`** - accepts either ID type (resolves through data_sources to find properties)
- **`create_page`** with `database_id` - accepts either ID type (resolves data_source_id to real database_id automatically)
- **`update_database`** - accepts either ID type (writes to both database AND data_source for property changes)
- **`create_database`** - creates DB then patches data_source for properties (all automatic)
- **`views`** - accepts either ID type (resolves both IDs internally via `resolveViewIds`)
- **`update_page`** with properties - accepts page ID, fetches parent DB ID automatically for schema lookup

### The One Rule You Must Follow

**Use IDs exactly as the tools return them. Do not try to convert or look up alternative IDs.**

- `list_databases` returns data_source_ids → use these for `query_database`, `get_database_schema`, `views`, `create_page`, and `update_database`
- `search_pages` returns page_ids → use these for `read_page`, `update_page`, `get_children`, `comments`, and `duplicate_page`
- Both work interchangeably for most operations because the server resolves them

### Why This Matters

On v2025-09-03, `GET /databases/{id}` returns NO properties - they moved into data_sources. `POST /databases` silently ignores non-title properties. `PATCH /databases/{id}` for properties returns success but doesn't update. The server works around ALL of these by routing property operations through the `/data_sources/` endpoint automatically.

---

## Connector Mapping

Each workspace has its own connector. Claude routes to the right workspace by which connector's tools it calls.

| Workspace | Connector Name | Tool Prefix | When to Use |
|---|---|---|---|
| Tharun Personal | Notion-Workspace-Tharun | `mcp__52757b90__` | Personal tasks, projects, learning, content, MCP infrastructure |
| Waves Company | Notion-Workspace-Waves | `mcp__3b1e8119__` | Waves studio operations, products, orders, content, R&D |
| Koodu Architecture | Notion-Workspace-Koodu | `mcp__2ae0488b__` | Architecture projects, tasks, clients, content, drawings |

**How to pick the connector:** Match the user's intent to the workspace. If the user says "update my tasks," use Tharun Personal. If they say "log the new lamp prototype," use Waves. If they say "mark the Koodu task as done," use Koodu. When ambiguous, ask.

**Important:** MCP ID prefixes may change if connectors are recreated. If tools fail with "unknown tool," the connector may have been refreshed. Check the system-reminder's deferred tools list for current prefixes.

---

## Tools Reference (15 per workspace)

### Tool Organization

Tools are organized by function:

**READ (6):** search_pages, read_page, get_children, query_database, list_databases, get_database_schema
**WRITE (6):** create_page, update_page, update_database, create_database, duplicate_page, move_page
**VIEWS (1):** views (consolidated: create/update/delete view)
**COMMENTS (1):** comments (consolidated: get/create/reply comments)
**FILES (1):** upload_file (attach files to pages)

### Discovery Tools - Use These First

#### `list_databases`
Lists all databases visible to the integration with names, IDs, and property names/types.

**When:** Starting a new conversation, or when you don't know which database to target.
**Pattern:** Call with no arguments to get everything, or pass `query` to filter by name.

```
list_databases
list_databases { "query": "Task" }
```

#### `get_children`
Browse the workspace page tree. Returns child pages and databases under a given page.

**When:** Discovering workspace structure, finding pages that aren't databases.
**Pattern:** Call with no arguments for top-level items. Pass `page_id` to go deeper.

```
get_children                              # top-level workspace items
get_children { "page_id": "abc123..." }   # children of a specific page
```

#### `get_database_schema`
Returns the full schema of one database - all property names, types, and valid option values for select/multi_select/status fields.

**When:** ALWAYS call this before `create_page` or `update_page` with properties. You need to know the exact property names and valid option values.
**Pattern:** Pass the database ID from `list_databases` or `get_children`.

```
get_database_schema { "database_id": "abc123..." }
```

**This is the most important workflow rule: schema first, then write.**

### Read Tools

#### `search_pages`
Full-text search across the workspace. Searches page titles and body content (not database property values).

**When:** Finding a specific page or database by name or content keywords.
**Pattern:** Returns up to 20 results. Use `start_cursor` from response for pagination.

```
search_pages { "query": "MCP server", "page_size": 10 }
```

#### `read_page`
Reads a page's full content as markdown. Returns title, all properties as flat key-values, parent location, and the entire body.

**When:** You have a page ID and need its content or properties.
**Pattern:** Works for both standalone pages and database rows.

```
read_page { "page_id": "abc123..." }
```

#### `query_database`
Query a database with optional filters and sorts. Returns rows with flat key-value properties.

**When:** You need specific rows from a database based on conditions.
**Pattern:** Supports Notion's full filter syntax including compound AND/OR. Max 50 rows per call, paginated.

```
# Simple filter
query_database {
  "database_id": "abc123...",
  "filter": { "property": "Status", "status": { "equals": "In progress" } },
  "sorts": [{ "property": "Due Date", "direction": "ascending" }],
  "page_size": 20
}

# Compound filter
query_database {
  "database_id": "abc123...",
  "filter": {
    "and": [
      { "property": "Status", "status": { "does_not_equal": "Done" } },
      { "property": "Priority", "select": { "equals": "High" } }
    ]
  }
}
```

### Write Tools

#### `create_page`
Creates a standalone page or a database row.

**For standalone pages:** Provide `title`, `parent_id`, and optional `content` (markdown), `icon`, and `cover_url`.
**For database rows:** Provide `title`, `database_id`, flat `properties`, and optional `content`, `icon`, and `cover_url`.

**CRITICAL:** Always call `get_database_schema` first when creating database rows. You must use exact property names and valid option values.

```
# Standalone page with icon and cover
create_page {
  "title": "Meeting Notes",
  "parent_id": "parent-page-id...",
  "icon": "📝",
  "cover_url": "https://example.com/cover.jpg",
  "content": "## Agenda\n\n- Item 1\n- Item 2"
}

# Database row with properties
create_page {
  "title": "Fix the login bug",
  "database_id": "task-db-id...",
  "icon": "🐛",
  "properties": {
    "Status": "In progress",
    "Priority": "High",
    "Tags": ["Website", "Bug"],
    "Due": "2026-04-15",
    "Summary": "Users can't log in on mobile"
  },
  "content": "### Steps to reproduce\n\n1. Open app on iOS\n2. Tap login\n3. Nothing happens"
}
```

**Property types the server handles:**

| Type | Format | Example |
|---|---|---|
| Title | String | `"Task name": "Fix bug"` |
| Rich text | String | `"Summary": "some text"` |
| Select | String (exact match) | `"Priority": "High"` |
| Multi-select | Array of strings | `"Tags": ["Website", "Bug"]` |
| Status | String (exact match) | `"Status": "In progress"` |
| Date | ISO string or object | `"Due": "2026-04-15"` or `"Due": {"start": "2026-04-15", "end": "2026-04-20"}` |
| Number | Number | `"Amount": 150` |
| Checkbox | Boolean | `"Done": true` |
| URL | String | `"Link": "https://example.com"` |
| Email | String | `"Email": "person@example.com"` |
| Phone | String | `"Phone": "+1234567890"` |
| Relation | String (name) | `"Project": "Project Name"` (server resolves name to ID) |
| People | String (name) | `"Assignee": "Tharun"` (server resolves name to user ID) |

**Cannot create root-level workspace pages** - Notion API requires a parent page for internal integrations. Always provide `parent_id`.

#### `update_page`
Updates an existing page or database row. Can update any combination of: properties, title, content, archive status, icon, cover.

**Pattern:** Only include what you want to change. Other fields stay untouched.

```
# Update properties on a database row
update_page {
  "page_id": "row-id...",
  "properties": { "Status": "Done", "Priority": "Low" }
}

# Rename a page and add cover
update_page {
  "page_id": "page-id...",
  "title": "New Title",
  "cover_url": "https://example.com/cover.jpg"
}

# Append content to the bottom of a page
update_page {
  "page_id": "page-id...",
  "append_content": "## New Section\n\nAdded by Claude."
}

# Replace ALL content (destructive - deletes existing body first)
update_page {
  "page_id": "page-id...",
  "replace_content": "## Fresh Start\n\nAll previous content is gone."
}

# Archive (soft-delete) a page
update_page { "page_id": "page-id...", "archived": true }
```

**CRITICAL:** `replace_content` deletes ALL existing blocks before writing, **including child page blocks**. In Notion, child pages appear as blocks inside their parent. If a page has nested child pages, using `replace_content` will permanently delete those child pages (not just unlink them - they get archived/trashed). **NEVER use `replace_content` on a page that has child pages.** Always use `append_content` instead, or use `get_children` first to check for nested pages. When in doubt, use `append_content`.

#### `update_database`
Modifies a database's structure (columns), not its rows. Use `update_page` for rows.

```
# Add a select column
update_database {
  "database_id": "db-id...",
  "add_properties": {
    "Review Status": { "select": { "options": [{"name": "Pending"}, {"name": "Approved"}] } }
  }
}

# Add simple columns (no options needed)
update_database {
  "database_id": "db-id...",
  "add_properties": {
    "Notes": { "rich_text": {} },
    "Due Date": { "date": {} },
    "Done": { "checkbox": {} }
  }
}

# Rename a column
update_database {
  "database_id": "db-id...",
  "update_properties": { "Old Name": { "name": "New Name" } }
}

# Remove a column (destructive - deletes all data in that column)
update_database {
  "database_id": "db-id...",
  "remove_properties": ["Column To Remove"]
}
```

#### `create_database`
Creates a new database inside a parent page with typed columns.

**When:** You need a new database (not a table block - an actual queryable database with typed properties).
**Pattern:** Always provide a parent_id. A "Name" title property is auto-created. Define additional columns in properties.

```
create_database {
  "parent_id": "parent-page-id...",
  "title": "Project Tasks",
  "properties": {
    "Status": { "type": "select", "select": { "options": [{"name": "Todo"}, {"name": "In progress"}, {"name": "Done"}] } },
    "Priority": { "type": "select", "select": { "options": [{"name": "High"}, {"name": "Medium"}, {"name": "Low"}] } },
    "Due Date": { "type": "date" },
    "Assignee": { "type": "people" },
    "Notes": { "type": "rich_text" }
  }
}
```

#### `duplicate_page`
Copies a page or database row under the same parent. Title gets "(copy)" appended. Copies all writable properties and block content (2 levels deep). Read-only properties (formulas, rollups, timestamps) are skipped.

```
duplicate_page { "page_id": "page-id..." }
```

#### `move_page`
Re-parents a page to a new location. Keeps all content and the same ID.

```
# Move under another page
move_page { "page_id": "page-id...", "new_parent_id": "target-page-id..." }

# Move into a database (becomes a row)
move_page {
  "page_id": "page-id...",
  "new_parent_id": "database-id...",
  "parent_type": "database_id"
}
```

#### `views`
Manages database views (tabs) with consolidated create/update/delete actions. Controls how rows are displayed.

**Best practice:** Use the database ID from `list_databases` for creating views. The server resolves IDs automatically, but `list_databases` is the most reliable source for database IDs. See the Data Source Paradigm section at the top for details.

**Action parameter:** `create`, `update`, or `delete`.
**Types:** `table` (spreadsheet), `board` (kanban), `calendar` (date-based), `list` (simple), `timeline` (gantt), `gallery` (cards).

```
# Create a simple table view
views {
  "action": "create",
  "database_id": "db-id...",
  "type": "table",
  "title": "All Tasks"
}

# Create a kanban board filtered to active items
views {
  "action": "create",
  "database_id": "db-id...",
  "type": "board",
  "title": "Active Board",
  "filter": { "property": "Status", "status": { "does_not_equal": "Done" } },
  "sorts": [{ "property": "Priority", "direction": "ascending" }]
}

# Update view filter
views {
  "action": "update",
  "view_id": "view-id...",
  "filter": { "property": "Status", "status": { "equals": "In progress" } }
}

# Delete a view
views {
  "action": "delete",
  "view_id": "view-id..."
}
```

#### `comments`
Manages page comments and discussion threads with consolidated get/create/reply actions.

**Action parameter:** `get` (list comments on page), `create` (new comment on page), `reply` (respond to discussion thread).

```
# List all comments on a page
comments {
  "action": "get",
  "page_id": "page-id..."
}

# Create a new comment on a page
comments {
  "action": "create",
  "page_id": "page-id...",
  "text": "This needs review before publishing."
}

# Reply to an existing comment thread
comments {
  "action": "reply",
  "discussion_id": "discussion-id...",
  "text": "Good point! I've updated the content."
}
```

#### `upload_file`
Uploads files to a page and creates file blocks. Supports images, PDFs, and documents up to 20MB.

**Parameters:** `page_id`, `filename`, and either `url` (external file URL) or `base64` (encoded file data). Optional `content_type`.

```
# Upload from external URL
upload_file {
  "page_id": "page-id...",
  "filename": "product-photo.jpg",
  "url": "https://example.com/photos/product.jpg"
}

# Upload base64-encoded file
upload_file {
  "page_id": "page-id...",
  "filename": "document.pdf",
  "base64": "JVBERi0xLjQKJeLj...",
  "content_type": "application/pdf"
}
```

---

## Workflow Patterns

### Pattern 1: Read Before Write (most common)

Always read the current state before updating. This prevents overwriting newer data or using stale property values.

```
1. get_database_schema  ->  know the exact property names and valid options
2. query_database or read_page  ->  see current state
3. create_page or update_page  ->  make the change
```

### Pattern 2: Discovery First

When starting a conversation or working with an unfamiliar workspace:

```
1. list_databases  ->  see all available databases
2. get_children    ->  see the page tree structure
3. get_database_schema  ->  inspect the specific database you need
```

### Pattern 3: Cross-Workspace Read

When a task reads from multiple workspaces (e.g., morning briefing):

```
1. query_database on Tharun Personal tasks  (mcp__52757b90)
2. query_database on Waves tasks            (mcp__3b1e8119)
3. query_database on Koodu tasks            (mcp__2ae0488b)
4. Compile results locally
```

### Pattern 4: Bulk Row Updates

When updating multiple rows in a database:

```
1. get_database_schema  ->  once (cache the property info mentally)
2. query_database  ->  get the rows you need to update
3. update_page  ->  one call per row (no batch update API)
```

### Pattern 5: Consolidated Tool Pattern

Some tools use an `action` parameter to bundle related operations into one tool, reducing token overhead:

- `views` with action: `create`, `update`, `delete` - all view management
- `comments` with action: `get`, `create`, `reply` - all comment operations
- `upload_file` - standalone file upload

Example: Instead of separate `create_view` and `delete_view` tools, call `views` with the desired action. This keeps the tool list compact while maintaining full functionality.

---

## Markdown Syntax for Writing

When providing `content`, `append_content`, or `replace_content`, use these patterns. The server converts them to native Notion blocks with proper formatting.

| Syntax | Notion Block |
|---|---|
| `# Heading` | Heading 1 |
| `## Heading` | Heading 2 |
| `### Heading` | Heading 3 |
| `**bold**` | Bold annotation |
| `*italic*` | Italic annotation |
| `` `code` `` | Code annotation |
| `~~strikethrough~~` | Strikethrough annotation |
| `***bold italic***` | Bold + italic annotation |
| `[text](url)` | Link |
| `- item` | Bulleted list |
| `1. item` | Numbered list |
| `- [x] done` / `- [ ] todo` | To-do with checkbox |
| ` ```lang ... ``` ` | Code block with language |
| `> text` | Quote block |
| `> 💡 text` | Callout block (emoji prefix) |
| `> [!note] text` | Callout block (admonition) |
| pipe-delimited table | Table block (simple grid, not a database) |
| `![alt](url)` | Image block (external URL) |
| Bare URL on its own line | Bookmark block |
| `<details><summary>Title</summary>` ... `</details>` | Toggle block |
| `---` | Divider |

**Note:** Markdown tables create Notion table blocks (simple grids), NOT databases. To create actual databases with typed properties and views, use `update_database` to define columns and `create_page` with `database_id` to add rows.

---

## Known Limitations

| Limitation | Type | Workaround |
|---|---|---|
| Cannot create root-level workspace pages | Notion API | Always provide `parent_id` |
| Cannot set page fonts (default/serif/mono) | Notion API | Change in Notion UI manually |
| Notion-hosted file blocks cannot be duplicated | Server design | duplicate_page skips images uploaded via Notion UI (only external URLs work) |
| Cannot archive databases via API | Notion API | Only pages can be archived with update_page. Databases must be trashed manually in Notion UI. |
| No authentication on server | Design choice | URL is obscure. Will add Cloudflare Access if needed. |
| Connector tool caching | Claude.ai behavior | If new tools don't appear after server update, disconnect and recreate connector |
| 30K character response limit | Server design | Large pages get truncated. Use targeted queries instead of full page reads. |
| Relations resolve by title match | Server design | If two pages in the related DB have the same title, the first match wins. Use page ID for precision. |
| People resolve by display name | Server design | Name must match exactly. Server caches user list for 5 minutes. |
| `replace_content` deletes child pages | Notion API behavior | NEVER use replace_content on pages with child pages. Use append_content or get_children first to check. |
| Upload capped at 20MB per file | Notion API | Split large files or use external links |
| Views API: no update/delete for default view | Notion API | Only custom views can be modified or deleted |
| Link previews not supported | Notion API | Use bookmark blocks (bare URLs) instead |

---

## For Workspace Skill Authors

When writing a workspace-specific skill (e.g., `waves-notion-manager`, `tharun-notion-manager`):

### 1. Reference This Skill

Start your skill with:
```
This skill depends on the notion-server base skill.
Read /mnt/.claude/skills/notion-server/SKILL.md first for tool usage patterns.
```

### 2. What to Include in Your Workspace Skill

- The connector name and tool prefix for your workspace
- Database IDs and page IDs specific to your workspace
- Business logic (what to update when, status meanings, workflow rules)
- Cross-skill references (e.g., "for content updates, trigger waves-social-media-manager")

### 3. What NOT to Duplicate

- Tool usage patterns (they're in this skill)
- Property format syntax (it's in this skill)
- Markdown syntax reference (it's in this skill)
- Known limitations (they're in this skill)

---

## Server Details

| | |
|---|---|
| **Deployment** | Cloudflare Workers (free tier) |
| **URL** | `https://notion-mcp-server.tharun-mcp.workers.dev` |
| **GitHub** | `notion-mcp-server` repo |
| **Protocol** | MCP over Streamable HTTP (JSON-RPC 2.0, no SDK) |
| **Notion API** | v2025-09-03 |
| **Server Version** | 3.0.1 |
| **Databases Connected** | 46 total (16 Personal + 16 Waves + 14 Koodu) |
