# Notion MCP Server - Build Log

**Project:** Unified Notion MCP Server at mcp.tha.run
**Architecture plan:** See `notion-mcp-architecture-plan.md`
**Started:** April 10, 2026

---

## How to Use This File

This file + the architecture plan together give any Claude session full context to continue the build. Read both at the start of any session related to this project.

- **Architecture plan** = the *what* and *why* (design decisions, tool specs, workspace structures)
- **This file** = the *where we are* (what's done, what's next, decisions made, blockers)

---

## Current Status

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 1: Foundation + All 3 Workspace Connections | **COMPLETE** | All 3 connectors live on Claude.ai. |
| Phase 1.5: Server v2 - Full Read/Write Capabilities | **DEPLOYED** | 9 tools, property builder, verified from Cowork. Connectors refreshed. |
| Phase 1.6: Server v2.1.0 - Inline Formatting Fix | **BUILT** | Needs `npx wrangler deploy` from Tharun's machine. |
| Phase 2: Personal Workspace Restructure | Not started | Depends on Phase 1 |
| Phase 3: Waves Skill Migration | Not started | Connector ready, skills need migration |
| Phase 4: Koodu Workspace Design + Skills | Not started | Connector ready, needs workspace design |
| Phase 5: Gemini Cloud | Not started | Future |
| Phase 6: Morning Briefing | Not started | Future |

---

## Session Log

### Session 1 - April 10, 2026 (Planning)

**What happened:**
- Tharun described the fragmentation problem across 3 Notion workspaces and 5 Claude surfaces
- Claude.ai had already produced a spec document (`personal-notion-mcp-spec.md`) for a single-workspace MCP on Cloudflare Workers
- Reviewed the spec, expanded scope to all 3 workspaces
- Reviewed all existing Waves skills (orientation, notion-manager, social-media-manager, website-updater, product-launcher) to understand current Notion integration patterns
- Created v1 of architecture plan
- Q&A session with 11 questions from Tharun - all addressed
- Created v2 of architecture plan incorporating all feedback

**Key decisions made:**
1. **URL structure:** `mcp.tha.run/notion/{workspace}/mcp` (not flat paths) - future-proofs for Gemini and other services
2. **All 3 workspaces** through custom MCP - official Notion connector will be retired
3. **One worker, three connectors** - single codebase, path-based routing, separate tokens
4. **Skills Registry database** per workspace to prevent skill sprawl
5. **Morning briefing** (Phase 6) as the cross-workspace task aggregation approach, not database sync
6. **Cowork builds the code**, manual `wrangler deploy` step by Tharun
7. **Two continuity files** (plan + this log) instead of a dedicated build skill

**Prerequisites confirmed ready:**
- [x] Personal Notion integration created and pages shared
- [x] Cloudflare account exists

**What's next:**
- Phase 1 build: scaffold Worker, implement 6 tools, markdown converter, routing, auth, deploy, verify

**Blockers:**
- None for Phase 1

### Session 1 (continued) - April 10, 2026 (Build)

**What happened:**
- Read MCP best practices guide and TypeScript SDK guide from the mcp-builder skill
- Decided to implement MCP JSON-RPC protocol directly (not via SDK) for Cloudflare Worker compatibility
- Scaffolded the project: package.json, tsconfig.json, wrangler.toml
- Implemented all source files:
  - `src/types.ts` - TypeScript interfaces for Env, JSON-RPC, Notion API
  - `src/notion.ts` - Notion API client using native fetch (no axios)
  - `src/markdown.ts` - Bidirectional Notion blocks ↔ Markdown converter + property simplification
  - `src/tools.ts` - 6 tool definitions and execution logic with 25K char response limit
  - `src/index.ts` - Worker entry point with path-based routing, bearer token auth, CORS, MCP protocol handling
- TypeScript compilation: clean (0 errors)
- Wrangler build: successful (55KB bundle, 13.7KB gzipped)
- Created `DEPLOY.md` with step-by-step deployment instructions

