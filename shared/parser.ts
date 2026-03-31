import type { CatalogueEntry, MemoryEntry } from "./types";

// Known tags to extract from entry content
const KNOWN_TAGS = [
  "FATALITY",
  "MISALIGNED",
  "NOT YET IMPLEMENTED",
  "ALIGNED",
  "CONSOLIDATION PLANNED",
  "RETIRED",
  "BLIND SPOT",
];

/**
 * Parse a catalogue markdown file into CatalogueEntry[].
 *
 * Entries start with ## (h2) or ### (h3) headers.
 * Format: ## ID: Title  or  ### ID: Title (optional tags in parens)
 * Sections within entries: **Key:** value  (bold key followed by colon)
 * Provenance fields: ORIGIN:, WHY:, HOW: (line-level, no bold)
 */
export function parseCatalogueEntries(markdown: string): CatalogueEntry[] {
  const entries: CatalogueEntry[] = [];
  // Split into entry blocks by h2 or h3 headers
  const entryPattern = /^(#{2,3})\s+(.+)$/gm;
  const headerMatches: { level: string; text: string; index: number }[] = [];

  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(markdown)) !== null) {
    headerMatches.push({
      level: match[1],
      text: match[2],
      index: match.index,
    });
  }

  for (let i = 0; i < headerMatches.length; i++) {
    const header = headerMatches[i];
    const nextIndex =
      i + 1 < headerMatches.length
        ? headerMatches[i + 1].index
        : markdown.length;
    const body = markdown.slice(
      header.index + header.level.length + 1 + header.text.length + 1,
      nextIndex
    );

    const entry = parseEntryBlock(header.text.trim(), body);
    if (entry) entries.push(entry);
  }

  return entries;
}

function parseEntryBlock(
  headerText: string,
  body: string
): CatalogueEntry | null {
  // Parse header: "SP9: Parameter Name Mismatch at Layer Boundary"
  // or: "B2: AudioInterpreter ↔ SuperSonicBridge (FATALITY — 5 patterns cluster here)"
  const headerMatch = headerText.match(/^([A-Z][A-Za-z]*\d+):\s*(.+)$/);
  if (!headerMatch) return null;

  const id = headerMatch[1];
  let titleRaw = headerMatch[2];

  // Extract tags from title (in parentheses)
  const tags: string[] = [];
  const parenMatch = titleRaw.match(/\(([^)]+)\)/);
  if (parenMatch) {
    const parenContent = parenMatch[1];
    for (const tag of KNOWN_TAGS) {
      if (parenContent.includes(tag)) tags.push(tag);
    }
    titleRaw = titleRaw.replace(/\s*\([^)]+\)/, "").trim();
  }

  // Extract tags from body
  for (const tag of KNOWN_TAGS) {
    if (!tags.includes(tag) && body.includes(tag)) {
      tags.push(tag);
    }
  }

  // Parse sections: **Key:** value
  const sections: Record<string, string> = {};
  const sectionPattern = /\*\*([^*]+?):\*\*\s*(.+?)(?=\n\*\*[^*]+?:\*\*|\n(?:ORIGIN|WHY|HOW):|$)/gs;
  let sMatch: RegExpExecArray | null;
  while ((sMatch = sectionPattern.exec(body)) !== null) {
    sections[sMatch[1].trim()] = sMatch[2].trim();
  }

  // Parse provenance fields (ORIGIN:, WHY:, HOW:) — line-level, not bold
  const origin = extractProvenance(body, "ORIGIN");
  const why = extractProvenance(body, "WHY");
  const how = extractProvenance(body, "HOW");

  return { id, title: titleRaw, sections, tags, origin, why, how };
}

function extractProvenance(
  body: string,
  field: string
): string | undefined {
  // Match "FIELD: content" that may span multiple lines until next field or section
  const pattern = new RegExp(
    `^${field}:\\s*(.+?)(?=\\n(?:ORIGIN|WHY|HOW|\\*\\*)|$)`,
    "ms"
  );
  const match = body.match(pattern);
  return match ? match[1].trim() : undefined;
}

/**
 * Parse a memory markdown file with YAML frontmatter.
 *
 * Format:
 * ---
 * name: ...
 * description: ...
 * type: ...
 * ---
 * content here
 */
export function parseMemoryFile(
  markdown: string,
  filePath: string
): MemoryEntry | null {
  const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return null;

  const frontmatter = fmMatch[1];
  const content = fmMatch[2].trim();

  const name = extractFrontmatterField(frontmatter, "name") ?? "";
  const description =
    extractFrontmatterField(frontmatter, "description") ?? "";
  const type =
    (extractFrontmatterField(frontmatter, "type") as MemoryEntry["type"]) ??
    "project";

  // Extract sections from content: **Key:** value
  const sections: Record<string, string> = {};
  const sectionPattern = /\*\*([^*]+?):\*\*\s*(.+?)(?=\n\*\*[^*]+?:\*\*|$)/gs;
  let sMatch: RegExpExecArray | null;
  while ((sMatch = sectionPattern.exec(content)) !== null) {
    sections[sMatch[1].trim()] = sMatch[2].trim();
  }

  return { name, description, type, content, sections, filePath };
}

function extractFrontmatterField(
  frontmatter: string,
  field: string
): string | undefined {
  const match = frontmatter.match(
    new RegExp(`^${field}:\\s*(.+)$`, "m")
  );
  return match ? match[1].trim() : undefined;
}
