# Notion MCP Server

A multi-workspace Notion MCP (Model Context Protocol) server that runs as a single Cloudflare Worker. One deployment serves any number of Notion workspaces, each on its own route, each with its own integration token — so one Claude can read and write across your personal workspace, your studio, and your company without the tokens ever meeting.

Built and used in production as part of an "AI layer" for running an architecture practice: the live deployment at `mcp.tha.run` routes three workspaces (personal, Koodu Architecture, Waves) into Claude via three connectors. Fork it, deploy your own Worker, plug in your own workspaces.

## What It Does

- Serves 15 MCP tools per workspace over Streamable HTTP (stateless JSON-RPC 2.0)
- **Zero runtime dependencies** — the MCP protocol layer, Notion client, markdown converter, and property engine are all hand-rolled TypeScript (~3,500 lines). Nothing to audit but this repo.
- Converts between Markdown and Notion blocks bidirectionally
- Handles property formatting server-side — the model sends flat key-values like `{"Status": "Done", "Priority": "P1"}`, the server converts to Notion's nested API format and validates against the database schema before writing
- Resolves relation and people fields by name (no UUIDs needed from the model)
- Absorbs the Notion API v2025-09-03 dual-ID (`database_id` / `data_source_id`) migration so the model never has to think about it

## Architecture

```
Claude.ai connectors                 Cloudflare Worker                Notion API
┌──────────────────────┐
│ Notion-Workspace-A   │──┐
├──────────────────────┤  │   POST /notion/personal/mcp ──┐
│ Notion-Workspace-B   │──┼─▶ POST /notion/koodu/mcp    ──┼─▶ token per     ─▶ api.notion.com
├──────────────────────┤  │   POST /notion/waves/mcp    ──┘   workspace
│ Notion-Workspace-C   │──┘
└──────────────────────┘        Bearer auth (MCP_ACCESS_TOKEN)
```

One Worker, path-per-workspace routing. Each path is registered as a separate custom connector in Claude.ai; the model routes to the right workspace simply by which connector's tools it calls. Each workspace gets its own Notion integration token (stored as a Cloudflare secret), so a compromised or over-shared integration in one workspace never grants access to another.

Every request (except `/` and `/health`) requires `Authorization: Bearer <MCP_ACCESS_TOKEN>`. The comparison is timing-safe, and the server **fails closed** — if the token secret is unset, all requests get a 503 rather than an open door.

## Tools (15 per workspace)

### Read (6)
| Tool | Purpose |
|------|---------|
| `search_pages` | Full-text search across workspace (paginated) |
| `read_page` | Read page content as markdown with flat properties |
| `get_children` | Browse workspace page tree |
| `query_database` | Query with compound filters and sorts (paginated) |
| `list_databases` | List all databases with property schemas |
| `get_database_schema` | Full schema with option values for one database |

### Write (6)
| Tool | Purpose |
|------|---------|
| `create_page` | Create pages or database rows with icon, cover, typed properties |
| `update_page` | Update properties, title, content, icon, cover, or archive |
| `update_database` | Add/rename/remove columns, update select options |
| `create_database` | Create a new database with typed columns |
| `duplicate_page` | Copy a page with properties and content |
| `move_page` | Re-parent a page to another page or database |

### Views, Comments & Files (3)
| Tool | Purpose |
|------|---------|
| `views` | Create/update/delete database views (table, board, calendar, list, timeline, gallery) |
| `comments` | Get/create/reply to page comments |
| `upload_file` | Upload files (images, PDFs) to a page via URL or base64 |

## Setup

### Prerequisites

- Node.js 18+
- Cloudflare account
- Notion internal integration(s) with pages shared

### Deploy

```bash
npm install
npx wrangler login

# Auth token for the MCP endpoint itself — REQUIRED.
# Without it the server refuses all requests (503). Generate something long:
#   openssl rand -base64 32
npx wrangler secret put MCP_ACCESS_TOKEN

# One Notion integration token per workspace
npx wrangler secret put NOTION_TOKEN_PERSONAL
npx wrangler secret put NOTION_TOKEN_KOODU
npx wrangler secret put NOTION_TOKEN_WAVES

npx wrangler deploy
```

