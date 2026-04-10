# Unified Notion MCP Server - Architecture & Rollout Plan

**Date:** April 10, 2026
**Last updated:** April 10, 2026 (v4 - server v2.1.0 built, v2.0.0 deployed + verified)
**Author:** Tharun + Claude
**Status:** Phase 1.5 COMPLETE (v2 deployed + verified), Phase 1.6 awaiting deploy (v2.1.0 inline formatting fix)
**Build log:** See `notion-mcp-build-log.md` for session-by-session progress

---

## 1. The Problem

Tharun works across three Notion workspaces, five Claude surfaces, and multiple brands. Right now:

- The **official Notion connector** only connects to the Waves Company workspace
- Personal projects and Koodu Architecture have **no Notion access from Claude**
- Information is fragmented - some things live in local files (accessible via Cowork/Claude Code), some in Notion (only Waves), some in Claude.ai project memory (not accessible from other surfaces)
- Claude.ai, Claude Desktop, Claude Code, Cowork, and mobile each see different slices of the picture
- The official connector has known limitations: struggles with page formatting/styling, sometimes creates database entries when you want simple pages, handles table views oddly, and loads heavy schemas into context
- Moving between surfaces means re-explaining context every time

**The fix:** Build a single custom MCP server that connects all three Notion workspaces to every Claude surface. Make Notion the single source of truth. Fix the formatting and tooling gaps the official connector has.

---

## 2. Architecture

### 2.1 One Worker, Service-Based Routing

A single Cloudflare Worker deployed at `mcp.tha.run` with a nested URL structure that organizes by service first, then workspace:

```
mcp.tha.run/notion/personal/mcp   → Personal Notion workspace
mcp.tha.run/notion/koodu/mcp      → Koodu Architecture workspace
mcp.tha.run/notion/waves/mcp      → Waves Company workspace
mcp.tha.run/gemini/mcp            → (future) Gemini image generation
mcp.tha.run/[service]/mcp         → (future) any new service
```

The `/notion/` prefix keeps Notion-specific endpoints grouped and leaves room for other MCP services under the same domain without any restructuring.

Each Notion endpoint is registered as a **separate custom connector** in Claude.ai:

| Connector Name            | MCP ID Prefix    | URL                                                                    | Notion Workspace       | Status |
|---------------------------|------------------|------------------------------------------------------------------------|------------------------|--------|
| Notion-Workspace-Tharun   | mcp__52757b90    | notion-mcp-server.tharun-mcp.workers.dev/notion/personal/mcp          | Tharun's personal      | LIVE   |
| Notion-Workspace-Waves    | mcp__3b1e8119    | notion-mcp-server.tharun-mcp.workers.dev/notion/waves/mcp             | Waves Company          | LIVE   |
| Notion-Workspace-Koodu    | mcp__2ae0488b    | notion-mcp-server.tharun-mcp.workers.dev/notion/koodu/mcp             | Koodu Architecture     | LIVE   |

*Note: Connectors were renamed from `*-notion-workspace` to `Notion-Workspace-*` in Session 4 to resolve a tool caching issue.*

**Why one worker, not three:**
- Single codebase to maintain
- One deployment command updates all workspaces
- Shared markdown conversion logic, error handling, auth
- Different Notion integration tokens per path (stored as separate secrets)

**Why three connectors, not one with a workspace parameter:**
- Claude routes to the right workspace by connector name - no ambiguity
- Skills can target a specific workspace explicitly
- If Claude sees "update the Waves Master Tracker," it uses `waves-workspace` tools
- If Claude sees "add to my personal task list," it uses `personal-workspace` tools
- Each connector loads 9 tool schemas (~4-5K tokens) - total ~12-15K for all three, still manageable

