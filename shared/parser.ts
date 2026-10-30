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
export function parseCatalogueEntries(
  markdown: string,
  catalogueName?: string
): CatalogueEntry[] {
  // Status in a HEADER is a convention of the status-bearing catalogues only
  // (see extractTags). Error-pattern and lifecycle headers are lesson titles,
  // where a tag word is prose ("…IS A BLIND SPOT THE DAY…").
  const headerTags = !catalogueName || HEADER_STATUS_CATALOGUES.includes(catalogueName);
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

    const entry = parseEntryBlock(header.text.trim(), body, headerTags);
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

/**
 * The entry-ID rule, shared by every reader that needs to know which header
 * starts an entry (the parser itself, per-entry history dates, ...).
 *
 * Recognize an entry whenever the header STARTS with an ID token, mirroring
 * the framework's canonical counter (`^## ([A-Z]+\d+)`, colon-optional). The
 * colon and title are optional, so all of these count as one entry:
 *   "SP9: Parameter Name Mismatch at Layer Boundary"   (canonical)
 *   "SP47 (Meta-Pattern): SP36 corrupts isolation..."  (annotation before colon)
 *   "SV56"                                             (bare ID, no title)
 * Prose section headers ("Compaction Log", "Ground Truth Inventory") have no
 * leading ID and are skipped. Template example entries (U1, UV1, UK1, UH1, ...)
 * are placeholders shipped in the catalogue templates, not real project
 * knowledge; the framework's canonical counter excludes them the same way
 * (`!/^U[A-Z]?\d+$/`).
 *
 * `headerText` is the header without its leading `## ` / `### `.
 */
export function entryIdFromHeader(
  headerText: string
): { id: string; rest: string } | null {
  const m = headerText.match(/^([A-Z][A-Za-z]*\d+)\s*:?\s*(.*)$/);
  if (!m) return null;
  if (/^U[A-Z]?\d+$/.test(m[1])) return null;
  return { id: m[1], rest: m[2] };
}

/**
 * Status tags an entry CARRIES, as opposed to words its prose mentions.
 *
 * A tag counts only where catalogues state status:
 *   1. the entry's header line, in the status-bearing catalogues (vyapti,
 *      dharana) — anvi's own scans read MISALIGNED from vyapti headers
 *      (hooks/debug-grounding-gate.js, hooks/ground-truth-session-start.js:
 *      `^## <ID>:…MISALIGNED`) and FATALITY from dharana
 *      (hooks/catalogue-context-injector.js), or
 *   2. the value of a status field — a line labelled `Status:`,
 *      `**Status:**`, `**Current status:**`, `STATUS:`, `**Fatality status:**`
 *      (dharana-spec's "Status: ALIGNED / MISALIGNED / CONSOLIDATION PLANNED").
 * Anywhere else (narrative, amendments, cross-references, tables about other
 * entries) the word is a mention and does not tag the entry. Within those two
 * places a tag is still skipped when it is struck through (~~X~~), negated or
 * historical ("was X", "not X", "no longer X", "NOT YET A FATALITY"), or part
 * of a template list of options ("ALIGNED / MISALIGNED / …").
 * Matching is whole-word, so ALIGNED does not fire inside MISALIGNED.
 */
export function extractTags(headerRest: string, body: string): string[] {
  const places: string[] = [headerRest];
  const fatalityTestPlaces: string[] = [headerRest];
  for (const line of body.split("\n")) {
    const m = line.match(STATUS_LINE);
    if (m) places.push(m[1]!);
    if (FATALITY_TEST_LINE.test(line)) fatalityTestPlaces.push(line);
  }
  const tags: string[] = [];
  // The fatality test's own result line ("FATALITY TEST: … TRIPPED",
  // "(…; fatality test TRIPPED: 3 patterns…)") — dharana-spec §4 records
  // "fatality test results"; a "NOT re-tripped" / "not tripped" reading is not one.
  if (fatalityTestPlaces.some((p) => FATALITY_TRIPPED.test(p.replace(/~~[^~]*~~/g, " ")))) {
    tags.push("FATALITY");
  }
  for (const raw of places) {
    const text = raw.replace(/~~[^~]*~~/g, " ");
    if (TEMPLATE_OPTIONS.test(text)) continue;
    for (const tag of KNOWN_TAGS) {
      if (tags.includes(tag)) continue;
      const re = new RegExp(`(?<![A-Za-z])${tag}(?![A-Za-z])`, "g");
      for (const hit of text.matchAll(re)) {
        const before = text.slice(Math.max(0, hit.index! - 24), hit.index!);
        if (tag !== "NOT YET IMPLEMENTED" && NEGATED_BEFORE.test(before)) continue;
        tags.push(tag);
        break;
      }
    }
  }
  return tags;
}

/** Catalogues whose entry headers may carry a status tag. */
const HEADER_STATUS_CATALOGUES = ["vyapti", "dharana"];
/** `<label containing "status">: <value>` with optional markdown around the label. */
const STATUS_LINE = /^[\s>#*_|\-]*[^:\n]{0,40}?\bstatus\b[^:\n]{0,40}?(?:\*\*)?\s*:\s*(?:\*\*)?(.*)$/i;
/** A body line that starts (ignoring markdown/symbols) with "fatality test". */
const FATALITY_TEST_LINE = /^[^A-Za-z]*fatality test\b/i;
/** "fatality test … tripped" with no "not" in between. */
const FATALITY_TRIPPED = /\bfatality test\b(?:(?!\bnot\b)[^.\n]){0,80}?\btripped\b/i;
/** Words right before a tag that make it historical or negated. */
const NEGATED_BEFORE = /\b(?:was|were|not|no longer|formerly|never|not yet an?|previously)\s+(?:an?\s+|the\s+)?(?:[A-Za-z-]+\s+)?$/i;
/** "ALIGNED / MISALIGNED / CONSOLIDATION PLANNED" — a list of options, not a status. */
const TEMPLATE_OPTIONS = /\b[A-Z][A-Z ]+ \/ [A-Z][A-Z ]+\b/;

/** A catalogue header line: `## text` or `### text`. */
export const ENTRY_HEADER_LINE = /^(#{2,3})\s+(.+)$/;

function parseEntryBlock(
  headerText: string,
  body: string,
  headerTags = true
): CatalogueEntry | null {
  const headerMatch = entryIdFromHeader(headerText);
  if (!headerMatch) return null;

  const id = headerMatch.id;

  let titleRaw = headerMatch.rest;
  const tags = extractTags(headerTags ? titleRaw : "", body);
  if (/\([^)]+\)/.test(titleRaw)) {
    titleRaw = titleRaw.replace(/\s*\([^)]+\)/, "").trim();
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