**Technical decisions:**
1. **No MCP SDK dependency** - implemented JSON-RPC protocol directly. Cleaner for Workers, zero dependencies, no transport adapter needed.
2. **Native fetch** - Workers have built-in fetch, no need for axios.
3. **Markdown with formatting** - Preserves bold/italic/code in markdown output (not just plain text). Gives Claude more context.
4. **25K character limit** - Large pages get truncated with a message. Prevents context bloat.
5. **Batch block writes** - Notion API limits 100 blocks per request; client auto-batches.
6. **Recursive block fetching** - Up to 3 levels deep, handles pagination at each level.

**What's next:**
- Tharun deploys to Cloudflare (wrangler login + secret put + deploy)
- Set up mcp.tha.run CNAME in Vercel DNS
- Register personal-workspace connector in Claude.ai
- Test on all 5 surfaces

**Blockers:**
- Deployment requires browser auth (wrangler login) - must be done by Tharun

### Session 1 (continued) - April 10, 2026 (Deploy + Verify)

**What happened:**
- Tharun ran `wrangler login`, stored secrets, deployed Worker
- Worker live at: `https://notion-mcp-server.tharun-mcp.workers.dev`
- Health check verified: returns server info + workspace list
- MCP initialize, tools/list, tools/call all tested and working
- `list_databases` returned 10 databases from personal workspace (Tasks, Meetings, Hub/wiki, Projects, Goals, Docs, Materials Required, Costs, Saved Links, Inspirations Board)
- Registered `personal-workspace` custom connector in Claude.ai
- **Claude.ai successfully queried the personal Notion workspace** - end-to-end working!
- Auth: removed bearer token requirement (Claude.ai connectors only support OAuth, not custom headers). Server now accepts all requests. Cloudflare Access can be added later for security.
- Custom domain (mcp.tha.run): CNAME added in Vercel but Cloudflare Custom Domains requires DNS to be on Cloudflare. Deferred - workers.dev URL works fine.

**Deployment details:**
- Workers subdomain: `tharun-mcp.workers.dev`
- Full URL: `https://notion-mcp-server.tharun-mcp.workers.dev`
- Personal endpoint: `/notion/personal/mcp`
- Bundle size: 56.95 KiB / gzip: 14.07 KiB
- Startup time: 15ms

**What's next:**
- Phase 2: Personal workspace restructure + skills
- Phase 3: Create Waves integration, store token, migrate skills
- Test on Claude Desktop, Claude Code, and mobile (should sync from Claude.ai connector)

**Phase 1 checklist:**
- [x] Cloudflare account + wrangler login
- [x] Personal Notion integration created, token stored
- [x] Worker project built (TypeScript, 0 errors)
- [x] 6 tools implemented with markdown conversion
- [x] Service-based routing (/notion/personal/, /notion/koodu/, /notion/waves/)
- [x] Deployed to Cloudflare Workers
- [x] Health check, initialize, tools/list, tools/call all verified
- [x] personal-workspace connector registered in Claude.ai
- [x] Claude.ai successfully queries personal Notion workspace
- [ ] Custom domain (mcp.tha.run) - deferred, requires DNS transfer
- [ ] Verify on Claude Desktop, Claude Code, mobile

---

## Decision Log

Significant decisions that affect future work, recorded here so they don't get lost.