### 2.2 System Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                       Claude Surfaces                                │
│                                                                      │
│  claude.ai   Cowork   Claude Desktop   Claude Code   Mobile         │
│     │          │            │               │           │            │
│     └──────────┴────────────┴───────────────┴───────────┘            │
│                             │                                        │
│             ┌───────────────┼───────────────┐                        │
│             │               │               │                        │
│     personal-workspace  koodu-workspace  waves-workspace             │
│      (connector)         (connector)      (connector)                │
└─────────────┬───────────────┬───────────────┬────────────────────────┘
              │               │               │
              ▼               ▼               ▼
        ┌──────────────────────────────────────────┐
        │            mcp.tha.run                    │
        │         Cloudflare Worker                 │
        │                                           │
        │   /notion/personal/  /notion/koodu/       │
        │   /notion/waves/     /gemini/ (future)    │
        │         │                │          │     │
        │         ▼                ▼          ▼     │
        │   NOTION_TOKEN_    NOTION_TOKEN_  NOTION_ │
        │   PERSONAL         KOODU          TOKEN_  │
        │                                   WAVES   │
        └─────────┬──────────────┬──────────┬──────┘
                  │              │          │
                  ▼              ▼          ▼
           ┌───────────┐  ┌──────────┐ ┌──────────┐
           │  Personal  │  │  Koodu   │ │  Waves   │
           │  Notion    │  │  Notion  │ │  Notion  │
           │  Workspace │  │ Workspace│ │ Workspace│
           └───────────┘  └──────────┘ └──────────┘
