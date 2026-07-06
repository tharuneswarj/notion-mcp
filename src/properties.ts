/**
 * Property Format Builder - converts flat key-value pairs to Notion's nested format.
 *
 * This is the bridge between human-readable properties and Notion's API format.
 * Claude sends: { "Status": "Done", "Due Date": "2026-04-15", "Priority": "P1" }
 * This module converts to Notion's deeply nested JSON for each property type.
 *
 * Also handles:
 * - Name-to-ID resolution for relation and people fields
 * - Read-only field rejection with helpful errors
 * - Schema validation when schema is available
 */

import type { NotionRichText } from "./types.js";
import { NotionClient } from "./notion.js";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface PropertySchema {
  type: string;
  [key: string]: unknown;
}

export interface DatabaseSchema {
  id: string;
  title: string;
  properties: Record<string, PropertySchema>;
}

interface UserInfo {
  id: string;
  name: string;
  type: string;
}

// Read-only property types that cannot be set via API
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
// MAIN BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert flat key-value properties to Notion API format.
 *
 * @param flatProps - Human-readable properties like { "Status": "Done", "Priority": "P1" }
 * @param schema - Database property schema (from get_database_schema or fetched internally)
 * @param client - NotionClient for resolving relations/people by name
 * @returns Notion-formatted properties object ready for API calls
 */