| Date | Decision | Why |
|------|----------|-----|
| 2026-04-10 | URL pattern: /notion/{workspace}/mcp | Future-proofs for /gemini/ and other services |
| 2026-04-10 | Replace official Notion connector entirely | Custom gives better formatting, leaner context, 3-workspace access |
| 2026-04-10 | 6 tools per workspace, no more | Lean context window usage (~2-3K tokens per connector) |
| 2026-04-10 | Bearer token auth for MVP | Single-user server, simple is fine. Cloudflare Access later if multi-user needed. |
| 2026-04-10 | CNAME in Vercel DNS, not DNS migration | Simpler, no disruption to existing tha.run setup |
| 2026-04-10 | Morning briefing over database sync | Read-only aggregation avoids bidirectional sync complexity |
| 2026-04-10 | Skills Registry DB per workspace | Prevents skill sprawl, gives Claude a reference for what's available |
| 2026-04-10 | Direct MCP protocol (no SDK) | Cleaner on Workers, zero runtime dependencies, avoids Express adapter complexity |
| 2026-04-10 | Native fetch, no axios | Workers have built-in fetch; keeps bundle small and avoids compatibility issues |
| 2026-04-10 | No bearer token auth (removed) | Claude.ai custom connectors only support OAuth, not custom headers. Auth disabled for now. Add Cloudflare Access later. |
| 2026-04-10 | Custom domain deferred | mcp.tha.run requires DNS on Cloudflare. Workers.dev URL works fine. Revisit if DNS is transferred. |
| 2026-04-10 | Enhance existing tools over adding many new ones | Keeps tool count manageable (9 vs 12+). Property builder handles complexity server-side. |
| 2026-04-10 | Server-side property formatting | Claude sends flat key-values, server converts to Notion's nested format. Reduces token usage and errors. |
| 2026-04-10 | Name-to-ID resolution server-side | Relations and people accept names ("Kayalvizhil", "Tharun") - server resolves to UUIDs. Better than forcing Claude to search first. |
| 2026-04-10 | Unified Notion skill (not per-workspace) | One skill serves all 3 workspaces. Other skills reference it. Reduces duplication. |
| 2026-04-10 | CHARACTER_LIMIT 30K (up from 25K) | 9 tools with richer responses need slightly more headroom. Still well within context budget. |
| 2026-04-10 | Inline formatting parsed server-side | `richText()` now parses **bold**, *italic*, `code`, ~~strikethrough~~, links into Notion annotations. Code blocks use `plainRichText()` for literal content. |
| 2026-04-10 | `normalizePropertyConfig` for update_database | Accepts both simplified `{"type": "checkbox"}` and native `{"checkbox": {}}` formats. Server normalizes. |
| 2026-04-10 | Connectors renamed for clarity | New names: Notion-Workspace-Tharun, Notion-Workspace-Waves, Notion-Workspace-Koodu. Old names retired due to tool caching issue. |
| 2026-04-10 | Database views deferred, not blocked | Notion API supports views. Can add in future version. Not critical for current workflow. |

---

### Session 2 - April 10, 2026 (All 3 Workspaces Connected)

**What happened:**
- Tharun independently created Notion integrations for Waves and Koodu workspaces
- Stored `NOTION_TOKEN_WAVES` and `NOTION_TOKEN_KOODU` as Cloudflare Worker secrets
- Registered all 3 custom connectors in Claude.ai:
  - `tharun-notion-workspace` → `/notion/personal/mcp`
  - `waves-notion-workspace` → `/notion/waves/mcp`
  - `koodu-notion-workspace` → `/notion/koodu/mcp`
- All 3 connectors verified working on Claude.ai
- No code changes or redeployment needed - path routing + secrets worked as designed

**Q&A addressed:**
1. Waves/Koodu URLs - same base URL, different paths (already built into routing)
2. Claude workspace understanding - depends on connector name, explicit is better
3. Adding Waves - just store secret + register connector, no redeploy needed
4. Custom domain advantages - mostly cosmetic, workers.dev is fine for now
5. Path-based routing vs separate domains - one codebase, one deploy, shared logic wins

**Security discussion:**
- Server currently has no authentication (removed for Claude.ai OAuth-only limitation)
- Anyone with the URL can access the Notion data
- Practical risk is low (URL not public, not indexed)
- Options discussed: bearer token (breaks Claude.ai), lightweight OAuth flow (proper fix), Cloudflare Access
- Decision: keep open for now, revisit when sharing access or multi-user becomes real

