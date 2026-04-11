# Notion MCP Server

A custom MCP (Model Context Protocol) server that connects multiple Notion workspaces to Claude through a single Cloudflare Worker. Built for personal use - one deployment, multiple workspaces, full read/write access.

## What It Does

- Serves 14 MCP tools per workspace over Streamable HTTP (stateless JSON-RPC 2.0)
- Converts between Markdown and Notion blocks bidirectionally
- Handles property formatting server-side - Claude sends flat key-values like `{"Status": "Done", "Priority": "P1"}`, the server converts to Notion's nested API format
- Resolves relation and people fields by name (no UUIDs needed from Claude)
- Validates against database schemas before writing

## Architecture

Single Cloudflare Worker with path-based routing:

```
/notion/personal/mcp  ->  Personal workspace
/notion/koodu/mcp     ->  Koodu Architecture workspace
/notion/waves/mcp     ->  Waves Company workspace
```

Each path is registered as a separate custom connector in Claude.ai. Claude routes to the right workspace by connector name.

See [ARCHITECTURE.md](ARCHITECTURE.md) for full design details.

## Tools (14 per workspace)

### Read (6)

| Tool | Purpose |
|------|---------|
| `search_pages` | Full-text search across workspace (paginated) |
| `read_page` | Read page content as markdown with flat properties |
| `get_children` | Browse workspace page tree |
| `query_database` | Query with compound filters and sorts (paginated) |
| `list_databases` | List all databases with property schemas |
| `get_database_schema` | Full schema with option values for one database |

### Write (8)

| Tool | Purpose |
|------|---------|
| `create_page` | Create standalone pages or database rows with typed properties |
| `update_page` | Update properties, title, content (append/replace), or archive |
| `update_database` | Add/rename/remove columns, update select options |
| `create_database` | Create a new database with typed columns inside a parent page |
| `duplicate_page` | Copy a page or database row with all properties and content |
| `move_page` | Re-parent a page to another page or database |
| `create_view` | Create database views (table, board, calendar, list, timeline, gallery) |
| `update_view` | Modify a view's type, title, filters, or sorts |

## Setup

### Prerequisites

- Node.js 18+
- Cloudflare account
- Notion internal integration(s) with pages shared

### Deploy

```bash
npm install
npx wrangler login

# Store secrets (one per workspace)
npx wrangler secret put NOTION_TOKEN_PERSONAL
npx wrangler secret put NOTION_TOKEN_KOODU
npx wrangler secret put NOTION_TOKEN_WAVES

npx wrangler deploy
```

### Add a New Workspace

1. Create a Notion internal integration at [notion.so/my-integrations](https://notion.so/my-integrations)
2. Share the relevant pages with the integration
3. Add the workspace ID to the routing in `src/index.ts`
4. Store the token: `npx wrangler secret put NOTION_TOKEN_<WORKSPACE>`
5. Deploy: `npx wrangler deploy`
6. Register a custom connector in Claude.ai pointing to `/notion/<workspace>/mcp`

### Register Connector in Claude.ai

1. Go to Claude.ai -> Settings -> Connectors -> Add Custom Connector
2. Name it descriptively (e.g., `Notion-Workspace-Personal`)
3. URL: `https://<your-worker>.workers.dev/notion/<workspace>/mcp`
4. Enable in conversations

## Configuration

All configuration is in `wrangler.toml`. Secrets are stored in Cloudflare (never in code):

| Secret | Purpose |
|--------|---------|
| `NOTION_TOKEN_PERSONAL` | Personal workspace integration token |
| `NOTION_TOKEN_KOODU` | Koodu workspace integration token |
| `NOTION_TOKEN_WAVES` | Waves workspace integration token |

## Supported Markdown (Write)

When writing content to Notion, the server parses these markdown patterns into native Notion blocks:

- **Headings** - `# H1`, `## H2`, `### H3`
- **Rich text** - `**bold**`, `*italic*`, `` `code` ``, `~~strikethrough~~`, `[links](url)`
- **Lists** - bulleted (`- item`), numbered (`1. item`), to-do (`- [x] done`)
- **Code blocks** - fenced with language (` ```typescript `)
- **Quotes** - `> text`
- **Callouts** - `> emoji text` or `> [!note] text`
- **Tables** - pipe-delimited markdown tables
- **Toggles** - `<details><summary>Title</summary>`
- **Images** - `![alt](url)`
- **Bookmarks** - bare URLs on their own line
- **Dividers** - `---`

## Known Limitations

These are Notion API limitations, not server limitations:

- Cannot create root-level workspace pages (internal integrations require a parent page)
- Cannot set page fonts (default/serif/mono) - Notion UI-only setting

## Tech Stack

- **Runtime:** Cloudflare Workers (free tier)
- **Language:** TypeScript
- **Protocol:** MCP over Streamable HTTP (JSON-RPC 2.0, no SDK dependency)
- **API:** Notion API v2022-06-28
