/**
 * Bidirectional conversion between Notion blocks and Markdown.
 *
 * Notion → Markdown: used by read_page to return lean, readable content.
 * Markdown → Notion blocks: used by create_page / update_page to write content.
 */

import type { NotionBlock, NotionRichText } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════════
// NOTION → MARKDOWN
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert an array of Notion blocks (with _children for nested blocks) to Markdown.
 */
export function blocksToMarkdown(blocks: NotionBlock[], indent: number = 0): string {
  const lines: string[] = [];
  const prefix = "  ".repeat(indent);

  for (const block of blocks) {
    const line = blockToMarkdown(block, prefix);
    if (line !== null) {
      lines.push(line);
    }

    // Recurse into children
    const children = (block as NotionBlock & { _children?: NotionBlock[] })._children;
    if (children && children.length > 0) {
      const childMd = blocksToMarkdown(children, indent + 1);
      if (childMd) lines.push(childMd);
    }
  }

  return lines.join("\n");
}

function blockToMarkdown(block: NotionBlock, prefix: string): string | null {
  const type = block.type;
  const data = block[type] as Record<string, unknown> | undefined;
  if (!data) return null;

  switch (type) {
    case "paragraph":
      return prefix + richTextToMarkdown(data.rich_text as NotionRichText[]);

    case "heading_1":
      return `${prefix}# ${richTextToMarkdown(data.rich_text as NotionRichText[])}`;

    case "heading_2":
      return `${prefix}## ${richTextToMarkdown(data.rich_text as NotionRichText[])}`;

    case "heading_3":
      return `${prefix}### ${richTextToMarkdown(data.rich_text as NotionRichText[])}`;

    case "bulleted_list_item":
      return `${prefix}- ${richTextToMarkdown(data.rich_text as NotionRichText[])}`;

    case "numbered_list_item":
      return `${prefix}1. ${richTextToMarkdown(data.rich_text as NotionRichText[])}`;

    case "to_do": {
      const checked = (data.checked as boolean) ? "x" : " ";
      return `${prefix}- [${checked}] ${richTextToMarkdown(data.rich_text as NotionRichText[])}`;
    }

    case "toggle":
      return `${prefix}<details><summary>${richTextToMarkdown(data.rich_text as NotionRichText[])}</summary>`;

    case "code": {
      const lang = (data.language as string) || "";
      const text = richTextToMarkdown(data.rich_text as NotionRichText[]);
      return `${prefix}\`\`\`${lang}\n${prefix}${text}\n${prefix}\`\`\``;
    }

    case "quote":
      return `${prefix}> ${richTextToMarkdown(data.rich_text as NotionRichText[])}`;

    case "callout": {
      const icon = data.icon as { type: string; emoji?: string } | undefined;
      const emoji = icon?.emoji || "💡";
      return `${prefix}> ${emoji} ${richTextToMarkdown(data.rich_text as NotionRichText[])}`;
    }

    case "divider":
      return `${prefix}---`;

    case "table": {
      return tableToMarkdown(block, prefix);
    }

    case "image": {
      const imageData = data as {
        type: string;
        file?: { url: string };
        external?: { url: string };
        caption?: NotionRichText[];
      };
      const url = imageData.type === "file" ? imageData.file?.url : imageData.external?.url;
      const caption = imageData.caption
        ? richTextToMarkdown(imageData.caption)
        : "image";
      return url ? `${prefix}![${caption}](${url})` : null;
    }

    case "bookmark": {
      const bmUrl = (data as { url?: string }).url;
      return bmUrl ? `${prefix}[${bmUrl}](${bmUrl})` : null;
    }

    case "link_preview": {
      const lpUrl = (data as { url?: string }).url;
      return lpUrl ? `${prefix}[${lpUrl}](${lpUrl})` : null;
    }

    case "embed": {
      const embedUrl = (data as { url?: string }).url;
      return embedUrl ? `${prefix}[Embed: ${embedUrl}](${embedUrl})` : null;
    }

    case "equation": {
      const expr = (data as { expression?: string }).expression;
      return expr ? `${prefix}$$${expr}$$` : null;
    }

    case "table_row":
      // Handled by table parent
      return null;

    case "child_page":
      return `${prefix}📄 [${(data as { title?: string }).title || "Untitled"}]`;

    case "child_database":
      return `${prefix}🗃️ [${(data as { title?: string }).title || "Untitled Database"}]`;

    default:
      // Unsupported block type - skip silently
      return null;
  }
}