**Connector naming note:**
- Tharun named them slightly differently than originally planned:
  - `tharun-notion-workspace` (not `personal-workspace`)
  - `waves-notion-workspace` (not `waves-workspace`)
  - `koodu-notion-workspace` (not `koodu-workspace`)
- The `*-notion-*` naming pattern is actually clearer since it specifies the service

**What's next:**
- Phase 2: Personal workspace restructure + skills
- Phase 3: Waves skill migration (connector already working, skills need to point to custom tools)
- Phase 4: Koodu workspace design + skills
- Test connectors on Claude Desktop, Claude Code, and mobile

**Phase 1 updated checklist:**
- [x] Cloudflare account + wrangler login
- [x] Personal Notion integration created, token stored
- [x] Waves Notion integration created, token stored
- [x] Koodu Notion integration created, token stored
- [x] Worker project built (TypeScript, 0 errors)
- [x] 6 tools implemented with markdown conversion
- [x] Service-based routing (/notion/personal/, /notion/koodu/, /notion/waves/)
- [x] Deployed to Cloudflare Workers
- [x] Health check, initialize, tools/list, tools/call all verified
- [x] tharun-notion-workspace connector registered in Claude.ai
- [x] waves-notion-workspace connector registered in Claude.ai
- [x] koodu-notion-workspace connector registered in Claude.ai
- [x] Claude.ai successfully queries all 3 Notion workspaces
- [ ] Custom domain (mcp.tha.run) - deferred, requires DNS on Cloudflare
- [ ] Verify on Claude Desktop, Claude Code, mobile

---

## Known Issues & Blockers

### Session 3 - April 10, 2026 (Server v2 - Full Capabilities Build)

**What happened:**
- Comprehensive capability audit of v1 server - identified that the 6 tools were read-heavy with limited write support
- Sonnet 4.6 ran an independent assessment via claude.ai, Opus 4.6 reviewed it and found factual errors (e.g., claimed update_page was missing when it existed, said only 5 tools when there were 6)
- Designed and built server v2 with 9 tools and a property format builder
- Queried all 40 databases across 3 workspaces to map full schema landscape:
  - Tharun Personal: 12 databases
  - Koodu Architecture: 12 databases
  - Waves Company: 16 databases

**New modules built:**
- `src/properties.ts` (615 lines) - Property format builder
  - Converts flat key-value pairs to Notion's nested API format
  - Covers ALL writable types: title, rich_text, number, select, multi_select, status, date, checkbox, url, email, phone_number, relation, people, files
  - Name-to-ID resolution for relation fields (searches related database by title)
  - Name-to-ID resolution for people fields (queries workspace users, cached 5 min)
  - Schema validation with helpful error messages for invalid options
  - Read-only field rejection (formula, rollup, created_time, etc.)
  - Case-insensitive property name matching

**New tools (3):**
1. `get_children` - Browse the workspace page tree. Lists child pages and child databases under any page, or top-level workspace items. Solves the "how do I discover non-database pages" problem.
2. `get_database_schema` - Returns full schema of one database including all select/status option values, relation targets, formula expressions, number formats, unique_id prefixes. Essential before writes.
3. `update_database` - Modify database structure: add/rename/remove properties, update select options.

**Enhanced tools (4):**
1. `create_page` - Now supports `database_id` for creating database rows with flat key-value `properties`. Auto-fetches schema and formats properties server-side.
2. `update_page` - Now supports `properties` for updating any database field (Status, Priority, Dates, etc.). Added `replace_content` for full page rewrites (deletes all blocks then writes new ones).
3. `query_database` - Added `start_cursor` for pagination. Increased max from 25 to 50 rows.
4. `search_pages` - Added `start_cursor` for pagination. Increased max from 10 to 20 results.

**Markdown writer expanded:**
- Tables: parses markdown table syntax into Notion table + table_row blocks
- Callouts: parses `> 💡 text` and `> [!note] text` into callout blocks
- Toggles: parses `<details><summary>` into toggle blocks with children
- Images: parses `![alt](url)` into external image blocks
- Bookmarks: parses bare URLs into bookmark blocks