> **Warning:** `MCP_ACCESS_TOKEN` is what stands between the internet and full read/write access to every workspace you connect. Set it before anything else, and treat it like a password.

### Add a New Workspace

1. Create a Notion internal integration at [notion.so/my-integrations](https://notion.so/my-integrations) and share the relevant pages with it
2. Store the token: `npx wrangler secret put NOTION_TOKEN_<WORKSPACE>`
3. Register the workspace in code — four touchpoints, all small:
   - `src/types.ts` — add to the `WorkspaceId` union and `Env` interface
   - `src/index.ts` — add to the route regex, `getNotionToken()`, and the health-check list
   - `src/tools.ts` — add a display label to the workspace-name map
4. Deploy: `npx wrangler deploy`
5. Register a custom connector in Claude.ai pointing to `/notion/<workspace>/mcp`

### Register Connector in Claude.ai

1. Go to Claude.ai → Settings → Connectors → Add Custom Connector
2. Name it descriptively (e.g., `Notion-Workspace-Personal`)
3. URL: `https://<your-worker>.workers.dev/notion/<workspace>/mcp`
4. Enable in conversations

## Usage Example

Once connected, the model works in flat key-values — the server does the Notion-API gymnastics:

```jsonc
// Claude calls create_page on the koodu connector:
{
  "database_id": "25e5a1b2c3...",
  "title": "Site visit — Chettipalayam residence",
  "properties": {
    "Status": "Scheduled",
    "Assignee": "Tharun",        // resolved to a user ID by name
    "Project": "CH-04",          // relation resolved by title
    "Date": "2026-07-10"
  },
  "content": "## Agenda\n- Verify column grid\n- Approve brick sample"
}
```

The server validates each property against the live database schema, converts to Notion's nested format, resolves the people/relation fields, and writes the markdown as native Notion blocks. Errors come back as actionable messages ("Status: 'Scheduled' is not an option. Valid: Todo, In Progress, Done") instead of raw API failures.

## Configuration

All configuration is in `wrangler.toml`. Secrets are stored in Cloudflare (never in code):

| Secret | Purpose |
|--------|---------|
| `MCP_ACCESS_TOKEN` | **Required.** Bearer token protecting every MCP route — server fails closed without it |
| `NOTION_TOKEN_PERSONAL` | Personal workspace integration token |
| `NOTION_TOKEN_KOODU` | Koodu workspace integration token |
| `NOTION_TOKEN_WAVES` | Waves workspace integration token |

## Supported Markdown (Write)

When writing content to Notion, the server parses these markdown patterns into native Notion blocks:

- **Headings** - `# H1`, `## H2`, `### H3`
- **Rich text** - `**bold**`, `*italic*`, `` `code` ``, `~~strikethrough~~`, `[links](url)`
- **Lists** - bulleted (`- item`), numbered (`1. item`), to-do (`- [x] done`) — nested lists flatten to one level
- **Code blocks** - fenced with language (` ```typescript `)
- **Quotes** - `> text`
- **Callouts** - `> emoji text` or `> [!note] text`
- **Tables** - pipe-delimited markdown tables
- **Toggles** - `<details><summary>Title</summary>`
- **Images** - `![alt](url)`
- **Bookmarks** - bare URLs on their own line
- **Dividers** - `---`

## Agent Skill

[`SKILL.md`](SKILL.md) is a ready-to-use agent skill that teaches Claude (or any MCP-capable agent) how to drive this server well: the v2025-09-03 dual-ID paradigm, property formats, workflow patterns, and known limitations. Drop it into your agent's skill directory and point your workspace-specific skills at it.

## Known Limitations

These are Notion API limitations, not server limitations:

- Cannot create root-level workspace pages (internal integrations require a parent page)
- Cannot set page fonts (default/serif/mono) - Notion UI-only setting
- Notion-hosted file blocks cannot be duplicated (signed URLs expire)
- Workspace-level page creation requires parent_id on v2025-09-03

## Tech Stack

- **Runtime:** Cloudflare Workers (free tier)
- **Language:** TypeScript (strict), zero runtime dependencies
- **Protocol:** MCP over Streamable HTTP (JSON-RPC 2.0, no SDK dependency)
- **API:** Notion API v2025-09-03

## License

[MIT](LICENSE) © 2026 Tharun Eswar
