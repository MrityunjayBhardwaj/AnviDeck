import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/**
 * The context-routing table and the always-loaded files, read from the global
 * instructions at request time instead of a hand-copied duplicate.
 *
 * Source: the "Context Routing Protocol" section of ~/.claude/CLAUDE.md — the
 * first markdown table after that heading, rows of
 *   | <Activity> (<keywords>) | `~/…/spec.md` + `…` + project `.anvi/<cat>.md` + … |
 * Always-loaded files: CLAUDE.md plus every `@~/…` import, followed
 * recursively (base-layer.md imports rules.md). Observed: these imported files
 * appear verbatim in a session's system context.
 */

export interface ParsedRoute {
  activity: string;
  /** Spec files the row says to read (basename, e.g. "diagnose.md"). */
  files: string[];
  /** Absolute paths for `files`, same order. */
  filePaths: string[];
  /** Project catalogues the row names (e.g. "hetvabhasa.md"). */
  catalogues: string[];
  /** Anything else the row names in backticks (e.g. "GROUND_TRUTH_*.md"). */
  other: string[];
}

export type RoutingSourceStatus = "ok" | "unreadable" | "unparsed";

export interface RoutingSource {
  path: string;
  status: RoutingSourceStatus;
  error?: string;
}

const HOME = homedir();
export const GLOBAL_CLAUDE_MD = join(HOME, ".claude", "CLAUDE.md");
const SECTION_HEADING = /^#{2,3}\s+Context Routing Protocol\b.*$/m;

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(HOME, p.slice(2)) : p;
}

/** Parse the routing table out of CLAUDE.md text. */
export function parseRoutingTable(markdown: string): { routes: ParsedRoute[]; error?: string } {
  const head = markdown.match(SECTION_HEADING);
  if (!head || head.index === undefined) return { routes: [], error: 'no "Context Routing Protocol" heading' };
  const after = markdown.slice(head.index + head[0].length);
  const nextSection = after.search(/^##\s/m);
  const section = nextSection === -1 ? after : after.slice(0, nextSection);

  const rows = section.split("\n").filter((l) => /^\s*\|.*\|\s*$/.test(l));
  if (rows.length < 3) return { routes: [], error: "no markdown table in the section" };
  // rows[0] = header, rows[1] = |---|---|, the rest = data
  if (!/^\s*\|[\s:|-]+\|\s*$/.test(rows[1]!)) return { routes: [], error: "table has no separator row" };

  const routes: ParsedRoute[] = [];
  for (const row of rows.slice(2)) {
    const cells = row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.length < 2) continue;
    const activity = cells[0]!.replace(/\s*\(.*$/, "").trim();
    if (!activity) continue;
    const route: ParsedRoute = { activity, files: [], filePaths: [], catalogues: [], other: [] };
    for (const m of cells.slice(1).join(" | ").matchAll(/`([^`]+)`/g)) {
      const ref = m[1]!.trim();
      const cat = ref.match(/(?:^|\/)\.anvi\/([^/]+\.md)$/);
      if (cat) route.catalogues.push(cat[1]!);
      else if (ref.startsWith("~/") || ref.startsWith("/")) {
        route.files.push(basename(ref));
        route.filePaths.push(expandHome(ref));
      } else route.other.push(ref);
    }
    routes.push(route);
  }
  if (!routes.length) return { routes, error: "table has no data rows" };
  return { routes };
}

/** Read and parse the routing table; says why when it can't. */
export function readRoutingTable(path = GLOBAL_CLAUDE_MD): { routes: ParsedRoute[]; source: RoutingSource } {
  let md: string;
  try {
    md = readFileSync(path, "utf8");
  } catch (e) {
    return { routes: [], source: { path, status: "unreadable", error: (e as Error).message } };
  }
  const { routes, error } = parseRoutingTable(md);
  if (error) return { routes: [], source: { path, status: "unparsed", error } };
  return { routes, source: { path, status: "ok" } };
}

/**
 * CLAUDE.md plus its `@~/…` / `@/…` imports, recursively (depth ≤ 5), in
 * first-seen order. Imports inside code spans or fenced blocks are ignored.
 * Unreadable imports are returned with readable: false rather than dropped.
 */
export function alwaysLoadedFiles(root = GLOBAL_CLAUDE_MD): { path: string; readable: boolean }[] {
  const out: { path: string; readable: boolean }[] = [];
  const seen = new Set<string>();
  const visit = (p: string, depth: number) => {
    if (seen.has(p) || depth > 5) return;
    seen.add(p);
    let text: string;
    try {
      text = readFileSync(p, "utf8");
    } catch {
      out.push({ path: p, readable: false });
      return;
    }
    out.push({ path: p, readable: true });
    const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
    for (const m of prose.matchAll(/(?:^|\s)@((?:~\/|\/)[^\s)]+\.md)\b/g)) {
      visit(expandHome(m[1]!), depth + 1);
    }
  };
  visit(root, 0);
  return out;
}
