# Notion MCP Server - How-To Guide

Your custom Notion MCP server connects all 3 of your Notion workspaces to Claude. This guide covers everything you can do with it and how to ask for it.

---

## Your Workspaces

| Workspace | What's In It | How to Reference It |
|---|---|---|
| **Tharun Personal** | Tasks, projects, learning, MCP infrastructure, content | "my tasks", "personal Notion", "update my project" |
| **Waves Company** | Studio operations, products, orders, R&D, content calendar | "Waves", "the studio", "log this order" |
| **Koodu Architecture** | Architecture projects, clients, tasks, drawings | "Koodu", "the architecture project" |

Claude automatically picks the right workspace based on context. If it's ambiguous, Claude will ask.

---

## What You Can Do

### 1. Find Things

**Search by keyword**
- "Find the page about MCP server in my Notion"
- "Search for lamp prototypes in Waves"
- "Look for the Koodu client brief"

**Browse the page tree**
- "Show me what's in my Notion workspace"
- "What pages are under the Projects section?"
- "List all the children of the Waves Hub page"

**List all databases**
- "What databases do I have in my personal workspace?"
- "Show me all Waves databases"
- "List Koodu databases"

**Read a specific page**
- "Read the meeting notes page"
- "Show me the content of that task"
- "What does the R&D log say about the mesh experiment?"

---

### 2. Query Databases

Pull specific rows from any database with filters and sorting.

**Simple queries**
- "Show me all my in-progress tasks"
- "What Waves orders are pending?"
- "List Koodu tasks due this week"

**Filtered queries**
- "Show me high-priority tasks that aren't done yet"
- "Find all Waves products in the Loom series"
- "Get all Koodu projects with status Active, sorted by deadline"

**Paginated results**
- Databases return up to 50 rows at a time
- "Show me the next page of results" gets the next batch

---

### 3. Create Pages & Database Rows

**Standalone pages**
- "Create a page called Meeting Notes under my Projects page"
- "Make a new page in Waves for the photoshoot brief"

**Database rows**
- "Add a new task: Fix the homepage banner, Priority High, Status In progress, due April 15"
- "Log a new Waves order for Client X, 3 lamps, ₹45,000"
- "Create a Koodu task for site visit, assign to Tharun"

**With icons and covers**
- "Create a page called Q2 Goals with a 🎯 icon"
- "Add a new project page with this cover image: [URL]"

**With content**
- "Create a meeting notes page with sections for Attendees, Agenda, and Action Items"
- "Make a new R&D log entry with the experiment details I just described"

---

### 4. Update Existing Pages

**Change properties**
- "Mark that task as Done"
- "Change the priority to Low"
- "Update the due date to next Friday"
- "Set the status to In progress"

**Edit titles**
- "Rename that page to Q2 Planning"

**Add content**
- "Add a section at the bottom about the follow-up items"
- "Append today's notes to that page"

**Replace content**
- "Replace all the content with this new version" (use with caution - deletes everything first)

**Change icons and covers**
- "Change the icon to 🚀"
- "Update the cover with this image URL"

**Archive pages**
- "Archive that old task"
- "Soft-delete the test page"

---

### 5. Manage Databases (Structure)

**Add columns**
- "Add a Priority column with options High, Medium, Low to the task database"
- "Add a Due Date column to the Waves orders database"
- "Add a Notes rich text column"

**Rename columns**
- "Rename the 'Assignee' column to 'Owner'"

**Remove columns**
- "Remove the old Status column" (destructive - deletes all data in that column)

**Create new databases**
- "Create a new database called Sprint Tasks under the Projects page with columns: Status (Todo/In progress/Done), Priority (High/Medium/Low), Due Date, and Assignee"

---

### 6. Duplicate & Move Pages

**Duplicate**
- "Make a copy of that template page"
- "Duplicate this task row"

Copies the title (with "(copy)" appended), all writable properties, and body content up to 2 levels deep. Read-only properties like formulas and rollups are skipped.

**Move**
- "Move that page under the Archive section"
- "Move this task into the Sprint 3 database"

---

### 7. Database Views

Views are the tabs at the top of a Notion database that control how rows are displayed.

**Create views**
- "Create a board view for the task database called Active Board"
- "Add a calendar view to the Waves orders database"
- "Make a gallery view filtered to show only published content"

**View types available:** table (spreadsheet), board (kanban), calendar, list, timeline (gantt), gallery (cards)

**With filters and sorts**
- "Create a table view showing only high-priority tasks, sorted by due date"
- "Make a board view that excludes Done items"

---

### 8. Comments

**Read comments**
- "Show me the comments on that page"
- "What comments are on the Waves product brief?"

**Add comments**
- "Add a comment: This needs review before publishing"
- "Comment on that task saying it's blocked by the API issue"

**Reply to threads**
- "Reply to that comment thread saying I've fixed it"

---

### 9. Upload Files

Attach files to any Notion page - images, PDFs, documents up to 20MB.

**From a URL**
- "Attach this product photo to the Waves product page: [URL]"
- "Upload this PDF to the project brief"

**From generated content**
- When Claude generates images or documents, it can upload them directly to your Notion pages

---

## Tips & Tricks

**Schema first:** When Claude needs to create or update database rows, it always checks the database schema first to get the exact property names and valid options. You don't need to remember exact column names - Claude looks them up.

**Natural language works:** You don't need to use exact Notion terminology. "Mark it as done," "change the status," "add a tag" - Claude figures out which property to update.

**Cross-workspace in one conversation:** You can work across all 3 workspaces in a single chat. "Show me my personal tasks and the Waves content schedule" triggers queries on both workspaces.

**Bulk updates:** You can ask Claude to update multiple rows at once. "Mark all overdue tasks as Blocked" - Claude will query, find matching rows, and update each one.

**Relation properties:** When setting a relation, use the page name, not the ID. "Set the Project relation to Q2 Launch" - the server resolves the name to the correct page ID.

**People properties:** Same for people. "Assign to Tharun" - the server resolves the display name to the user ID.

---

## Limitations to Know

- **No root-level pages** - every page needs a parent. Claude can't create a page floating at the workspace top level.
- **Notion-uploaded images can't be copied** - when duplicating a page, images uploaded through the Notion UI are skipped (only external URL images survive).
- **File upload cap: 20MB** - for larger files, upload directly through Notion.
- **Views: create only** - update and delete view support is limited on the current API.
- **Search is title + body only** - you can't search by property values (e.g., "find all tasks assigned to Tharun"). Use query_database with filters for that.
- **Some URLs block upload** - sites like Wikipedia block non-browser requests. If a URL fails, try a different source or upload manually.

---

## Server Info

| Detail | Value |
|---|---|
| **Version** | 3.0.1 |
| **Platform** | Cloudflare Workers |
| **Notion API** | v2025-09-03 |
| **Tools** | 15 per workspace (45 total) |
| **Endpoint** | notion-mcp-server.tharun-mcp.workers.dev |
