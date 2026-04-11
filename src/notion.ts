/**
 * Notion API client for Cloudflare Workers.
 * API v2025-09-03+ with data_source paradigm.
 * Uses native fetch (no axios needed in Workers runtime).
 */

import type {
  NotionSearchResult,
  NotionPage,
  NotionBlock,
  NotionBlocksResponse,
  NotionDatabaseQueryResponse,
  NotionComment,
  NotionCommentsResponse,
  NotionFileUpload,
} from "./types.js";

const NOTION_BASE = "https://api.notion.com/v1";
const MAX_RETRIES = 3;

export class NotionClient {
  private token: string;
  private version: string;

  constructor(token: string, version: string = "2025-09-03") {
    this.token = token;
    this.version = version;
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.token}`,
      "Notion-Version": this.version,
      "Content-Type": "application/json",
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${NOTION_BASE}${path}`;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const opts: RequestInit = {
        method,
        headers: this.headers(),
      };
      if (body) {
        opts.body = JSON.stringify(body);
      }

      const res = await fetch(url, opts);

      // Handle rate limiting with retry
      if (res.status === 429 && attempt < MAX_RETRIES - 1) {
        const retryAfter = res.headers.get("Retry-After");
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : (attempt + 1) * 1000;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      if (!res.ok) {
        const errBody = await res.text();
        throw new NotionApiError(res.status, errBody, path);
      }

      return (await res.json()) as T;
    }

