# Notion MCP Server - Roadmap

**Current Version:** 3.0.1
**Platform:** Cloudflare Workers
**Notion API:** v2025-09-03

---

## v3.1 - Polish & Reliability (Next)

### Search Enhancement
- Add property-value search (currently only searches titles and body content)
- Support filtering search by object type (page vs database vs data_source)

### Error Handling
- More descriptive error messages for common failures (wrong property name, invalid option value)
- Validation of icon/cover URLs before sending to Notion API
- Better handling of expired/rotated Notion tokens

### Performance
- Cache database schemas for 5 minutes to avoid redundant fetches during bulk operations
- Batch block append operations (currently one API call per markdown section)

---

## v4.0 - Major Feature Expansion

### Large File Upload (>20MB)
Currently capped at 20MB per upload. Notion's API supports larger files via multipart upload. Implement chunked upload for files up to 100MB - useful for high-res product photos and PDF documents.

### Link Previews
Notion supports link_preview blocks that render rich embeds (Figma, GitHub, Google Docs, etc.). Currently not supported by the server's markdown parser. Add detection for known preview-compatible URLs and create link_preview blocks instead of bookmark blocks.

### Multi-Data-Source Views
The v2025-09-03 data_source paradigm opens the door for views that pull from multiple data sources. Investigate what's possible with the Views API for cross-database views.

### Linked Databases
Create linked database views inside pages that reference databases from elsewhere in the workspace. This is a common Notion pattern (embedding a filtered view of a master database inside a project page) that the server doesn't support yet.

### Cross-Workspace Relations
Currently, relations only work within a single workspace. Explore whether the Notion API supports cross-workspace relations or if this requires a custom abstraction layer.

### View Management Expansion
- Update existing view filters, sorts, and visible properties
- Delete views
- Reorder views (tab order)
- Set default view for a database

---

## v5.0 - Intelligence Layer

### Smart Property Mapping
When Claude sends properties that don't exactly match the schema (e.g., "status" instead of "Status", or "high" instead of "High"), fuzzy-match to the closest valid option instead of returning an error.

### Template System
Pre-defined page templates that can be invoked by name. For example: "create a meeting notes page" uses a template with standard headings (Attendees, Agenda, Action Items). Templates stored as JSON configs in the Worker's KV storage.

### Batch Operations
Single tool call that applies the same update to multiple pages matching a query. For example: "mark all tasks with Due Date before today as Overdue." Currently requires one update_page call per row.

### Webhook Integration
Listen for Notion webhook events (page created, page updated, database modified) and forward them to Claude or other services. Enables reactive workflows - for example, auto-assigning tags when a new page is created.

---

## Infrastructure Roadmap

### Custom Domain
- Set up `mcp.tha.run` pointing to the Worker via Cloudflare DNS
- Potentially host other MCP servers under subpaths (e.g., `mcp.tha.run/gemini/`)

### Authentication
- Add Cloudflare Access or custom token auth for production security
- Per-workspace access controls (restrict who can write to which workspace)

### Monitoring & Logging
- Cloudflare Workers Analytics for request volume and latency
- Error tracking with structured logging to Cloudflare Logpush
- Uptime monitoring with Cloudflare Health Checks

### Multi-Server Architecture
As more MCP servers are built (Gemini image, finance, knowledge), consider:
- Shared authentication layer across all MCP servers
- Common rate limiting and error handling patterns
- Unified deployment pipeline via GitHub Actions
- Service discovery so servers can call each other

---

## Hosting Strategy

| Service | Platform | Rationale |
|---|---|---|
| MCP servers (mcp.tha.run) | Cloudflare Workers | Stateless APIs, sub-10ms cold starts, generous free tier |
| finance.tha.run | Vercel | Next.js app with SSR/ISR |
| knowledge.tha.run | Vercel | Full-stack app |
| research.tha.run | Vercel | Full-stack app |
| labs.tha.run | Vercel | Experimental UIs |
| docs.tha.run | Vercel | Documentation site |

Both platforms use Cloudflare DNS. MCP servers stay on Workers for raw speed. Everything with a UI goes on Vercel for the best developer experience.