export async function buildNotionProperties(
  flatProps: Record<string, unknown>,
  schema: Record<string, PropertySchema>,
  client?: NotionClient
): Promise<{ properties: Record<string, unknown>; errors: string[] }> {
  const properties: Record<string, unknown> = {};
  const errors: string[] = [];

  for (const [key, value] of Object.entries(flatProps)) {
    // Find the property in schema (case-insensitive match)
    const schemaEntry = findProperty(schema, key);

    if (!schemaEntry) {
      errors.push(
        `Property "${key}" not found in database. Available properties: ${Object.keys(schema).join(", ")}`
      );
      continue;
    }

    const [propertyName, propSchema] = schemaEntry;
    const type = propSchema.type;

    // Check read-only
    if (READ_ONLY_TYPES.has(type)) {
      errors.push(
        `Property "${propertyName}" is a ${type} field and cannot be set directly.` +
          (type === "formula"
            ? " Update the source fields instead."
            : type === "rollup"
              ? " This is computed from related data."
              : " This is managed automatically by Notion.")
      );
      continue;
    }

    try {
      const formatted = await formatProperty(
        propertyName,
        type,
        value,
        propSchema,
        client
      );
      if (formatted !== undefined) {
        properties[propertyName] = formatted;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Property "${propertyName}": ${msg}`);
    }
  }

  return { properties, errors };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROPERTY FORMATTERS
// ═══════════════════════════════════════════════════════════════════════════════

async function formatProperty(
  _name: string,
  type: string,
  value: unknown,
  schema: PropertySchema,
  client?: NotionClient
): Promise<unknown> {
  // Handle null/undefined - clear the property
  if (value === null || value === undefined) {
    return formatNull(type);
  }

  switch (type) {
    case "title":
      return { title: toRichTextArray(String(value)) };

    case "rich_text":
      return { rich_text: toRichTextArray(String(value)) };

    case "number": {
      const num = Number(value);
      if (isNaN(num)) {
        throw new Error(
          `Expected a number, got "${value}". Just send the numeric value - currency/format is set at the database level.`
        );
      }
      return { number: num };
    }

    case "select": {
      const strVal = String(value);
      // Validate against known options if available
      const selectOptions = getSelectOptions(schema, "select");
      if (selectOptions.length > 0 && !selectOptions.includes(strVal)) {
        throw new Error(
          `"${strVal}" is not a valid option. Valid options: ${selectOptions.join(", ")}`
        );
      }
      return { select: { name: strVal } };
    }

    case "multi_select": {
      const items = toStringArray(value);
      const msOptions = getSelectOptions(schema, "multi_select");
      if (msOptions.length > 0) {
        const invalid = items.filter((i) => !msOptions.includes(i));
        if (invalid.length > 0) {
          throw new Error(
            `Invalid option(s): ${invalid.join(", ")}. Valid options: ${msOptions.join(", ")}`
          );
        }
      }
      return { multi_select: items.map((name) => ({ name })) };
    }

    case "status": {
      const statusVal = String(value);
      const statusOptions = getStatusOptions(schema);
      if (statusOptions.length > 0 && !statusOptions.includes(statusVal)) {
        throw new Error(
          `"${statusVal}" is not a valid status. Valid options: ${statusOptions.join(", ")}`
        );
      }
      return { status: { name: statusVal } };
    }

    case "date": {
      if (typeof value === "object" && value !== null && "start" in value) {
        // Already in { start, end? } format
        const dateObj = value as { start: string; end?: string };
        return {
          date: {
            start: dateObj.start,
            ...(dateObj.end ? { end: dateObj.end } : {}),
          },
        };
      }
      // Simple date string
      return { date: { start: String(value) } };
    }

    case "checkbox":
      return { checkbox: toBoolean(value) };

    case "url":
      return { url: value === "" ? null : String(value) };

    case "email":
      return { email: value === "" ? null : String(value) };

    case "phone_number":
      return { phone_number: value === "" ? null : String(value) };

    case "relation":
      return await formatRelation(value, schema, client);

    case "people":
      return await formatPeople(value, client);

    case "files":
      return formatFiles(value);

    default:
      throw new Error(
        `Property type "${type}" is not supported for writing.`
      );
  }
}

/**
 * Format null value to clear a property
 */
function formatNull(type: string): unknown {
  switch (type) {
    case "title":
      return { title: [{ text: { content: "" } }] };
    case "rich_text":
      return { rich_text: [] };
    case "number":
      return { number: null };
    case "select":
      return { select: null };
    case "multi_select":
      return { multi_select: [] };
    case "status":
      return { status: null };
    case "date":
      return { date: null };
    case "checkbox":
      return { checkbox: false };
    case "url":
      return { url: null };
    case "email":
      return { email: null };
    case "phone_number":
      return { phone_number: null };
    case "relation":
      return { relation: [] };
    case "people":
      return { people: [] };
    case "files":
      return { files: [] };
    default:
      return undefined;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RELATION RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format relation field - accepts UUIDs or names.
 * If names are provided, resolves them by searching the related database.
 */
async function formatRelation(
  value: unknown,
  schema: PropertySchema,
  client?: NotionClient
): Promise<unknown> {
  const items = toStringArray(value);
  if (items.length === 0) return { relation: [] };

  const relationIds: Array<{ id: string }> = [];

  for (const item of items) {
    // Check if it's already a UUID (32 hex chars, optionally with dashes)
    if (isUUID(item)) {
      relationIds.push({ id: item.replace(/-/g, "") });
    } else if (client) {
      // Resolve by name - search the related database
      const relatedDbId = getRelatedDatabaseId(schema);
      if (!relatedDbId) {
        throw new Error(
          `Cannot resolve "${item}" by name - related database ID not found in schema. Use the page UUID instead.`
        );
      }
      const resolved = await resolveByTitle(client, relatedDbId, item);
      if (!resolved) {
        throw new Error(
          `Could not find "${item}" in the related database. Check the spelling or use the page UUID directly.`
        );
      }
      relationIds.push({ id: resolved });
    } else {
      throw new Error(
        `"${item}" looks like a name, not a UUID. To resolve names to IDs, the server needs a database client. Use the page UUID instead.`
      );
    }
  }

  return { relation: relationIds };
}

/**
 * Format people field - accepts UUIDs or names.
 */
async function formatPeople(
  value: unknown,
  client?: NotionClient
): Promise<unknown> {
  const items = toStringArray(value);
  if (items.length === 0) return { people: [] };

  const peopleIds: Array<{ id: string }> = [];

  for (const item of items) {
    if (isUUID(item)) {
      peopleIds.push({ id: item.replace(/-/g, "") });
    } else if (client) {
      const resolved = await resolveUserByName(client, item);
      if (!resolved) {
        throw new Error(
          `Could not find user "${item}" in the workspace. Check the name spelling or use the user UUID.`
        );
      }
      peopleIds.push({ id: resolved });
    } else {
      throw new Error(
        `"${item}" looks like a name, not a UUID. Use the user UUID instead.`
      );
    }
  }

  return { people: peopleIds };
}

/**
 * Format files field - accepts external URLs.
 * Notion API cannot upload files, only link external URLs.
 */
function formatFiles(value: unknown): unknown {
  const items = toStringArray(value);
  if (items.length === 0) return { files: [] };

  return {
    files: items.map((url) => ({
      type: "external",
      name: extractFileName(url),
      external: { url },
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// NAME RESOLUTION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

// Cache for user lookups (workspace users rarely change).
// Keyed per workspace token — all workspaces share one Worker isolate, so a
// single global cache would bleed one workspace's user list into another.
const userCaches = new Map<string, { users: UserInfo[]; timestamp: number }>();
const USER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Resolve a page title to its ID by searching a database.
 */
async function resolveByTitle(
  client: NotionClient,
  databaseId: string,
  title: string
): Promise<string | null> {
  // Query the database filtering by title
  // Notion doesn't have a direct title filter, so we search and match
  const results = await client.queryDatabase(databaseId, undefined, undefined, 25);

  for (const page of results.results) {
    const pageTitle = extractPageTitle(page.properties);
    if (pageTitle.toLowerCase() === title.toLowerCase()) {
      return page.id.replace(/-/g, "");
    }
  }

  // If not found in first 25, try a broader search
  // Use the workspace search filtered to the title text
  const searchResults = await client.search(title, 10);
  for (const result of searchResults.results) {
    if (result.properties) {
      const resultTitle = extractPageTitle(
        result.properties as Record<string, Record<string, unknown>>
      );
      if (resultTitle.toLowerCase() === title.toLowerCase()) {
        return result.id.replace(/-/g, "");
      }
    }
  }

  return null;
}

/**
 * Resolve a user name to their Notion user ID.
 */
async function resolveUserByName(
  client: NotionClient,
  name: string
): Promise<string | null> {
  const users = await getWorkspaceUsers(client);
  const lower = name.toLowerCase();

  // Try exact match first
  const exact = users.find((u) => u.name.toLowerCase() === lower);
  if (exact) return exact.id;

  // Try partial match (first name)
  const partial = users.find((u) =>
    u.name.toLowerCase().startsWith(lower) ||
    lower.startsWith(u.name.toLowerCase().split(" ")[0])
  );
  if (partial) return partial.id;

  return null;
}

/**
 * Get all workspace users (cached).
 */
export async function getWorkspaceUsers(
  client: NotionClient
): Promise<UserInfo[]> {
  const now = Date.now();
  const cached = userCaches.get(client.cacheKey);
  if (cached && now - cached.timestamp < USER_CACHE_TTL) {
    return cached.users;
  }

  const users = await client.listUsers();
  userCaches.set(client.cacheKey, { users, timestamp: now });
  return users;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEMA HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Find a property in schema by name (case-insensitive).
 */
function findProperty(
  schema: Record<string, PropertySchema>,
  name: string
): [string, PropertySchema] | null {
  // Exact match first
  if (schema[name]) return [name, schema[name]];

  // Case-insensitive match
  const lower = name.toLowerCase();
  for (const [key, val] of Object.entries(schema)) {
    if (key.toLowerCase() === lower) return [key, val];
  }

  return null;
}

/**
 * Extract select/multi_select option names from schema.
 */
function getSelectOptions(schema: PropertySchema, type: string): string[] {
  const config = schema[type] as { options?: Array<{ name: string }> } | undefined;
  if (!config?.options) return [];
  return config.options.map((o) => o.name);
}

/**
 * Extract status option names from schema (status has groups).
 */
function getStatusOptions(schema: PropertySchema): string[] {
  const config = schema.status as {
    options?: Array<{ name: string }>;
    groups?: Array<{ option_ids: string[] }>;
  } | undefined;
  if (!config?.options) return [];
  return config.options.map((o) => o.name);
}

/**
 * Get the related database ID from a relation property schema.
 */
function getRelatedDatabaseId(schema: PropertySchema): string | null {
  const config = schema.relation as {
    database_id?: string;
    single_property?: string;
    dual_property?: object;
  } | undefined;
  return config?.database_id ?? null;
}

/**
 * Extract the title from page properties.
 */
function extractPageTitle(
  properties: Record<string, Record<string, unknown>>
): string {
  for (const prop of Object.values(properties)) {
    if (prop.type === "title") {
      const titleArr = prop.title as NotionRichText[] | undefined;
      if (titleArr) {
        return titleArr.map((r) => r.plain_text || "").join("");
      }
    }
  }
  return "";
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert a value to an array of strings.
 * Handles: string, string[], comma-separated string
 */
function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String).filter((s) => s.length > 0);
  }
  if (typeof value === "string") {
    // If it contains commas, split
    if (value.includes(",")) {
      return value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    return value.length > 0 ? [value] : [];
  }
  return [String(value)];
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.toLowerCase() === "true" || value === "1" || value === "yes";
  }
  return Boolean(value);
}

function isUUID(str: string): boolean {
  const clean = str.replace(/-/g, "");
  return /^[a-f0-9]{32}$/i.test(clean);
}

function extractFileName(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split("/");
    return parts[parts.length - 1] || "file";
  } catch {
    return "file";
  }
}

function toRichTextArray(
  text: string
): Array<{ type: string; text: { content: string } }> {
  // Split into chunks of 2000 chars (Notion's limit per rich_text element)
  const chunks: Array<{ type: string; text: { content: string } }> = [];
  for (let i = 0; i < text.length; i += 2000) {
    chunks.push({
      type: "text",
      text: { content: text.slice(i, i + 2000) },
    });
  }
  return chunks.length > 0
    ? chunks
    : [{ type: "text", text: { content: "" } }];
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE SCHEMA FETCHER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch full database schema including select/status option values.
 * Used by tools before writing, and by get_database_schema tool.
 */
export async function fetchDatabaseSchema(
  client: NotionClient,
  databaseId: string
): Promise<DatabaseSchema> {
  const db = await client.getDatabase(databaseId);

  const title = db.title
    ? (db.title as Array<{ plain_text: string }>)
        .map((t) => t.plain_text)
        .join("")
    : "Untitled Database";

  const dbId = db.id as string;

  // On v2025-09-03, properties moved from the database object to data_sources.
  // Check db.properties first (old format), then fall back to data_sources.
  let properties = db.properties as Record<string, PropertySchema> | undefined;

  if (!properties || typeof properties !== "object" || Object.keys(properties).length === 0) {
    // Try extracting properties from the first data_source
    const dataSources = db.data_sources as Array<Record<string, unknown>> | undefined;
    if (dataSources && dataSources.length > 0) {
      const ds = dataSources[0];
      // data_source might have properties directly embedded
      if (ds.properties && typeof ds.properties === "object" &&
          Object.keys(ds.properties as Record<string, unknown>).length > 0) {
        properties = ds.properties as Record<string, PropertySchema>;
      } else {
        // Fetch the data_source by ID to get its properties
        const dsId = (ds.id as string) || "";
        if (dsId) {
          try {
            const fullDs = await client.request<Record<string, unknown>>(
              "GET",
              `/data_sources/${dsId}`
            );
            if (fullDs.properties && typeof fullDs.properties === "object") {
              properties = fullDs.properties as Record<string, PropertySchema>;
            }
          } catch {
            // data_source fetch failed - continue to error
          }
        }
      }
    }
  }

  if (!properties || typeof properties !== "object" || Object.keys(properties).length === 0) {
    // Diagnostic: dump the data_sources structure to understand the API response
    const dataSources = db.data_sources as Array<Record<string, unknown>> | undefined;
    const dsInfo = dataSources?.map((ds, i) => {
      const dsKeys = Object.keys(ds).join(", ");
      const propsKeys = ds.properties ? Object.keys(ds.properties as Record<string, unknown>).join(", ") : "NONE";
      return `ds[${i}]: id=${ds.id}, keys=[${dsKeys}], propKeys=[${propsKeys}]`;
    }).join(" | ") ?? "NO_DATA_SOURCES";
    throw new Error(
      `Database ${databaseId} returned no property schema. ` +
      `Object type: ${db.object ?? "unknown"}. data_sources: ${dsInfo}`
    );
  }

  return {
    id: dbId.replace(/-/g, ""),
    title,
    properties,
  };
}
