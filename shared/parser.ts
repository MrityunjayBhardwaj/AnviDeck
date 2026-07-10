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
  const seenIds = new Set<string>();
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
    // Fold an h3 sub-section that repeats an entry's ID back into that entry —
    // e.g. an h3 "### SP107 — ORIGINAL FRAMING (SUPERSEDED)" audit block beneath
    // the "## SP107:" entry is not a separate entry. Only h3 repeats are folded:
    // two h2 headers sharing an ID are BOTH kept — that's a duplicate-ID data
    // error the framework counts too, and the tree should surface it, not
    // silently merge it away.
    if (entry) {
      const isRepeatedSubSection =
        header.level.length === 3 && seenIds.has(entry.id);
      if (!isRepeatedSubSection) {
        seenIds.add(entry.id);
        entries.push(entry);
      }
    }
  }

  return entries;
}

function parseEntryBlock(
  headerText: string,
  body: string
): CatalogueEntry | null {
  // Recognize an entry whenever the header STARTS with an ID token, mirroring
  // the framework's canonical counter (`^## ([A-Z]+\d+)`, colon-optional). The
  // colon and title are optional, so all of these count as one entry:
  //   "SP9: Parameter Name Mismatch at Layer Boundary"   (canonical)
  //   "SP47 (Meta-Pattern): SP36 corrupts isolation…"    (annotation before colon)
  //   "SV56"                                             (bare ID, no title)
  // Prose section headers ("Compaction Log", "Ground Truth Inventory") have no
  // leading ID and are still skipped.
  const headerMatch = headerText.match(/^([A-Z][A-Za-z]*\d+)\s*:?\s*(.*)$/);
  if (!headerMatch) return null;

  const id = headerMatch[1];

  // Skip template example entries (U1, UV1, UK1, UH1, …) — placeholders shipped
  // in the catalogue templates, not real project knowledge. The framework's
  // canonical counter excludes them the same way (`!/^U[A-Z]?\d+$/`).
  if (/^U[A-Z]?\d+$/.test(id)) return null;

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

  // Extract Ground Truth REF field (v1.1.0+)
  const ref = sections["REF"] || extractRefLine(body);
  const grounded = !!ref && !ref.includes("UNGROUNDED");

  return { id, title: titleRaw, sections, tags, origin, why, how, ref, grounded };
}

/**
 * Extract **REF:** line from entry body.
 * REF lines link catalogue entries to Ground Truth docs (v1.1.0+).
 * Format: **REF:** GROUND_TRUTH_X.md#section — file:line description
 */
function extractRefLine(body: string): string | undefined {
  const match = body.match(/\*\*REF:\*\*\s*(.+)/);
  return match ? match[1].trim() : undefined;
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