function tableToMarkdown(block: NotionBlock, prefix: string): string {
  const children = (block as NotionBlock & { _children?: NotionBlock[] })._children;
  if (!children || children.length === 0) return `${prefix}(empty table)`;

  const rows: string[][] = [];
  for (const row of children) {
    const rowData = row["table_row"] as { cells?: NotionRichText[][] } | undefined;
    if (rowData?.cells) {
      rows.push(rowData.cells.map((cell) => richTextToMarkdown(cell)));
    }
  }

  if (rows.length === 0) return `${prefix}(empty table)`;

  const lines: string[] = [];
  // Header row
  lines.push(`${prefix}| ${rows[0].join(" | ")} |`);
  lines.push(`${prefix}| ${rows[0].map(() => "---").join(" | ")} |`);
  // Data rows
  for (let i = 1; i < rows.length; i++) {
    lines.push(`${prefix}| ${rows[i].join(" | ")} |`);
  }

  return lines.join("\n");
}

/**
 * Convert Notion rich_text array to a Markdown string.
 * Preserves bold, italic, code, and strikethrough formatting.
 */
export function richTextToMarkdown(richText: NotionRichText[] | undefined): string {
  if (!richText || richText.length === 0) return "";

  return richText
    .map((rt) => {
      let text = rt.plain_text || "";
      const ann = rt.annotations;

      if (ann) {
        if (ann.code) text = `\`${text}\``;
        if (ann.bold) text = `**${text}**`;
        if (ann.italic) text = `*${text}*`;
        if (ann.strikethrough) text = `~~${text}~~`;
      }

      // Wrap in link if present
      if (rt.href) {
        text = `[${text}](${rt.href})`;
      }

      return text;
    })
    .join("");
}

// ═══════════════════════════════════════════════════════════════════════════════
// MARKDOWN → NOTION BLOCKS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse Markdown into Notion block objects for the API.
 * Handles all common block types including tables, callouts, toggles, images, and bookmarks.
 */
export function markdownToBlocks(markdown: string): unknown[] {
  const lines = markdown.split("\n");
  const blocks: unknown[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Code block
    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim() || "plain text";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push(codeBlock(codeLines.join("\n"), lang));
      continue;
    }

    // Table (markdown table with | delimiters)
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      const tableRows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const row = lines[i].trim();
        // Skip separator rows (| --- | --- |)
        if (/^\|[\s-:|]+\|$/.test(row)) {
          i++;
          continue;
        }
        const cells = row
          .split("|")
          .slice(1, -1) // remove first and last empty strings
          .map((c) => c.trim());
        tableRows.push(cells);
        i++;
      }
      if (tableRows.length > 0) {
        blocks.push(table(tableRows));
      }
      continue;
    }

    // Headings
    if (line.startsWith("### ")) {
      blocks.push(heading(3, line.slice(4)));
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push(heading(2, line.slice(3)));
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      blocks.push(heading(1, line.slice(2)));
      i++;
      continue;
    }

    // Divider
    if (line.trim() === "---" || line.trim() === "***" || line.trim() === "___") {
      blocks.push({ type: "divider", divider: {} });
      i++;
      continue;
    }

    // To-do
    const todoMatch = line.match(/^- \[([ xX])\] (.+)/);
    if (todoMatch) {
      blocks.push(todo(todoMatch[2], todoMatch[1] !== " "));
      i++;
      continue;
    }

    // Callout (> 💡 text or > [!note] text or > [!info] text)
    const calloutMatch = line.match(
      /^>\s*([🔥💡⚠️📌📝✅❌🎯🚀💬📋🏗️])\s+(.+)/
    );
    const calloutTagMatch = line.match(
      /^>\s*\[!(note|info|warning|tip|important|caution)\]\s*(.*)/i
    );
    if (calloutMatch) {
      blocks.push(callout(calloutMatch[2], calloutMatch[1]));
      i++;
      continue;
    }
    if (calloutTagMatch) {
      const emojiMap: Record<string, string> = {
        note: "📝",
        info: "💡",
        warning: "⚠️",
        tip: "💡",
        important: "📌",
        caution: "⚠️",
      };
      const emoji =
        emojiMap[calloutTagMatch[1].toLowerCase()] || "💡";
      blocks.push(callout(calloutTagMatch[2] || calloutTagMatch[1], emoji));
      i++;
      continue;
    }

    // Toggle (<details><summary>Title</summary>)
    const toggleMatch = line.match(
      /^<details>\s*<summary>\s*(.+?)\s*<\/summary>/
    );
    if (toggleMatch) {
      const toggleTitle = toggleMatch[1];
      const toggleChildren: unknown[] = [];
      i++;
      // Collect children until </details>
      while (i < lines.length && !lines[i].trim().startsWith("</details>")) {
        if (lines[i].trim() !== "") {
          toggleChildren.push(paragraph(lines[i]));
        }
        i++;
      }
      if (i < lines.length) i++; // skip </details>
      blocks.push(toggle(toggleTitle, toggleChildren));
      continue;
    }

    // Image (![alt](url))
    const imageMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (imageMatch) {
      blocks.push(imageBlock(imageMatch[2], imageMatch[1]));
      i++;
      continue;
    }

    // Bookmark (bare URL on its own line)
    const bareUrlMatch = line.match(
      /^(https?:\/\/[^\s]+)$/
    );
    if (bareUrlMatch) {
      blocks.push(bookmark(bareUrlMatch[1]));
      i++;
      continue;
    }

    // Bulleted list
    if (line.startsWith("- ") || line.startsWith("* ")) {
      blocks.push(bulletedListItem(line.slice(2)));
      i++;
      continue;
    }

    // Numbered list
    const numberedMatch = line.match(/^\d+\.\s+(.+)/);
    if (numberedMatch) {
      blocks.push(numberedListItem(numberedMatch[1]));
      i++;
      continue;
    }

    // Quote (must come after callout check)
    if (line.startsWith("> ")) {
      blocks.push(quote(line.slice(2)));
      i++;
      continue;
    }

    // Default: paragraph
    blocks.push(paragraph(line));
    i++;
  }

  return blocks;
}