    // Should never reach here, but TypeScript needs it
    throw new NotionApiError(500, "Max retries exceeded", path);
  }

  /**
   * Raw request without JSON content-type (for file uploads).
   */
  private async requestRaw(
    method: string,
    path: string,
    body: FormData
  ): Promise<Record<string, unknown>> {
    const url = `${NOTION_BASE}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Notion-Version": this.version,
        // Do NOT set Content-Type - let fetch set multipart boundary
      },
      body,
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new NotionApiError(res.status, errBody, path);
    }

    return (await res.json()) as Record<string, unknown>;
  }

  // ─── Search ─────────────────────────────────────────────────────────────

  async search(
    query: string,
    pageSize: number = 5,
    filter?: { property: string; value: string },
    startCursor?: string
  ): Promise<NotionSearchResult> {
    const body: Record<string, unknown> = {
      query,
      page_size: pageSize,
      sort: { direction: "descending", timestamp: "last_edited_time" },
    };
    if (filter) {
      body.filter = filter;
    }
    if (startCursor) {
      body.start_cursor = startCursor;
    }
    return this.request<NotionSearchResult>("POST", "/search", body);
  }

  async searchAll(
    query: string,
    filter?: { property: string; value: string },
    maxResults: number = 100
  ): Promise<NotionSearchResult> {
    const allResults: NotionSearchResult["results"] = [];
    let cursor: string | undefined;
    const pageSize = Math.min(maxResults, 100);

    do {
      const data = await this.search(query, pageSize, filter, cursor);
      allResults.push(...data.results);
      cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined;
    } while (cursor && allResults.length < maxResults);

    return {
      results: allResults.slice(0, maxResults),
      has_more: allResults.length > maxResults || !!cursor,
      next_cursor: cursor ?? null,
    };
  }

  // ─── Pages ──────────────────────────────────────────────────────────────

  async getPage(pageId: string): Promise<NotionPage> {
    return this.request<NotionPage>("GET", `/pages/${pageId}`);
  }

  async createPage(
    parentId: string | null,
    title: string,
    isDatabase: boolean = false,
    options?: { icon?: unknown; cover?: unknown }
  ): Promise<NotionPage> {
    const parent = isDatabase
      ? { database_id: parentId }
      : parentId
        ? { page_id: parentId }
        : { type: "workspace", workspace: true };

    const properties = {
      title: { title: [{ text: { content: title } }] },
    };

    const body: Record<string, unknown> = { parent, properties };
    if (options?.icon) body.icon = options.icon;
    if (options?.cover) body.cover = options.cover;

    return this.request<NotionPage>("POST", "/pages", body);
  }

  async updatePage(
    pageId: string,
    updates: {
      title?: string;
      archived?: boolean;
      properties?: Record<string, unknown>;
      icon?: unknown;
      cover?: unknown;
    }
  ): Promise<NotionPage> {
    const body: Record<string, unknown> = {};

    if (updates.title !== undefined) {
      body.properties = {
        title: { title: [{ text: { content: updates.title } }] },
      };
    }
    if (updates.properties) {
      body.properties = { ...(body.properties as object), ...updates.properties };
    }
    if (updates.archived !== undefined) {
      body.archived = updates.archived;
    }
    if (updates.icon !== undefined) {
      body.icon = updates.icon;
    }
    if (updates.cover !== undefined) {
      body.cover = updates.cover;
    }

    return this.request<NotionPage>("PATCH", `/pages/${pageId}`, body);
  }

  // ─── Blocks (Page Content) ─────────────────────────────────────────────

  async getBlockChildren(
    blockId: string,
    startCursor?: string
  ): Promise<NotionBlocksResponse> {
    let path = `/blocks/${blockId}/children?page_size=100`;
    if (startCursor) {
      path += `&start_cursor=${startCursor}`;
    }
    return this.request<NotionBlocksResponse>("GET", path);
  }

  /**
   * Recursively fetches all block children for a page/block.
   * Handles pagination and nested children.
   */
  async getAllBlockChildren(
    blockId: string,
    maxDepth: number = 3,
    currentDepth: number = 0
  ): Promise<NotionBlock[]> {
    if (currentDepth >= maxDepth) return [];

    const allBlocks: NotionBlock[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.getBlockChildren(blockId, cursor);
      for (const block of response.results) {
        allBlocks.push(block);
        if (block.has_children) {
          const children = await this.getAllBlockChildren(
            block.id,
            maxDepth,
            currentDepth + 1
          );
          (block as NotionBlock & { _children: NotionBlock[] })._children = children;
        }
      }
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
    } while (cursor);

    return allBlocks;
  }

  async appendBlockChildren(
    blockId: string,
    children: unknown[]
  ): Promise<void> {
    // Notion API limits to 100 blocks per request
    for (let i = 0; i < children.length; i += 100) {
      const batch = children.slice(i, i + 100);
      await this.request("PATCH", `/blocks/${blockId}/children`, {
        children: batch,
      });
    }
  }

  // ─── Databases ──────────────────────────────────────────────────────────

  async queryDatabase(
    databaseId: string,
    filter?: unknown,
    sorts?: unknown[],
    pageSize: number = 10,
    startCursor?: string
  ): Promise<NotionDatabaseQueryResponse> {
    const body: Record<string, unknown> = { page_size: pageSize };
    if (filter) body.filter = filter;
    if (sorts) body.sorts = sorts;
    if (startCursor) body.start_cursor = startCursor;

    // Try data_source endpoint first (v2025-09-03+), fall back to database endpoint
    try {
      return await this.request<NotionDatabaseQueryResponse>(
        "POST",
        `/data_sources/${databaseId}/query`,
        body
      );
    } catch (err) {
      if (err instanceof NotionApiError && err.status === 404) {
        // Fall back to legacy endpoint for compatibility
        return this.request<NotionDatabaseQueryResponse>(
          "POST",
          `/databases/${databaseId}/query`,
          body
        );
      }
      throw err;
    }
  }

  async listDatabases(
    query: string = "",
    maxResults: number = 100
  ): Promise<NotionSearchResult> {
    return this.searchAll(query, {
      property: "object",
      value: "data_source",
    }, maxResults);
  }

  async getDatabase(
    databaseId: string
  ): Promise<Record<string, unknown>> {
    try {
      return await this.request<Record<string, unknown>>(
        "GET",
        `/databases/${databaseId}`
      );
    } catch {
      // On v2025-09-03+, the ID might be a data_source_id.
      // Fetch the data_source to get the real database_id from parent.
      const ds = await this.request<Record<string, unknown>>(
        "GET",
        `/data_sources/${databaseId}`
      );
      const parent = ds.parent as Record<string, string> | undefined;
      const realDbId = parent?.database_id;
      if (realDbId && realDbId.replace(/-/g, "") !== databaseId.replace(/-/g, "")) {
        // Re-fetch using the real database_id (has properties)
        return this.request<Record<string, unknown>>(
          "GET",
          `/databases/${realDbId}`
        );
      }
      return ds;
    }
  }

  /**
   * Resolve a database_id to its data_source_id.
   * On v2025-09-03+, databases contain data_source references.
   * For single-table databases, the data_source_id is in the response.
   */
  /**
   * Resolve the real database_id and data_source_id for the views API.
   * On v2025-09-03, list_databases returns data_source objects.
   * The user-facing ID is the data_source_id.
   * The real database_id is in parent.database_id.
   */
  async resolveViewIds(userFacingId: string): Promise<{ realDatabaseId: string; dataSourceId: string }> {
    const normalizedId = userFacingId.replace(/-/g, "");
    const searchResult = await this.searchAll("", {
      property: "object",
      value: "data_source",
    }, 200);

    for (const item of searchResult.results) {
      const itemId = (item.id || "").replace(/-/g, "");
      if (itemId === normalizedId) {
        const parent = item.parent as Record<string, string> | undefined;
        const parentDbId = parent?.database_id;
        if (parentDbId) {
          return {
            realDatabaseId: parentDbId.replace(/-/g, ""),
            dataSourceId: normalizedId,
          };
        }
      }
    }

    // Fallback: assume user passed database_id, use same for both
    return { realDatabaseId: normalizedId, dataSourceId: normalizedId };
  }

  async updateDatabase(
    databaseId: string,
    updates: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      "PATCH",
      `/databases/${databaseId}`,
      updates
    );
  }

  async createDatabase(
    parentPageId: string,
    title: string,
    properties: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("POST", "/databases", {
      parent: { type: "page_id", page_id: parentPageId },
      title: [{ type: "text", text: { content: title } }],
      properties,
    });
  }

  // ─── Page Operations ────────────────────────────────────────────────────

  async duplicatePage(pageId: string): Promise<NotionPage> {
    // Notion doesn't have a native duplicate endpoint.
    // We read the page + blocks, then recreate under the same parent.
    const page = await this.getPage(pageId);
    const parent = page.parent as Record<string, unknown>;

    // Get the title
    const props = page.properties as Record<string, Record<string, unknown>>;
    let title = "Untitled (copy)";
    for (const prop of Object.values(props)) {
      if (prop.type === "title") {
        const titleArr = prop.title as Array<{ plain_text: string }>;
        if (titleArr?.length > 0) {
          title = titleArr.map((t) => t.plain_text).join("") + " (copy)";
        }
        break;
      }
    }

    // Determine parent for the copy
    let parentBody: Record<string, unknown>;
    if (parent.type === "database_id" || parent.type === "data_source_id") {
      parentBody = { database_id: (parent.database_id || parent.data_source_id) as string };
    } else if (parent.type === "page_id") {
      parentBody = { page_id: parent.page_id as string };
    } else {
      throw new NotionApiError(400, "Cannot duplicate workspace-level pages", "/pages");
    }

    // For database rows, copy all writable properties
    const newProps: Record<string, unknown> = {};
    if (parent.type === "database_id" || parent.type === "data_source_id") {
      for (const [key, prop] of Object.entries(props)) {
        const pType = prop.type as string;
        // Skip read-only and auto-generated properties
        if (["formula", "rollup", "created_time", "created_by",
             "last_edited_time", "last_edited_by", "unique_id"].includes(pType)) {
          continue;
        }
        // Copy the raw property value
        if (prop[pType] !== undefined && prop[pType] !== null) {
          newProps[key] = { [pType]: prop[pType] };
        }
      }
      // Override title with "(copy)" suffix
      for (const [key, prop] of Object.entries(props)) {
        if ((prop.type as string) === "title") {
          newProps[key] = { title: [{ text: { content: title } }] };
          break;
        }
      }
    } else {
      newProps.title = { title: [{ text: { content: title } }] };
    }

    // Create the new page
    const newPage = await this.request<NotionPage>("POST", "/pages", {
      parent: parentBody,
      properties: newProps,
    });

    // Copy block children
    const blocks = await this.getAllBlockChildren(pageId, 2);
    if (blocks.length > 0) {
      const cleanBlocks = this.stripBlockIds(blocks);
      await this.appendBlockChildren(newPage.id, cleanBlocks);
    }

    return newPage;
  }

  async movePage(
    pageId: string,
    newParentId: string,
    parentType: "page_id" | "database_id" = "page_id"
  ): Promise<NotionPage> {
    return this.request<NotionPage>("PATCH", `/pages/${pageId}`, {
      parent: { [parentType]: newParentId },
    });
  }

  /**
   * Strip IDs from blocks so they can be re-created.
   * Recursively handles children.
   */
  private stripBlockIds(blocks: NotionBlock[]): unknown[] {
    return blocks.filter((block) => {
      const type = block.type;
      const data = block[type] as Record<string, unknown> | undefined;

      // Skip image/file/video/pdf blocks that use Notion-hosted "file" type
      // (they can't be re-created because the signed URLs expire and
      // v2025-09-03 requires file_upload instead)
      if (["image", "file", "video", "pdf", "audio"].includes(type)) {
        if (data?.type === "file") return false;
      }

      return true;
    }).map((block) => {
      const type = block.type;
      const data = block[type] as Record<string, unknown> | undefined;
      if (!data) return { type, [type]: {} };

      const clean: Record<string, unknown> = { type, [type]: { ...data } };

      // Handle nested children
      const children = (block as NotionBlock & { _children?: NotionBlock[] })._children;
      if (children && children.length > 0) {
        (clean[type] as Record<string, unknown>).children = this.stripBlockIds(children);
      }

      return clean;
    });
  }

  // ─── Users ──────────────────────────────────────────────────────────────

  async listUsers(): Promise<Array<{ id: string; name: string; type: string }>> {
    const data = await this.request<{
      results: Array<{
        id: string;
        name?: string;
        type: string;
        person?: { email?: string };
        bot?: { owner?: unknown };
      }>;
    }>("GET", "/users");

    return data.results
      .filter((u) => u.type === "person")
      .map((u) => ({
        id: u.id,
        name: u.name || "Unknown",
        type: u.type,
      }));
  }

  // ─── Views ───────────────────────────────────────────────────────────

  async createView(
    viewConfig: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      "POST",
      `/views`,
      viewConfig
    );
  }

  async updateView(
    viewId: string,
    updates: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      "PATCH",
      `/views/${viewId}`,
      updates
    );
  }

  async deleteView(viewId: string): Promise<void> {
    await this.request("DELETE", `/views/${viewId}`);
  }

  // ─── Comments ──────────────────────────────────────────────────────────

  async getComments(
    blockId: string,
    pageSize: number = 100,
    startCursor?: string
  ): Promise<NotionCommentsResponse> {
    let path = `/comments?block_id=${blockId}&page_size=${pageSize}`;
    if (startCursor) {
      path += `&start_cursor=${startCursor}`;
    }
    return this.request<NotionCommentsResponse>("GET", path);
  }

  async createComment(
    body: Record<string, unknown>
  ): Promise<NotionComment> {
    return this.request<NotionComment>("POST", "/comments", body);
  }

  // ─── File Upload ───────────────────────────────────────────────────────

  async createFileUpload(
    filename: string,
    contentType: string
  ): Promise<NotionFileUpload> {
    return this.request<NotionFileUpload>("POST", "/file_uploads", {
      filename,
      content_type: contentType,
    });
  }

  async sendFileContent(
    uploadId: string,
    fileData: ArrayBuffer,
    filename: string,
    contentType: string
  ): Promise<Record<string, unknown>> {
    const formData = new FormData();
    const blob = new Blob([fileData], { type: contentType });
    formData.append("file", blob, filename);

    return this.requestRaw("POST", `/file_uploads/${uploadId}/send`, formData);
  }

  // ─── Blocks (individual) ─────────────────────────────────────────────

  async deleteBlock(blockId: string): Promise<void> {
    await this.request("DELETE", `/blocks/${blockId}`);
  }
}

// ─── Error Class ──────────────────────────────────────────────────────────────

export class NotionApiError extends Error {
  status: number;
  path: string;

  constructor(status: number, body: string, path: string) {
    const message = NotionApiError.friendlyMessage(status, body, path);
    super(message);
    this.name = "NotionApiError";
    this.status = status;
    this.path = path;
  }

  static friendlyMessage(status: number, body: string, path: string): string {
    // Try to parse the Notion error message
    let detail = "";
    try {
      const parsed = JSON.parse(body);
      detail = parsed.message || "";
    } catch {
      detail = body.slice(0, 200);
    }

    switch (status) {
      case 400:
        return `Invalid request to ${path}. ${detail} Check the page/database ID format.`;
      case 401:
        return `Authentication failed. The Notion integration token may be invalid or expired.`;
      case 403:
        return `No access to this resource. Share the page/database with the integration in Notion (Settings → Connections → Add connection).`;
      case 404:
        return `Page or database not found. Check the ID and make sure it's shared with the integration.`;
      case 409:
        return `Conflict: the page was modified by another process. Try again.`;
      case 429:
        return `Rate limited by Notion. Wait a few seconds and try again.`;
      default:
        return `Notion API error ${status} on ${path}. ${detail}`;
    }
  }
}