**All tool responses now include:**
- Workspace label header (e.g., "Waves Company Workspace")
- Parent location info (workspace root, child of page X, row in database Y)

**Technical details:**
- Server version bumped to 2.0.0
- Total source: 3,227 lines across 6 files
- TypeScript: 0 errors
- CHARACTER_LIMIT increased from 25K to 30K
- Connector name mapping confirmed:
  - `mcp__2ae0488b` = Koodu
  - `mcp__3b1e8119` = Waves
  - `mcp__52757b90` = Tharun Personal

**Decision: Unified Notion skill**
- Instead of separate skills per workspace (waves-notion-manager, tharun-notion-manager, koodu-notion-manager), will build ONE unified Notion skill
- This skill triggers whenever someone mentions Notion, and serves as the master reference for all three workspaces
- Other skills can reference it. It becomes the "mother document" for Notion operations.
- Build deferred to after deploy + verification of v2 server

**What's next:**
- Tharun deploys v2: `npx wrangler deploy` from the project folder
- Test the new tools on claude.ai (create database rows, update properties, browse page tree)
- Build the unified Notion skill
- Phase 2: Personal workspace restructure

**Blockers:**
- Deploy requires Tharun to run `npx wrangler deploy` from their terminal

### Session 4 - April 10, 2026 (v2 Verification + v2.1.0 Formatting Fix)

**What happened:**
- v2 deployed by Tharun. Health check confirmed v2.0.0 live.
- Connectors refreshed: old connectors disconnected, new ones created with names:
  - `Notion-Workspace-Tharun` (mcp__52757b90)
  - `Notion-Workspace-Waves` (mcp__3b1e8119)
  - `Notion-Workspace-Koodu` (mcp__2ae0488b)
- All 9 tools now visible and functional from Cowork (previous session had caching issue showing only 6).

**Comprehensive v2 test results - 16/16 operations passed:**

| # | Operation | Tool | Result |
|---|---|---|---|
| 1 | Browse workspace tree (top-level) | get_children | Pass (all 3 workspaces) |
| 2 | Browse page children | get_children + page_id | Pass |
| 3 | List all databases | list_databases | Pass (40 total: 12+16+12) |
| 4 | Full schema with options | get_database_schema | Pass (all 3 workspaces) |
| 5 | Search pages by text | search_pages | Pass |
| 6 | Query with compound filter + sort | query_database | Pass |
| 7 | Read page as markdown | read_page | Pass |
| 8 | Create standalone page (under parent) | create_page + parent_id | Pass |
| 9 | Create DB row with 6 property types | create_page + database_id | Pass |
| 10 | Rename page | update_page + title | Pass |
| 11 | Update properties (status, select, multi_select, rich_text) | update_page + properties | Pass |
| 12 | Append content | update_page + append_content | Pass |
| 13 | Replace content | update_page + replace_content | Pass |
| 14 | Archive page | update_page + archived | Pass |
| 15 | Add property to DB schema | update_database + add_properties | Pass |
| 16 | Remove property from DB schema | update_database + remove_properties | Pass |

**Full showcase test page created** under Work page in Personal workspace, exercising every markdown block type: headings, paragraphs, bold, italic, code, strikethrough, links, bulleted lists (nested), numbered lists, to-do checkboxes, code blocks (TypeScript), quotes, callouts (emoji + admonition), tables, images, bookmarks, toggles, dividers.

**Issues discovered by Tharun reviewing the page in Notion:**
1. **Inline formatting not rendering** - `**bold**`, `*italic*`, `` `code` ``, `~~strikethrough~~` all displayed as raw markdown text instead of formatted. Root cause: the `richText()` function created plain text objects without parsing markdown inline syntax into Notion annotations.
2. **Tables are table blocks, not databases** - Markdown table syntax creates Notion table blocks (simple grids). This is expected behavior. Actual databases are created via `create_page` with `database_id` and managed via `update_database`.
3. **Cannot create root-level pages** - Notion API limitation for internal integrations. Must provide a parent_id.
4. **`update_database` format mismatch** - Tool description says `{"type": "checkbox"}` but Notion API expects `{"checkbox": {}}`.