```

### 2.3 What Happens to the Official Notion Connector

Once the custom `waves-workspace` connector is working and verified:

1. **Parallel run:** Both active simultaneously for 1 week
2. **Skill migration:** Update all Waves skills to use custom connector tool names
3. **Cutover:** Disconnect the official Notion connector

### 2.4 Advantages Over the Official Connector

| Issue with Official Connector | How Custom MCP Fixes It |
|-------------------------------|------------------------|
| Struggles with page formatting/styling | Direct Notion API block creation with proper heading, callout, toggle, code block support |
| Creates database entries when you want simple pages | Explicit `create_page` vs `query_database` tools - no confusion |
| Odd table view handling | Clean markdown tables on read, proper table block creation on write |
| Heavy context window usage | 9 focused tools per workspace with lean response format |
| No control over response format | Markdown conversion strips unnecessary metadata |
| Single workspace only | Three workspaces, one server |

### 2.5 Free Tier - No Conflicts

Each workspace gets its own Notion internal integration. The API is free regardless of workspace plan. Three separate integrations means three independent rate limits (3 req/sec each = 9 req/sec total). No cross-workspace interference. Cloudflare Workers free tier gives 100K requests/day - more than enough.

### 2.6 Scalability - Multi-User (Future)

The MCP server is Tharun's personal gateway. For a scenario where someone else (e.g., Arjun) needs access:

**Option A - Shared access (small trusted team):**
Share the bearer token. Arjun registers the same connectors. He sees everything the integration can see in shared workspaces (Koodu). Simple but no per-user isolation.

**Option B - Fork and deploy (proper separation):**
Arjun forks the same codebase, deploys his own Cloudflare Worker (free), uses his own Notion integration tokens. For shared workspaces (Koodu), both integrations have access. For private workspaces, each person only sees their own.

The codebase is designed to be forkable: same code, different secrets, different deployment.

---

## 3. Tool Design (9 Tools Per Workspace)

Each workspace endpoint exposes the same 9 tools. Claude disambiguates by which connector it calls.

**READ tools (6):**

| Tool | Purpose | Notion API |
|------|---------|------------|
| `search_pages` | Full-text search across the workspace (max 20, paginated) | POST /v1/search |
| `read_page` | Read a page's full content as markdown with flat properties | GET /v1/pages/{id} + GET /v1/blocks/{id}/children (recursive) |
| `get_children` | Browse the workspace page tree - list child pages/databases under any page | GET /v1/blocks/{id}/children |
| `query_database` | Query a database with compound filters and sorts (max 50, paginated) | POST /v1/databases/{id}/query |
| `list_databases` | List all databases in workspace with property names/types (auto-paginated) | POST /v1/search (filtered) |
| `get_database_schema` | Full schema of one database with all option values, relation targets, types | GET /v1/databases/{id} |

**WRITE tools (3):**

| Tool | Purpose | Notion API |
|------|---------|------------|
| `create_page` | Create a standalone page (with parent_id) or a database row (with database_id + flat properties). Auto-formats properties server-side. | POST /v1/pages + PATCH /v1/blocks/{id}/children |
| `update_page` | Update properties, title, append/replace content, or archive. Flat key-value properties auto-formatted. | PATCH /v1/pages/{id} + PATCH/DELETE /v1/blocks/{id}/children |
| `update_database` | Modify database structure: add/rename/remove columns, update select/status options | PATCH /v1/databases/{id} |

**Key server-side features:**
- Property format builder converts flat key-values (`{"Status": "Done", "Priority": "P1"}`) to Notion's nested API format
- Name-to-ID resolution for relation fields (searches related database by title match)
- Name-to-ID resolution for people fields (queries workspace users, cached 5 min)
- Schema validation with helpful error messages for invalid options
- Read-only field rejection (formula, rollup, created_time, etc.)
- Inline markdown formatting parsed into Notion annotations (bold, italic, code, strikethrough, links) (v2.1.0)

### 3.1 Markdown Conversion (Critical)

The server converts Notion blocks to clean markdown on read, and parses markdown into Notion blocks on write.

**Supported block types (read + write):** headings (h1-h3), paragraphs, bulleted lists (nested), numbered lists, to-do items (with checkbox state), code blocks (with language), quotes, dividers, toggle blocks (with children), callouts (emoji + admonition syntax), tables, images (external), bookmarks, links, embeds, equations.

**Rich text handling (bidirectional):**
- **Read (Notion → Markdown):** Preserves bold/italic/code/strikethrough as markdown syntax. Links become `[text](url)`. Strips Notion's nested JSON - gives Claude clean content at 5-10x smaller than raw Notion JSON.
- **Write (Markdown → Notion, v2.1.0):** Parses `**bold**`, `*italic*`, `` `code` ``, `~~strikethrough~~`, `[links](url)`, `***bold+italic***` into Notion rich_text annotations. Code block content stays literal. Applied to all block types including table cells.

### 3.2 Response Size Controls

- `search_pages`: max 20 results, paginated via start_cursor
- `read_page`: full content as markdown (typically 5-10x smaller than raw JSON)
- `query_database`: max 50 rows, paginated via start_cursor, flat key-value properties
- `list_databases`: auto-paginated (finds all databases), property names + types
- `get_database_schema`: full schema with all option values for one database
- Character limit: 30K per response (truncated with message if exceeded)

### 3.3 What the Notion API Cannot Do

These are Notion platform limitations, not connector limitations:

- **Cannot create root-level workspace pages** via internal integrations (must provide parent_id)
- **Cannot set page fonts** (default/serif/mono) - UI-only setting
- Cannot set page cover images or icons reliably
- Cannot manage workspace-level settings
- No webhook support for real-time notifications

### 3.4 What the API CAN Do But We Haven't Implemented Yet

- **Database views** (calendar, kanban, timeline, table, gallery, list) - Notion API now supports create/update views. Can be added in a future server version.
- **Comments** - Notion API supports reading/creating comments on pages
- **Page icons and covers** - partially supported, reliability varies

---

## 4. Custom Domain Setup: mcp.tha.run

**Current state:** `tha.run` domain is on Namecheap, DNS managed by Vercel.

### 4.1 Setup Steps (CNAME in Vercel DNS)

1. Deploy the Worker to Cloudflare first (gets a `*.workers.dev` URL)
2. In Vercel Dashboard → tha.run domain → DNS Settings → Add CNAME record:
   - **Name:** `mcp`
   - **Value:** `notion-mcp.<your-subdomain>.workers.dev`
3. In Cloudflare Worker settings → Custom Domains → Add `mcp.tha.run`
4. Cloudflare verifies via the CNAME, issues an edge SSL certificate automatically

No DNS migration needed. Vercel continues handling tha.run and www.tha.run. Everything else stays the same.

---

## 5. Authentication & Security

### 5.1 Current State - No Auth (MVP)

Auth is currently **disabled**. The bearer token was implemented but removed because Claude.ai custom connectors only support OAuth, not custom Authorization headers. The server accepts all incoming requests.

**Security posture:** The URL (`notion-mcp-server.tharun-mcp.workers.dev`) is not public or indexed. Risk is low but real - anyone with the URL can access all 3 Notion workspaces.

**Acceptable for now** because it's a single-user server and the URL is obscure. Must be addressed before sharing access with others.

### 5.2 Phase 2 - Cloudflare Access (Future)

Add Cloudflare Access with email allowlist for proper OAuth. Worth doing when sharing access with others or when Claude.ai supports OAuth-based custom connectors.

---

## 6. Workspace Structures

### 6.1 Waves Company (Existing - Template)

Already well-structured. This is the pattern to replicate:

```
Waves HQ
├── Master Tracker (hub dashboard - current state)
├── Task Tracker DB (all tasks)
├── Roadmap (direction, not granular tasks)
├── R&D Log DB (experiments)
├── Content Tracker + Content Schedule DB
├── Website Tracker
├── Brand Wiki (About, Tone & Voice, Essence, Customer Profile)
├── Final Product Library
├── Skills Registry DB (new - see Section 8)
└── Changelog (at bottom of Master Tracker)
```

### 6.2 Tharun Personal (Needs Restructure)

Hub page modeled on Waves' Master Tracker:

```
Tharun HQ
├── Current Focus (3-5 active items max)
├── Active Projects Table
│   ├── @tharuneswar content series
│   ├── MCP infrastructure
│   ├── Slate work items
│   └── Learning / exploration
├── Personal Task Tracker DB
│   Fields: Task, Project, Priority (P0-P3), Status, Due Date, Notes
├── @tharuneswar Brand
│   ├── Brand Wiki (voice, visuals, identity)
│   ├── Content Plan + Content Schedule DB
│   └── Series pages (Series-A, Series-B, etc.)
├── MCP Infrastructure
│   ├── Notion MCP (this project)
│   ├── Gemini Image MCP
│   └── Future MCPs
├── Ideas Inbox DB (quick capture)
├── Learning Log DB (courses, experiments, key takeaways)
├── Skills Registry DB (see Section 8)
├── Weekly Review (rolling)
├── Archive (completed/paused projects)
└── Changelog
```

### 6.3 Koodu Architecture (Needs Design)

Requires input from Tharun (and potentially Arjun). Starting template:

```
Koodu HQ
├── Studio Status (active projects, team, capacity)
├── Active Projects DB (project name, client, status, timeline, assigned to)
├── Task Tracker DB (task, project, assigned to, priority, status, due date)
├── Client Directory DB (contact info, project history)
├── Studio Notes (reference material, templates, standards)
├── Skills Registry DB (see Section 8)
└── Changelog
```

### 6.4 Workspace Restructuring Approach

Restructuring is a dedicated effort, not a side task. The approach:

1. **Waves stays as-is** - it's the reference implementation
2. **Personal workspace first** - Tharun already has one, needs reorganization
3. **Koodu second** - needs design input, potentially from the partner
4. **Pattern:** For each workspace, create the hub page and core databases, then migrate existing content into the new structure incrementally. Don't try to move everything at once.

---

## 7. Skills Strategy

### 7.1 Skills Registry Database

Each workspace gets a "Skills Registry" database in Notion with these fields:

| Field | Type | Purpose |
|-------|------|---------|
| Skill Name | Title | e.g., waves-orientation |
| Workspace | Select | Personal / Koodu / Waves |
| Status | Status | Active / Draft / Deprecated / Planned |
| Connector Used | Select | personal-workspace / koodu-workspace / waves-workspace |
| Notion Pages Referenced | Relation / Text | Page IDs this skill reads/writes |
| Description | Rich text | What it does, one paragraph |
| Last Updated | Date | When the skill doc was last modified |

This prevents skill sprawl, gives Claude a reference to know what's available, and makes it easy to audit what's active vs outdated.

### 7.2 Current Waves Skills (to migrate)

| Skill | Notion Operations | Migration Effort |
|-------|-------------------|-----------------|
| `waves-orientation` | Reads Master Tracker, Website Tracker, Content Tracker, Brand Wiki | Low - change tool names, page IDs stay same |
| `waves-notion-manager` | Writes to Master Tracker, Task Tracker DB, Roadmap, R&D Log | Medium - most Notion-heavy skill |
| `waves-social-media-manager` | Reads/writes Content Tracker and Content Schedule DB | Low-medium |
| `waves-website-updater` | Reads/writes Website Tracker | Low |
| `waves-product-launcher` | Orchestrates across all above | Medium - depends on all others |

### 7.3 New Skills to Build

| Skill | Workspace | Priority | Purpose |
|-------|-----------|----------|---------|
| `tharun-orientation` | personal | Phase 2 | Read Tharun HQ at conversation start |
| `tharun-notion-manager` | personal | Phase 2 | Update personal tasks, content schedule, projects |
| `koodu-orientation` | koodu | Phase 4 | Read Koodu HQ at conversation start |
| `koodu-notion-manager` | koodu | Phase 4 | Update Koodu projects and tasks |
| `morning-briefing` | all three | Phase 6 | Daily task aggregation across all workspaces |

### 7.4 Skill Migration Steps

1. Deploy the custom MCP server with all three workspace endpoints
2. Register all three connectors alongside the official one
3. For each Waves skill:
   a. Read the current SKILL.md
   b. Identify all Notion tool calls (fetch, search, update, create)
   c. Map to equivalent custom MCP tool names (read_page, search_pages, update_page, create_page, query_database, list_databases)
   d. Update the SKILL.md with new tool references
   e. Test the skill through the custom connector
4. Run parallel with official connector for 1 week
5. Disconnect official connector
6. Register skills in the Skills Registry database

---

## 8. Cross-Workspace Task Aggregation (Phase 6)

### 8.1 Morning Briefing - Scheduled Task

A Cowork scheduled task that runs daily (e.g., 7:00 AM) and does the following:

1. Query the **Personal Task Tracker** for tasks with Status != Done
2. Query the **Waves Task Tracker DB** for tasks assigned to Tharun
3. Query the **Koodu Task Tracker DB** for tasks assigned to Tharun
4. Compile into a unified "Today's Plate" summary:
   - Tasks due today or overdue (across all workspaces)
   - High-priority items (P0/P1)
   - What's in progress
5. Present as a morning update in Cowork

This is read-only aggregation - no data duplication, no sync complexity. Each workspace remains the source of truth for its own tasks.

### 8.2 Why Not Sync to One Database

Bidirectional sync between databases creates fragility: if you mark something done in one place, it needs to propagate to the other. Conflict resolution becomes a problem. The morning briefing achieves the same goal (unified visibility) without the maintenance burden. Can always revisit if the need changes.

---

## 9. Build Approach

### 9.1 Where It Gets Built

**Cowork builds the code.** Cowork has Node.js, npm, TypeScript, and full file system access - everything needed to scaffold, write, and test the MCP server locally.

**Manual step for deployment.** `wrangler login` requires browser authentication, so Tharun runs this manually. After that, `wrangler deploy` can be run from the terminal or handed to Claude Code.

**Flow:** Cowork writes code → Tharun runs `wrangler login` + `wrangler deploy` → verify on MCP Inspector → register connectors in Claude.ai.

### 9.2 Continuity Between Sessions

Two files ensure any new Claude session can pick up where the last left off:

1. **`notion-mcp-architecture-plan.md`** (this file) - the *what* and *why*
2. **`notion-mcp-build-log.md`** - the *where we are* and *what happened*

A new session reads both files and has full context. No need for a dedicated skill - that would be overkill for a build project.

---

## 10. Revised Phases

### Phase 1: Foundation + Personal Workspace Connection
**Goal:** Working MCP server deployed at mcp.tha.run with the personal workspace connected and verified on all surfaces.

**Prerequisites (Tharun - already done):**
- [x] Personal Notion integration created, token ready
- [x] Integration shared with relevant pages
- [x] Cloudflare account exists

**Build steps:**
1. Scaffold the Cloudflare Worker project (TypeScript)
2. Implement 6 tools with Notion API integration
3. Build the markdown ↔ Notion blocks converter
4. Add service-based routing (/notion/personal/, /notion/koodu/, /notion/waves/)
5. Add bearer token authentication
6. Store `NOTION_TOKEN_PERSONAL` and `MCP_ACCESS_TOKEN` as secrets
7. Deploy to Cloudflare Workers
8. Set up `mcp.tha.run` CNAME in Vercel DNS + custom domain in Cloudflare
9. Test with MCP Inspector
10. Register `personal-workspace` connector in Claude.ai
11. Verify on all 5 surfaces (claude.ai, Desktop, Code, Cowork, mobile)

### Phase 2: Personal Workspace Restructure + Skills
**Goal:** Personal Notion workspace properly structured, with orientation and manager skills.

1. Create Tharun HQ hub page with databases
2. Migrate existing content into new structure
3. Build `tharun-orientation` skill
4. Build `tharun-notion-manager` skill
5. Create Skills Registry database in personal workspace
6. Test end-to-end: "catch me up on my personal projects" → works

### Phase 3: Waves Skill Migration
**Goal:** Waves workspace running through custom MCP, official connector disconnected.

**Prerequisites - ALL DONE:**
- [x] Waves Notion integration created
- [x] Pages shared with integration
- [x] NOTION_TOKEN_WAVES stored as secret
- [x] waves-notion-workspace connector registered and working in Claude.ai

**Build steps:**
1. ~~Store `NOTION_TOKEN_WAVES` as secret, redeploy~~ DONE
2. ~~Register `waves-workspace` connector in Claude.ai~~ DONE
3. Test raw tool access (read Master Tracker, query Task Tracker DB)
4. Migrate each Waves skill:
   a. waves-orientation
   b. waves-notion-manager
   c. waves-social-media-manager
   d. waves-website-updater
   e. waves-product-launcher
5. Create Skills Registry database in Waves workspace
6. Parallel run for 1 week (both connectors active)
7. Disconnect official Notion connector
8. Verify no regressions

### Phase 4: Koodu Workspace Design + Skills
**Goal:** Koodu workspace structured and operational with skills.

**Prerequisites - CONNECTION DONE, DESIGN PENDING:**
- [x] Koodu Notion integration created
- [x] NOTION_TOKEN_KOODU stored as secret
- [x] koodu-notion-workspace connector registered and working in Claude.ai
- [ ] Design Koodu workspace structure (needs partner input)

**Build steps:**
1. ~~Store `NOTION_TOKEN_KOODU` as secret, redeploy~~ DONE
2. ~~Register `koodu-workspace` connector in Claude.ai~~ DONE
3. Build Koodu workspace structure in Notion
4. Build `koodu-orientation` skill
5. Build `koodu-notion-manager` skill
6. Create Skills Registry database in Koodu workspace

### Phase 5: Gemini Image MCP Cloud Migration
**Goal:** Gemini image generation accessible from Claude.ai and mobile.

This is a separate project with different constraints:
- Image generation takes longer (needs higher Worker CPU limits)
- Responses include image data (larger payloads)
- May need Cloudflare Workers Paid ($5/mo) or alternative host (Railway, Fly.io)
- URL: `mcp.tha.run/gemini/mcp`

Detailed planning happens when Phase 1-4 are stable.

### Phase 6: Morning Briefing + Cross-Workspace Aggregation
**Goal:** Automated daily task overview across all three workspaces.

1. Build a Cowork scheduled task
2. Query all three task databases each morning
3. Compile unified "Today's Plate" summary
4. Present in Cowork as morning update
5. Option to send via email or other channel

---

## 11. Cost Summary

| Item | Cost | Notes |
|------|------|-------|
| Cloudflare Workers (free tier) | $0 | 100K requests/day, 10ms CPU/request |
| Cloudflare Workers (paid, if needed for Gemini) | $5/mo | 50ms CPU/request, no daily limit |
| Notion API | $0 | Internal integrations are free, no usage cap |
| Notion workspaces (3x free tier) | $0 | Free plan works for API access |
| Custom domain (mcp.tha.run) | $0 | Already own tha.run, CNAME is free |
| **Total (Phases 1-4, 6)** | **$0** | |
| **Total (with Phase 5 Gemini)** | **$5/mo** | |

---

## 12. Risk & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Notion API rate limits (3 req/sec per integration) | Slow responses during heavy use | 3 separate integrations = 9 req/sec total. Morning briefing uses pagination, not burst. |
| Cloudflare Worker 10ms CPU limit (free tier) | Timeout on large page reads | Markdown conversion is fast. Upgrade to paid ($5/mo) if needed. |
| Official connector removal breaks skills | Skills stop working | Parallel run for 1 week. Update skills first, then remove. |
| Integration token revoked | Access lost for that workspace | Regenerate and update Cloudflare secret. 2-minute fix. |
| Claude routes to wrong workspace | Wrong data read/written | Explicit connector names. Skills reference them by name. |
| Skill sprawl as workspaces grow | Context bloat, confusion | Skills Registry database per workspace. Regular audit. |

---

## 13. Open Questions

1. **Koodu workspace structure** - What does Koodu currently track in Notion? What databases exist? (Blocks Phase 4, not Phase 1-3)

2. ~~**Personal workspace current content**~~ - ANSWERED: 12 databases discovered via list_databases (Tasks, Meetings, Hub/wiki, Projects, Goals, Docs, Materials Required, Costs, Saved Links, Inspirations Board, Links - Computational Design, Master Course List). 4 top-level pages (Calendar, Links, Learning, Work).

3. ~~**Waves integration creation**~~ - DONE: All 3 integrations created, tokens stored, connectors live.

4. **Gemini priority** - Is cloud Gemini access a "when I get to it" or "I need this soon"? (Determines Phase 5 timing)

5. **Morning briefing timing** - What time works best? What format do you want? (Phase 6 detail)

6. **Database views** - Do you need Claude to create calendar/kanban/timeline views? Notion API supports it now. Would add ~2 tools to the server.

---

## 14. Complete Checklist

### Phase 1 - Foundation + All 3 Workspace Connections ✓ COMPLETE
- [x] Cloudflare account set up
- [x] Personal Notion integration created, token stored
- [x] Waves Notion integration created, token stored
- [x] Koodu Notion integration created, token stored
- [x] Worker project scaffolded (TypeScript)
- [x] 9 tools implemented (6 read + 3 write) with property format builder
- [x] Inline markdown formatting parsed into Notion annotations (v2.1.0)
- [x] Service-based routing working (/notion/personal/, /notion/waves/, /notion/koodu/)
- [x] Bearer token auth implemented then removed (Claude.ai only supports OAuth)
- [x] All 3 NOTION_TOKEN secrets stored
- [x] Deployed to Cloudflare Workers (notion-mcp-server.tharun-mcp.workers.dev)
- [x] Connectors registered: Notion-Workspace-Tharun, Notion-Workspace-Waves, Notion-Workspace-Koodu
- [x] All 3 workspaces queried successfully from Claude.ai
- [x] All 9 tools verified from Cowork (16/16 operations passed)
- [x] v2.1.0 built (inline formatting fix) - awaiting deploy
- [ ] mcp.tha.run custom domain - deferred (requires DNS on Cloudflare)
- [ ] Verified on Claude Desktop, Code, mobile

### Phase 2 - Personal Workspace Restructure
- [ ] Tharun HQ hub page created
- [ ] Personal Task Tracker DB created
- [ ] Content Schedule DB created
- [ ] Ideas Inbox DB created
- [ ] Learning Log DB created
- [ ] Existing content migrated
- [ ] tharun-orientation skill built and tested
- [ ] tharun-notion-manager skill built and tested
- [ ] Skills Registry DB created in personal workspace

### Phase 3 - Waves Skill Migration
- [x] Waves Notion integration created
- [x] NOTION_TOKEN_WAVES stored
- [x] waves-notion-workspace connector registered and working
- [ ] waves-orientation migrated and tested
- [ ] waves-notion-manager migrated and tested
- [ ] waves-social-media-manager migrated and tested
- [ ] waves-website-updater migrated and tested
- [ ] waves-product-launcher migrated and tested
- [ ] Skills Registry DB created in Waves workspace
- [ ] 1-week parallel run completed
- [ ] Official Notion connector disconnected
- [ ] No regressions confirmed

### Phase 4 - Koodu
- [ ] Koodu workspace structure designed
- [x] Koodu Notion integration created
- [x] NOTION_TOKEN_KOODU stored
- [x] koodu-notion-workspace connector registered and working
- [ ] Koodu HQ and databases created
- [ ] koodu-orientation skill built
- [ ] koodu-notion-manager skill built
- [ ] Skills Registry DB created in Koodu workspace

### Phase 5 - Gemini Cloud
- [ ] Execution profile assessed (CPU time, payload size)
- [ ] Hosting decision made
- [ ] Deployed at mcp.tha.run/gemini/mcp
- [ ] Works from Claude.ai and mobile
- [ ] Local Gemini MCP retired or kept as fallback

### Phase 6 - Morning Briefing
- [ ] Scheduled task created in Cowork
- [ ] Queries all three task databases
- [ ] Unified daily summary working
- [ ] Time and format confirmed with Tharun