// ─── Block Constructors ─────────────────────────────────────────────────────

function plainRichText(text: string): Array<{ type: string; text: { content: string } }> {
  // Split into chunks of 2000 chars (Notion's limit per rich_text element)
  // No inline formatting - used for code blocks and other literal content
  const chunks: Array<{ type: string; text: { content: string } }> = [];
  for (let i = 0; i < text.length; i += 2000) {
    chunks.push({
      type: "text",
      text: { content: text.slice(i, i + 2000) },
    });
  }
  return chunks.length > 0 ? chunks : [{ type: "text", text: { content: "" } }];
}

// Type for rich text input with optional annotations and links
type RichTextInput = {
  type: string;
  text: { content: string; link?: { url: string } };
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
    strikethrough?: boolean;
  };
};

/**
 * Parse inline markdown formatting into Notion rich_text array.
 * Handles: **bold**, *italic*, `code`, ~~strikethrough~~, [links](url), ***bold+italic***
 */
function richText(markdown: string): RichTextInput[] {
  if (!markdown) return [{ type: "text", text: { content: "" } }];

  const segments: RichTextInput[] = [];

  // Regex to match inline formatting (order matters - most specific first):
  // 1. Code spans: `text`
  // 2. Links: [text](url)
  // 3. Bold+Italic: ***text***
  // 4. Bold: **text**
  // 5. Italic: *text* (single asterisk, non-greedy)
  // 6. Strikethrough: ~~text~~
  const pattern = /`([^`]+?)`|\[([^\]]+?)\]\(([^)]+?)\)|\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~/g;

  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(markdown)) !== null) {
    // Plain text before this match
    if (match.index > lastIndex) {
      addPlainSegments(segments, markdown.slice(lastIndex, match.index));
    }

    if (match[1] !== undefined) {
      // Code: `text`
      segments.push({ type: "text", text: { content: match[1] }, annotations: { code: true } });
    } else if (match[2] !== undefined) {
      // Link: [text](url)
      segments.push({ type: "text", text: { content: match[2], link: { url: match[3] } } });
    } else if (match[4] !== undefined) {
      // Bold+Italic: ***text***
      segments.push({ type: "text", text: { content: match[4] }, annotations: { bold: true, italic: true } });
    } else if (match[5] !== undefined) {
      // Bold: **text**
      segments.push({ type: "text", text: { content: match[5] }, annotations: { bold: true } });
    } else if (match[6] !== undefined) {
      // Italic: *text*
      segments.push({ type: "text", text: { content: match[6] }, annotations: { italic: true } });
    } else if (match[7] !== undefined) {
      // Strikethrough: ~~text~~
      segments.push({ type: "text", text: { content: match[7] }, annotations: { strikethrough: true } });
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining plain text
  if (lastIndex < markdown.length) {
    addPlainSegments(segments, markdown.slice(lastIndex));
  }

  return segments.length > 0 ? segments : [{ type: "text", text: { content: "" } }];
}

/** Add plain text segment(s), respecting Notion's 2000-char limit per element. */
function addPlainSegments(segments: RichTextInput[], text: string): void {
  if (!text) return;
  for (let j = 0; j < text.length; j += 2000) {
    segments.push({ type: "text", text: { content: text.slice(j, j + 2000) } });
  }
}

function paragraph(text: string): unknown {
  return { type: "paragraph", paragraph: { rich_text: richText(text) } };
}

function heading(level: 1 | 2 | 3, text: string): unknown {
  const key = `heading_${level}`;
  return { type: key, [key]: { rich_text: richText(text) } };
}

function bulletedListItem(text: string): unknown {
  return {
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: richText(text) },
  };
}

function numberedListItem(text: string): unknown {
  return {
    type: "numbered_list_item",
    numbered_list_item: { rich_text: richText(text) },
  };
}

function todo(text: string, checked: boolean): unknown {
  return {
    type: "to_do",
    to_do: { rich_text: richText(text), checked },
  };
}

function quote(text: string): unknown {
  return { type: "quote", quote: { rich_text: richText(text) } };
}

function codeBlock(text: string, language: string): unknown {
  return {
    type: "code",
    code: { rich_text: plainRichText(text), language },
  };
}

function callout(text: string, emoji: string = "💡"): unknown {
  return {
    type: "callout",
    callout: {
      rich_text: richText(text),
      icon: { type: "emoji", emoji },
    },
  };
}

function toggle(title: string, children: unknown[]): unknown {
  return {
    type: "toggle",
    toggle: {
      rich_text: richText(title),
      children: children.length > 0 ? children : undefined,
    },
  };
}

function table(rows: string[][]): unknown {
  if (rows.length === 0) return paragraph("(empty table)");

  const width = Math.max(...rows.map((r) => r.length));

  return {
    type: "table",
    table: {
      table_width: width,
      has_column_header: true,
      has_row_header: false,
      children: rows.map((row) => ({
        type: "table_row",
        table_row: {
          cells: Array.from({ length: width }, (_, i) =>
            richText(row[i] || "")
          ),
        },
      })),
    },
  };
}

function imageBlock(url: string, caption: string = ""): unknown {
  return {
    type: "image",
    image: {
      type: "external",
      external: { url },
      caption: caption ? richText(caption) : [],
    },
  };
}

function bookmark(url: string): unknown {
  return {
    type: "bookmark",
    bookmark: { url },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROPERTY SIMPLIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Simplify Notion's deeply nested property format into flat key-value pairs.
 * Used by query_database to return clean, readable results.
 */
export function simplifyProperties(
  properties: Record<string, Record<string, unknown>>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, prop] of Object.entries(properties)) {
    result[key] = simplifyProperty(prop);
  }

  return result;
}

function simplifyProperty(prop: Record<string, unknown>): unknown {
  const type = prop.type as string;

  switch (type) {
    case "title":
      return richTextToPlain(prop.title as NotionRichText[]);

    case "rich_text":
      return richTextToPlain(prop.rich_text as NotionRichText[]);

    case "number":
      return prop.number ?? null;

    case "select":
      return (prop.select as { name?: string } | null)?.name ?? null;

    case "multi_select":
      return ((prop.multi_select as Array<{ name: string }>) || []).map(
        (s) => s.name
      );

    case "status":
      return (prop.status as { name?: string } | null)?.name ?? null;

    case "date": {
      const date = prop.date as { start?: string; end?: string } | null;
      if (!date) return null;
      return date.end ? { start: date.start, end: date.end } : date.start;
    }

    case "checkbox":
      return prop.checkbox ?? false;

    case "url":
      return prop.url ?? null;

    case "email":
      return prop.email ?? null;

    case "phone_number":
      return prop.phone_number ?? null;

    case "formula": {
      const formula = prop.formula as Record<string, unknown>;
      const fType = formula.type as string;
      return formula[fType] ?? null;
    }

    case "rollup": {
      const rollup = prop.rollup as Record<string, unknown>;
      const rType = rollup.type as string;
      return rollup[rType] ?? null;
    }

    case "relation":
      return ((prop.relation as Array<{ id: string }>) || []).map((r) => r.id);

    case "people":
      return ((prop.people as Array<{ name?: string; id: string }>) || []).map(
        (p) => p.name || p.id
      );

    case "files":
      return (
        (prop.files as Array<{ name?: string; file?: { url: string }; external?: { url: string } }>) || []
      ).map((f) => f.file?.url || f.external?.url || f.name);

    case "created_time":
      return prop.created_time;

    case "last_edited_time":
      return prop.last_edited_time;

    case "created_by":
      return (prop.created_by as { name?: string; id: string })?.name ?? null;

    case "last_edited_by":
      return (prop.last_edited_by as { name?: string; id: string })?.name ?? null;

    case "unique_id": {
      const uid = prop.unique_id as { prefix?: string; number?: number };
      return uid?.prefix ? `${uid.prefix}-${uid.number}` : uid?.number ?? null;
    }

    default:
      return null;
  }
}

function richTextToPlain(rt: NotionRichText[] | undefined): string {
  if (!rt) return "";
  return rt.map((r) => r.plain_text || "").join("");
}

// ═══════════════════════════════════════════════════════════════════════════════
// TITLE EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract the title from a Notion page's properties.
 * Handles both regular pages and database entries.
 */
export function extractTitle(properties: Record<string, Record<string, unknown>>): string {
  for (const prop of Object.values(properties)) {
    if (prop.type === "title") {
      return richTextToPlain(prop.title as NotionRichText[]);
    }
  }
  return "Untitled";
}