**v2.1.0 built to fix issues 1 and 4:**

*Fix 1 - Inline formatting parser:*
- New `richText()` function parses markdown inline syntax into Notion rich_text with annotations
- Handles: `**bold**`, `*italic*`, `` `code` ``, `~~strikethrough~~`, `[links](url)`, `***bold+italic***`
- Original literal function renamed to `plainRichText()` - used only for code blocks
- ALL block constructors updated: paragraph, heading, bullet, numbered, todo, quote, callout, toggle, table cells
- Regex-based tokenizer with priority ordering (code > link > bold+italic > bold > italic > strikethrough)

*Fix 2 - Property format normalizer:*
- Added `normalizePropertyConfig()` in tools.ts
- Accepts both `{"type": "checkbox"}` (simplified) and `{"checkbox": {}}` (native Notion) formats
- Auto-converts simplified to native when the type key is missing
- Applied to `add_properties` in `update_database`

**TypeScript: 0 errors. Version bumped to 2.1.0. Awaiting deploy.**

**Questions answered for Tharun:**
1. **Root-level pages** - Notion API restriction on internal integrations (no user ownership for private pages). Workaround: always use parent_id. Could designate an "Inbox" page as default parent.
2. **Font settings** - Not exposed by Notion API at all. Only changeable in Notion UI.
3. **Database views** - Not yet in our server, but Notion API does support view creation/modification now. The official Notion MCP connector has `notion-create-view` and `notion-update-view` tools. Can be added in a future server version.
4. **Database capabilities** - Already comprehensive: create rows with all property types, update any field, add/remove/rename columns, add select options, compound filter queries.

**What's next:**
- Tharun deploys v2.1.0: `npx wrangler deploy`
- Build unified Notion skill
- Phase 2: Personal workspace restructure

**Blockers:**
- Deploy requires Tharun's terminal

---

## Known Issues & Blockers

| Issue | Impact | Status |
|-------|--------|--------|
| No authentication on server | Anyone with URL can access Notion data | Accepted risk for now - URL is obscure |
| Custom domain (mcp.tha.run) not working | Cosmetic only - workers.dev URL functions fine | Deferred - requires DNS migration to Cloudflare |
| Cannot create root-level workspace pages | Must provide parent_id for all new pages | Notion API limitation for internal integrations - not fixable |
| Font settings not accessible via API | Cannot set default/serif/mono font | Notion platform limitation - not fixable |
| Database views not yet implemented | Cannot create calendar/kanban/timeline views | Notion API supports it - can be added in future server version |

---

## Files Related to This Project

| File | Location | Purpose |
|------|----------|---------|
| Architecture plan | `MCP/notion-mcp-server/ARCHITECTURE.md` (also `Tharun/notion-mcp-architecture-plan.md`) | Design decisions, specs, phases |
| Build log | `MCP/notion-mcp-server/notion-mcp-build-log.md` | This file - session progress, decisions |
| README | `MCP/notion-mcp-server/README.md` | GitHub repo readme with setup instructions |
| Original spec from Claude.ai | `uploads/personal-notion-mcp-spec.md` | Initial single-workspace spec that started this project |
| MCP server code | `MCP/notion-mcp-server/src/` | TypeScript source (index.ts, notion.ts, markdown.ts, tools.ts, types.ts, properties.ts) |
| Base Notion skill | `.claude/skills/notion-server/SKILL.md` | Tool patterns, property formats, workflow guide for all workspaces |
| Skill staging | `MCP/notion-server-skill/SKILL.md` | Copy of skill file (move to `.claude/skills/notion-server/`) |
| GitHub repo | `github.com/tharuneswarj/notion-mcp-server` | Source control (to be created) |
