# Notion MCP Server - Build Log

**Project:** Custom Notion MCP Server for Claude
**Deployment:** Cloudflare Workers at `notion-mcp-server.tharun-mcp.workers.dev`
**Author:** Tharun
**Date Range:** April 2026

---

## v1.0 - Foundation (Session 1-2)

### What Was Built
The initial Notion MCP server connecting one workspace (Tharun Personal) to Claude via Cloudflare Workers. Implemented MCP over Streamable HTTP using raw JSON-RPC 2.0 - no SDK, no dependencies beyond the Notion API client.

### Architecture Decisions
- Cloudflare Workers chosen for stateless API hosting (sub-10ms cold starts, 100K free requests/day)
- Service-based URL routing: `/notion/personal/mcp`, `/notion/waves/mcp`, `/notion/koodu/mcp`
- No authentication - URL is obscure, Cloudflare Access can be added later
- Server handles all property formatting server-side so Claude sends simple flat key-value objects
- Markdown-to-Notion block conversion built from scratch (headings, lists, code blocks, tables, toggles, callouts, images, bookmarks, dividers)

### Initial Tools (9 per workspace)
- search_pages, read_page, get_children, query_database, list_databases, get_database_schema
- create_page, update_page, update_database

### Key Capabilities
- Property format builder converts flat key-values to Notion's nested format
- Relation and people properties resolved by name (server looks up UUIDs)
- Inline markdown formatting (bold, italic, code, strikethrough, links) parsed into Notion rich text annotations
- 30K character response truncation to stay within Claude's context limits

---

## v1.x - Multi-Workspace Expansion (Session 2-3)

### What Changed
Expanded from 1 workspace to 3: Tharun Personal, Waves Company, and Koodu Architecture. Each workspace gets its own URL path and Claude connector.

### Connectors Created
| Connector Name | Path | Workspace |
|---|---|---|
| Notion-Workspace-Tharun | /notion/personal/mcp | Personal (12 DBs) |
| Notion-Workspace-Waves | /notion/waves/mcp | Waves Company (16 DBs) |
| Notion-Workspace-Koodu | /notion/koodu/mcp | Koodu Architecture (12 DBs) |

### Issues Discovered
- Old connector names (tharun-notion-workspace, etc.) caused tool caching issues - Claude kept seeing stale tool definitions
- Fix: Renamed connectors to Notion-Workspace-{Name} pattern, which forced Claude to reload tool schemas

---

## v2.0 - Production Deployment (Session 4)

### What Was Built
Full regression test of all 9 tools across all 3 workspaces from Cowork. 16/16 operations passed. Server declared production-ready.

### Verification
- Tested search_pages, read_page, get_children on all 3 workspaces
- Tested query_database with filters and sorts
- Tested create_page for both standalone pages and database rows
- Tested update_page with property updates, title changes, content append/replace, archiving
- Tested update_database with add/rename/remove columns
- All property types verified: title, rich_text, select, multi_select, status, date, number, checkbox, URL, email, phone, relation, people

---

## v2.2.0 - New Tools (Session 5)

### What Was Added
Five new tools expanding write capabilities:
- **create_database** - create new databases with typed columns inside parent pages
- **duplicate_page** - copy pages/rows with all writable properties and 2-level deep block content
- **move_page** - re-parent pages to new locations (page or database)
- **create_view** - create database views (table, board, calendar, list, timeline, gallery)
- **update_view** - modify view filters, sorts, and properties

### Also Fixed
- Inline formatting parser for markdown-to-Notion conversion
- update_database format normalizer for property type definitions

---

## v3.0.0 - API v2025-09-03 Migration (Session 6)

### The Big Change
Upgraded Notion API from v2022-06-28 to v2025-09-03. This was the largest and most complex change, introducing the "data_source paradigm" where databases are now represented as data_source objects with their own separate IDs.

### What Changed

**API version bump:**
- wrangler.toml: NOTION_API_VERSION changed to "2025-09-03"
- index.ts: SERVER_VERSION bumped to "3.0.0"

**Tool consolidation (14 tools -> 15):**
- create_view and update_view merged into single `views` tool with action parameter (create/update/delete)
- New `comments` tool with action parameter (get/create/reply)
- New `upload_file` tool (base64 or URL, up to 20MB)
- Icon/cover support added to create_page and update_page

**Core technical changes:**
- `resolveViewIds()` method created to handle the dual-ID system (data_source_id vs database_id)
- `getDatabase()` got fallback to `/data_sources/` endpoint
- `stripBlockIds()` updated to filter out Notion-hosted file blocks (v2025-09-03 requires file_upload format)
- 429 rate limiting with Retry-After header and exponential backoff

### The Views API Saga (6 Deploy-Test-Fix Cycles)

This was the hardest problem in the entire project. The Views API on v2025-09-03 requires both a `database_id` and a `data_source_id`, but they are DIFFERENT IDs.

**Cycle 1:** "Page or database not found" - resolveDataSourceId failed silently, fell back to wrong ID.

**Cycle 2:** Same error - both GET /databases/{id} and GET /data_sources/{id} return 404 when given the wrong ID type.

**Cycle 3:** "body.data_source_id should be defined" - Views API requires data_source_id field that we weren't sending.

**Cycle 4:** "Page or database not found" with both IDs having the same value - the data_source_id was wrong because we were using the database_id for both.

**Cycle 5:** Added debug dump to inspect raw search response. Discovered the object structure: `{object: "data_source", id: "DS_ID", parent: {database_id: "REAL_DB_ID"}}`.

**Cycle 6 (FINAL FIX):** Created `resolveViewIds()` that searches all data_sources, matches by ID, and extracts both IDs from the response.

### Duplicate Page File Block Fix
After views were working, duplicate_page started failing on pages with Notion-uploaded images. On v2025-09-03, Notion requires `file_upload` format for uploaded files, but existing blocks use the old `file` format. Fix: `stripBlockIds()` now filters out blocks where type is image/file/video/pdf/audio AND data.type is "file".

### Other Issues
- Wikipedia URLs return 403 for upload_file (non-browser user agent blocked) - not a server bug
- Cannot create workspace-level pages (API requires parent_id on v2025-09-03)

---

## v3.0.1 - Comprehensive Data Source Fixes (Session 7)

### Overview
This was the most complex debugging session - four separate bugs all caused by the same root issue: Notion API v2025-09-03 moved ALL property operations to the `/data_sources/` endpoint, but the `/databases/` endpoint still returns 200 with `{object: "database"}` (no 404!), making failures silent and hard to detect.

### Bug 1: Property Update Crash
**Symptom:** `update_page` with properties failed with "Cannot read properties of undefined (reading 'Status')".
**Root Cause:** `GET /databases/{data_source_id}` returns 200 with `object: "database"` but NO `properties` key. The response has a `data_sources` array instead. Since there's no 404, the catch block never runs.
**Fix:** `fetchDatabaseSchema` in `properties.ts` now checks `db.data_sources[0]` for embedded properties, and fetches `GET /data_sources/{id}` as fallback. Also made `NotionClient.request()` public so fetchDatabaseSchema can call it directly.

### Bug 2: create_database Silently Dropping Properties
**Symptom:** `create_database` with 5 properties returns success showing all 5, but `get_database_schema` only shows "Name" (the title property).
**Root Cause:** `POST /databases` on v2025-09-03 silently ignores all non-title properties.
**Fix:** `createDatabase()` now creates DB with just the title property, then PATCHes `/data_sources/{ds_id}` with the remaining properties.

### Bug 3: update_database Not Updating Properties
**Symptom:** `update_database` to add columns returns success but columns don't appear.
**Root Cause:** `PATCH /databases/{id}` with properties returns success but doesn't actually write them on v2025-09-03.
**Fix:** `updateDatabase()` now does a dual write - PATCHes both `/databases/{real_db_id}` (for title/description) AND `/data_sources/{ds_id}` (for properties).

### Bug 4: create_page Failing with list_databases IDs
**Symptom:** `create_page` with `database_id` from `list_databases` fails with "Page or database not found".
**Root Cause:** `POST /pages` requires the real database_id, not a data_source_id. `list_databases` returns data_source_ids.
**Fix:** `createPage()` now calls `resolveViewIds()` to convert data_source_id to real database_id before creating the page.

### Key Technical Discovery
On v2025-09-03, `/databases/{id}` is essentially a read-only metadata container. ALL property-related operations (read schema, create properties, update properties) must go through `/data_sources/{id}`. The dangerous part is that `/databases/` returns 200 for data_source_ids - it doesn't 404, making it impossible to detect the wrong endpoint via error handling alone. You have to check for the presence of the `properties` key.

### Files Changed
- `src/notion.ts` - getDatabase(), createDatabase(), updateDatabase(), createPage() all rewritten; new resolveDataSourceIdForDb() helper; request() made public
- `src/properties.ts` - fetchDatabaseSchema() complete rewrite with data_source fallback chain
- `src/tools.ts` - update_page handler checks both parent.database_id and parent.data_source_id
- `src/index.ts` - SERVER_VERSION bumped to "3.0.1"
- `SKILL.md` - Added comprehensive Data Source Paradigm section

### End-to-End Test Results (all 15 tools verified)
list_databases ✅ | search_pages ✅ | get_children ✅ | read_page ✅ | get_database_schema ✅ | query_database ✅ | create_page (standalone) ✅ | create_page (database row with data_source_id) ✅ | update_page (properties) ✅ | create_database ✅ | update_database ✅ | views create ✅ | views delete ✅ | comments create ✅ | comments get ✅ | duplicate_page ✅ | move_page ✅ | upload_file ✅

---

## Final State

### Server Stats
- **Version:** 3.0.1
- **Tools:** 15 per workspace (45 total across 3 workspaces)
- **Workspaces:** 3 (Tharun Personal, Waves Company, Koodu Architecture)
- **Databases connected:** 40+
- **Platform:** Cloudflare Workers (free tier)
- **Notion API:** v2025-09-03

### File Structure
```
notion-mcp-server/
├── src/
│   ├── index.ts       - Worker entry point, JSON-RPC routing
│   ├── notion.ts      - Notion API client (all HTTP calls)
│   ├── tools.ts       - 15 tool definitions and execution logic
│   ├── properties.ts  - Property format builder and schema fetcher
│   ├── markdown.ts    - Markdown <-> Notion block converter
│   └── types.ts       - TypeScript type definitions
├── wrangler.toml      - Cloudflare Workers config
├── tsconfig.json      - TypeScript config
├── package.json       - Dependencies
├── README.md          - Project documentation
└── SKILL.md           - Claude skill reference (v3.0)
```

### Lessons Learned
1. The Notion API v2025-09-03 data_source paradigm is a fundamental shift - IDs that used to be database_ids are now data_source_ids, and the real database_id is buried in the parent object.
2. Always debug-dump raw API responses when an endpoint returns unexpected errors. The Views API fix only happened because we inspected the actual data_source object structure.
3. Tool consolidation (single tool with action parameter) significantly reduces token overhead in Claude's context window.
4. File blocks uploaded through the Notion UI use a format that cannot be re-created via the API on v2025-09-03 - the only option is to skip them during duplication.
5. Rate limiting (429 handling) is essential for any Notion API integration that does bulk operations.
