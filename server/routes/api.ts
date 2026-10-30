import { Hono } from "hono";
import { join } from "node:path";
import {
  readCatalogues,
  extractBoundaries,
  countSignals,
  findAnviDir,
  GROUNDING_CATALOGUES,
} from "../readers/catalogue";
import { readProjectMemory, readGlobalMemory } from "../readers/memory";
import {
  getTimeline,
  showAtCommit,
  diffCommits,
  readEntryDatesForFile,
} from "../readers/git-history";
import { readGroundingStatus } from "../readers/ground-truth";
import { readLiveSessions } from "../readers/sessions";
import { readRoutingTable, alwaysLoadedFiles } from "../readers/routing";
import { discoverProjects, type DiscoveredProject } from "../readers/projects";
import { resolveDir } from "../../shared/anvi-paths";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import type { ProjectSummary, ProjectState, HookLogEntry, EntryDate } from "../../shared/types";

const api = new Hono();

// GET /api/sessions — live (currently-running) Claude Code sessions
api.get("/sessions", (c) => c.json(readLiveSessions()));

/**
 * Discovered projects, plus a lookup by short name. Path decoding lives in
 * ../readers/projects (transcript cwd → filesystem walk → unresolved); a
 * project whose path cannot be determined has decoded === null and is never
 * read from a guessed path.
 */
function listProjects(): DiscoveredProject[] {
  return discoverProjects().projects;
}

/** Body for a project whose path could not be determined (never guessed). */
function unresolvedBody(proj: DiscoveredProject) {
  return {
    error: "Project path could not be determined",
    status: "unresolved",
    encoded: proj.encoded,
    candidates: proj.candidates ?? [],
  };
}

function findProject(name: string): DiscoveredProject | undefined {
  const all = listProjects();
  // A resolved project wins over an unresolved one that happens to share the name.
  return all.find((p) => p.name === name && p.decoded) ?? all.find((p) => p.name === name);
}

// GET /api/projects — all projects with catalogue counts
api.get("/projects", async (c) => {
  const projects = listProjects();
  const summaries: ProjectSummary[] = [];

  for (const proj of projects) {
    const catalogues = proj.decoded ? await readCatalogues(proj.decoded) : [];
    const memory = await readProjectMemory(proj.encoded);
    const signals = countSignals(catalogues);

    const catalogueCounts: Record<string, number> = {};
    for (const cat of catalogues) {
      catalogueCounts[cat.name] = cat.entries.length;
    }

    // Grounding stats — over the knowledge catalogues only (dharana excluded,
    // matching anvi's grounding metric).
    let totalEntries = 0;
    let groundedEntries = 0;
    for (const cat of catalogues) {
      if (!GROUNDING_CATALOGUES.includes(cat.name)) continue;
      for (const entry of cat.entries) {
        totalEntries++;
        if (entry.grounded) groundedEntries++;
      }
    }
    const groundingPercent = totalEntries > 0 ? Math.round((groundedEntries / totalEntries) * 100) : 0;

    // Count Ground Truth docs
    let groundTruthDocCount = 0;
    try {
      const refDir = proj.decoded ? resolveDir(proj.decoded, "ref") : null;
      const refFiles = refDir ? readdirSync(refDir) : [];
      groundTruthDocCount = refFiles.filter((f: string) => f.startsWith("GROUND_TRUTH_") && f.endsWith(".md")).length;
    } catch {}

    summaries.push({
      name: proj.name,
      path: proj.decoded ?? "",
      pathSource: proj.pathSource,
      catalogueCounts,
      memoryCount: memory.length,
      ...signals,
      groundingPercent,
      groundTruthDocCount,
    });
  }

  return c.json(summaries);
});

// GET /api/project/:name — full project state
api.get("/project/:name", async (c) => {
  const name = c.req.param("name");
  const proj = findProject(name);

  if (!proj) return c.json({ error: "Project not found" }, 404);
  if (!proj.decoded) return c.json(unresolvedBody(proj), 404);

  const catalogues = await readCatalogues(proj.decoded);
  const memory = await readProjectMemory(proj.encoded);
  const signals = countSignals(catalogues);
  const boundaries = extractBoundaries(catalogues);

  const grounding = await readGroundingStatus(proj.decoded);

  const state: ProjectState = {
    name: proj.name,
    path: proj.decoded,
    pathSource: proj.pathSource,
    catalogues,
    memory,
    boundaries,
    ...signals,
    grounding,
  };

  return c.json(state);
});

// GET /api/project/:name/catalogues — just catalogues
api.get("/project/:name/catalogues", async (c) => {
  const name = c.req.param("name");
  const proj = findProject(name);

  if (!proj) return c.json({ error: "Project not found" }, 404);
  if (!proj.decoded) return c.json(unresolvedBody(proj), 404);

  const catalogues = await readCatalogues(proj.decoded);
  return c.json(catalogues);
});

// GET /api/project/:name/memory — project memory
api.get("/project/:name/memory", async (c) => {
  const name = c.req.param("name");
  const proj = findProject(name);

  if (!proj) return c.json({ error: "Project not found" }, 404);

  const memory = await readProjectMemory(proj.encoded);
  return c.json(memory);
});

// GET /api/memory — global memory
api.get("/memory", async (c) => {
  const memory = await readGlobalMemory();
  return c.json(memory);
});

// GET /api/timeline — git commit history
api.get("/timeline", async (c) => {
  const limit = parseInt(c.req.query("limit") ?? "100", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  const points = await getTimeline(limit, offset);
  return c.json(points);
});

// GET /api/state-at/:hash — show file at specific commit
api.get("/state-at/:hash", async (c) => {
  const hash = c.req.param("hash");
  const file = c.req.query("file");
  if (!file) return c.json({ error: "file query param required" }, 400);

  const content = await showAtCommit(hash, file);
  if (content === null) return c.json({ error: "Not found" }, 404);
  return c.json({ hash, file, content });
});

// GET /api/diff/:from/:to — diff between two commits
api.get("/diff/:from/:to", async (c) => {
  const from = c.req.param("from");
  const to = c.req.param("to");
  const diff = await diffCommits(from, to);
  return c.json({ from, to, diff });
});

// GET /api/routing-architecture — three-tier context architecture with file sizes.
// Tier 1 and the routing table are derived from ~/.claude/CLAUDE.md at request
// time (see readers/routing). `source` reports whether that parse succeeded;
// when it did not, routingTable is empty and source.error says why.
api.get("/routing-architecture", async (c) => {
  const home = process.env.HOME ?? "/Users/mrityunjaybhardwaj";

  function fileInfo(filePath: string, displayName?: string) {
    const name = displayName ?? filePath.split("/").pop() ?? filePath;
    try {
      const sizeBytes = statSync(filePath).size;
      return { path: filePath, name, sizeBytes, estimatedTokens: Math.round(sizeBytes / 4), readable: true };
    } catch {
      return { path: filePath, name, sizeBytes: 0, estimatedTokens: 0, readable: false };
    }
  }

  // Tier 1: always loaded — CLAUDE.md and everything it @-imports.
  const tier1Files = alwaysLoadedFiles().map((f, i) =>
    fileInfo(f.path, i === 0 ? "CLAUDE.md (global)" : undefined)
  );

  // Tier 2: Hook injection (dynamic, no static files)
  const tier2Files = [
    {
      path: join(home, ".claude", "hooks", "catalogue-context-injector.js"),
      name: "catalogue-context-injector.js (dynamic injection)",
      sizeBytes: 0,
      estimatedTokens: 500, // average injection size
    },
  ];

  // Tier 3: per-activity routing, parsed from CLAUDE.md.
  const { routes, source } = readRoutingTable();

  const tier3ByPath = new Map<string, ReturnType<typeof fileInfo>>();
  for (const route of routes) {
    route.filePaths.forEach((fp, i) => {
      if (!tier3ByPath.has(fp)) tier3ByPath.set(fp, fileInfo(fp, route.files[i]));
    });
  }
  const tier3Files = [...tier3ByPath.values()];

  const tier1Total = tier1Files.reduce((s, f) => s + f.estimatedTokens, 0);
  const tier2Total = tier2Files.reduce((s, f) => s + f.estimatedTokens, 0);
  const tier3Total = tier3Files.reduce((s, f) => s + f.estimatedTokens, 0);

  const routingTableWithCosts = routes.map((route) => {
    const files = route.filePaths.map((fp) => tier3ByPath.get(fp)!);
    return {
      activity: route.activity,
      files: route.files,
      catalogues: route.catalogues,
      other: route.other,
      totalTokens: tier1Total + files.reduce((s, f) => s + f.estimatedTokens, 0),
      fileDetails: files,
    };
  });

  return c.json({
    tiers: [
      {
        tier: 1,
        name: "Always Loaded",
        description: "Loaded every prompt. Global instructions and every file they @-import.",
        files: tier1Files,
        totalTokens: tier1Total,
      },
      {
        tier: 2,
        name: "Per-Action (Hook)",
        description: "Injected by catalogue-context-injector on Write|Edit. Project-specific boundary checks.",
        files: tier2Files,
        totalTokens: tier2Total,
      },
      {
        tier: 3,
        name: "Per-Activity (Routed)",
        description: "Loaded based on activity classification. Full spec files for the current task type.",
        files: tier3Files,
        totalTokens: tier3Total,
      },
    ],
    routingTable: routingTableWithCosts,
    source,
    totalCapacity: 200_000,
  });
});

// GET /api/cross-project — cross-project pattern analysis
api.get("/cross-project", async (c) => {
  const projects = listProjects();
  const allEntries: {
    project: string;
    catalogue: string;
    id: string;
    title: string;
    sections: Record<string, string>;
    tags: string[];
  }[] = [];
  const allMemory: {
    project: string;
    name: string;
    description: string;
    type: string;
  }[] = [];

  // Load all projects with catalogues
  for (const proj of projects) {
    const catalogues = proj.decoded ? await readCatalogues(proj.decoded) : [];
    for (const cat of catalogues) {
      for (const entry of cat.entries) {
        allEntries.push({
          project: proj.name,
          catalogue: cat.name,
          id: entry.id,
          title: entry.title,
          sections: entry.sections,
          tags: entry.tags,
        });
      }
    }

    const memory = await readProjectMemory(proj.encoded);
    for (const mem of memory) {
      allMemory.push({
        project: proj.name,
        name: mem.name,
        description: mem.description,
        type: mem.type,
      });
    }
  }

  // Find recurring hetvabhasa patterns across projects
  const hetvabhasaEntries = allEntries.filter((e) => e.catalogue === "hetvabhasa");
  const recurringPatterns = findRecurringPatterns(hetvabhasaEntries);

  // Find shared vyapti invariants across projects
  const vyaptiEntries = allEntries.filter((e) => e.catalogue === "vyapti");
  const sharedInvariants = findRecurringPatterns(vyaptiEntries);

  // Group memory by type
  const memoryByType: Record<
    string,
    { project: string; name: string; description: string }[]
  > = {};
  for (const mem of allMemory) {
    if (!memoryByType[mem.type]) memoryByType[mem.type] = [];
    memoryByType[mem.type].push({
      project: mem.project,
      name: mem.name,
      description: mem.description,
    });
  }

  return c.json({
    recurringPatterns,
    sharedInvariants,
    memoryNetwork: { byType: memoryByType, totalCount: allMemory.length },
    projectCount: projects.length,
  });
});

/**
 * Find entries across different projects that share significant keywords
 * in their title or sections.
 */
function findRecurringPatterns(
  entries: {
    project: string;
    catalogue: string;
    id: string;
    title: string;
    sections: Record<string, string>;
    tags: string[];
  }[]
): {
  keyword: string;
  entries: { project: string; entryId: string; title: string; content: string }[];
}[] {
  // Extract significant keywords from each entry
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "must", "ought",
    "and", "but", "or", "nor", "not", "so", "yet", "both", "either",
    "neither", "each", "every", "all", "any", "few", "more", "most",
    "other", "some", "such", "no", "only", "own", "same", "than",
    "too", "very", "just", "because", "as", "until", "while", "of",
    "at", "by", "for", "with", "about", "against", "between", "through",
    "during", "before", "after", "above", "below", "to", "from", "up",
    "down", "in", "out", "on", "off", "over", "under", "again", "further",
    "then", "once", "here", "there", "when", "where", "why", "how",
    "this", "that", "these", "those", "what", "which", "who", "whom",
    "it", "its", "if", "into",
  ]);

  function extractKeywords(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !stopWords.has(w));
  }

  // Build keyword → entries map
  const keywordMap = new Map<
    string,
    Set<string> // project names
  >();
  const keywordEntries = new Map<
    string,
    { project: string; entryId: string; title: string; content: string }[]
  >();

  for (const entry of entries) {
    const text = [
      entry.title,
      ...Object.values(entry.sections),
      ...entry.tags,
    ].join(" ");
    const keywords = extractKeywords(text);

    for (const kw of new Set(keywords)) {
      if (!keywordMap.has(kw)) keywordMap.set(kw, new Set());
      keywordMap.get(kw)!.add(entry.project);

      if (!keywordEntries.has(kw)) keywordEntries.set(kw, []);
      // Avoid duplicating same entry for same keyword
      const existing = keywordEntries.get(kw)!;
      if (!existing.some((e) => e.entryId === entry.id && e.project === entry.project)) {
        existing.push({
          project: entry.project,
          entryId: entry.id,
          title: entry.title,
          content: Object.values(entry.sections).join(" ").slice(0, 200),
        });
      }
    }
  }

  // Find keywords that appear in 2+ different projects
  const patterns: {
    keyword: string;
    entries: { project: string; entryId: string; title: string; content: string }[];
  }[] = [];

  for (const [keyword, projectSet] of keywordMap) {
    if (projectSet.size >= 2) {
      patterns.push({
        keyword,
        entries: keywordEntries.get(keyword) ?? [],
      });
    }
  }

  // Sort by number of projects (most widespread first), then by entry count
  patterns.sort((a, b) => {
    const aProjects = new Set(a.entries.map((e) => e.project)).size;
    const bProjects = new Set(b.entries.map((e) => e.project)).size;
    if (bProjects !== aProjects) return bProjects - aProjects;
    return b.entries.length - a.entries.length;
  });

  // Deduplicate: if two keywords have the exact same entry set, keep the one with more entries
  const seen = new Set<string>();
  const deduped: typeof patterns = [];
  for (const p of patterns) {
    const key = p.entries.map((e) => `${e.project}:${e.entryId}`).sort().join("|");
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(p);
    }
  }

  return deduped.slice(0, 50); // top 50
}

// GET /api/hook-logs — aggregated hook log data from /tmp/
api.get("/hook-logs", (c) => {
  const sessions: Record<
    string,
    {
      sid: string;
      entries: HookLogEntry[];
      boundaries: string[];
      totalFires: number;
      fatalityFires: number;
    }
  > = {};

  try {
    const files = readdirSync("/tmp").filter(
      (f) => f.startsWith("anvi-hook-") && f.endsWith(".log")
    );

    for (const file of files) {
      const filePath = join("/tmp", file);
      let content: string;
      try {
        content = readFileSync(filePath, "utf8");
      } catch {
        continue;
      }

      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry: HookLogEntry = JSON.parse(trimmed);
          const sid = entry.sid || "unknown";
          if (!sessions[sid]) {
            sessions[sid] = {
              sid,
              entries: [],
              boundaries: [],
              totalFires: 0,
              fatalityFires: 0,
            };
          }
          const s = sessions[sid];
          s.entries.push(entry);
          s.totalFires++;
          if (entry.fatality) s.fatalityFires++;
          for (const b of entry.boundaries) {
            if (!s.boundaries.includes(b)) s.boundaries.push(b);
          }
        } catch {
          // skip malformed
        }
      }
    }
  } catch {
    // /tmp read failed
  }

  return c.json({ sessions: Object.values(sessions) });
});

// GET /api/project/:name/entry-dates — per-entry dates for catalogue entries.
// Body: { [entryId]: { created, lastModified, dateSource } } where dateSource
// says how each date was obtained ("entry" | "file" | "none", see
// readEntryDatesForFile). A catalogue file that exists but cannot be read
// answers 503 rather than an empty map.
api.get("/project/:name/entry-dates", async (c) => {
  const name = c.req.param("name");
  const proj = findProject(name);
  if (!proj) return c.json({ error: "Project not found" }, 404);
  if (!proj.decoded) return c.json(unresolvedBody(proj), 404);

  const dates: Record<string, EntryDate> = {};
  const anviDir = findAnviDir(proj.decoded);
  if (!anviDir) return c.json(dates);

  for (const file of ["hetvabhasa.md", "vyapti.md", "krama.md", "dharana.md"]) {
    const filePath = join(anviDir, file);
    try {
      statSync(filePath);
    } catch {
      continue; // this catalogue does not exist: nothing to date
    }
    try {
      const perEntry = await readEntryDatesForFile(filePath);
      for (const [id, d] of Object.entries(perEntry)) dates[id] ??= d;
    } catch (e) {
      return c.json({ error: `could not read ${filePath}: ${(e as Error).message}`, status: "unreadable" }, 503);
    }
  }

  return c.json(dates);
});

// ---- GitHub Trace ----

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "when",
  "which", "where", "there", "then", "they", "them", "their", "have",
  "been", "being", "will", "would", "could", "should", "does", "done",
  "what", "more", "some", "each", "over", "also", "only", "same",
  "both", "very", "just", "than", "used", "uses", "using", "call",
  "calls", "code", "file", "line", "type", "name", "data", "null",
  "true", "false", "value", "values", "return", "returns", "function",
  "class", "method", "object", "array", "error", "result", "output",
]);

function extractKeywords(text: string): string[] {
  return [...new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP_WORDS.has(w))
  )];
}

function entryKeywords(entry: { title: string; sections: Record<string, string>; why?: string }): string[] {
  const text = [
    entry.title,
    entry.sections["Root cause"] ?? "",
    entry.sections["Detection signal"] ?? "",
    entry.sections["STATEMENT"] ?? "",
    entry.why ?? "",
  ].join(" ");
  return extractKeywords(text);
}

function scoreArtifact(
  artifactTitle: string,
  artifactBody: string,
  artifactDate: string,
  keywords: string[],
  entryCreatedAt: string | null,
): { confidence: "high" | "medium" | null; matchedKeywords: string[] } {
  const titleLower = artifactTitle.toLowerCase();
  const bodyLower = artifactBody.toLowerCase();

  const titleMatches = keywords.filter((kw) => titleLower.includes(kw));
  const bodyMatches = keywords.filter((kw) => bodyLower.includes(kw) && !titleMatches.includes(kw));

  // Temporal proximity bonus: entry created within 48h of artifact
  let temporalBonus = false;
  if (entryCreatedAt) {
    const entryTs = new Date(entryCreatedAt).getTime();
    const artTs = new Date(artifactDate).getTime();
    const diffHours = Math.abs(entryTs - artTs) / (1000 * 60 * 60);
    if (diffHours <= 48) temporalBonus = true;
  }

  const allMatched = [...titleMatches, ...bodyMatches];
  if (allMatched.length === 0) return { confidence: null, matchedKeywords: [] };

  let confidence: "high" | "medium" | null = null;
  if (titleMatches.length >= 3 || titleMatches.length >= 2 || (titleMatches.length >= 1 && temporalBonus)) {
    confidence = "high";
  } else if (bodyMatches.length >= 3 || (bodyMatches.length >= 2 && temporalBonus)) {
    confidence = "high";
  } else if (titleMatches.length >= 1 || bodyMatches.length >= 2) {
    confidence = "medium";
  } else if (temporalBonus && allMatched.length >= 1) {
    confidence = "medium";
  }

  return { confidence, matchedKeywords: allMatched.slice(0, 8) };
}

function readCache(name: string): { data: unknown; age: number } | null {
  const path = join("/tmp", `anvi-github-trace-${name}.json`);
  try {
    const { statSync, readFileSync } = require("node:fs");
    const st = statSync(path);
    const age = (Date.now() - st.mtimeMs) / 1000;
    const data = JSON.parse(readFileSync(path, "utf8"));
    return { data, age };
  } catch {
    return null;
  }
}

function writeCache(name: string, data: unknown): void {
  const path = join("/tmp", `anvi-github-trace-${name}.json`);
  try {
    const { writeFileSync } = require("node:fs");
    writeFileSync(path, JSON.stringify(data));
  } catch {
    // cache write failure is non-fatal
  }
}

// GET /api/project/:name/github-trace
api.get("/project/:name/github-trace", async (c) => {
  const name = c.req.param("name");
  const forceRefresh = c.req.query("refresh") === "1";

  const proj = findProject(name);
  if (!proj) return c.json({ error: "Project not found" }, 404);
  if (!proj.decoded) return c.json(unresolvedBody(proj), 404);
  const projectPath = proj.decoded;

  // Return cached if fresh enough
  if (!forceRefresh) {
    const cached = readCache(name);
    if (cached && cached.age < 600) {
      return c.json(cached.data);
    }
  }

  const catalogues = await readCatalogues(projectPath);

  // Fetch commits (always available)
  let commits: { hash: string; date: string; subject: string }[] = [];
  try {
    const raw = execSync(
      `git log --format="%H|||%aI|||%s" -n 100`,
      { cwd: projectPath, encoding: "utf8", timeout: 8000 }
    ).trim();
    commits = raw.split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, date, ...rest] = line.split("|||");
        return { hash: (hash ?? "").slice(0, 8), date: date ?? "", subject: rest.join("|||") };
      });
  } catch {
    // git unavailable for this project
  }

  // Fetch issues + PRs via gh CLI
  let issues: { number: number; title: string; body: string; createdAt: string; url: string }[] = [];
  let prs: { number: number; title: string; body: string; createdAt: string; url: string }[] = [];
  let repoUrl: string | null = null;
  let ghError: string | null = null;

  try {
    const issueRaw = execSync(
      `gh issue list --json number,title,body,createdAt,url --limit 100`,
      { cwd: projectPath, encoding: "utf8", timeout: 12000 }
    );
    issues = JSON.parse(issueRaw);
  } catch (e: unknown) {
    ghError = e instanceof Error ? e.message.split("\n")[0] : "gh issue list failed";
  }

  try {
    const prRaw = execSync(
      `gh pr list --json number,title,body,createdAt,url --limit 50 --state all`,
      { cwd: projectPath, encoding: "utf8", timeout: 12000 }
    );
    prs = JSON.parse(prRaw);
  } catch (e: unknown) {
    if (!ghError) ghError = e instanceof Error ? e.message.split("\n")[0] : "gh pr list failed";
  }

  try {
    const repoRaw = execSync(
      `gh repo view --json url`,
      { cwd: projectPath, encoding: "utf8", timeout: 8000 }
    );
    repoUrl = JSON.parse(repoRaw)?.url ?? null;
  } catch {
    // repo url non-critical
  }

  // Entry creation dates for temporal proximity. Only a real per-entry date
  // ("entry") earns the bonus: a file-level date would credit every entry in
  // the file with the same moment.
  const entryDatesMap: Record<string, string> = {};
  for (const cat of catalogues) {
    try {
      const perEntry = await readEntryDatesForFile(cat.path);
      for (const [id, d] of Object.entries(perEntry)) {
        if (d.dateSource === "entry" && d.created && !entryDatesMap[id]) entryDatesMap[id] = d.created;
      }
    } catch {
      // unreadable catalogue: no temporal bonus for its entries
    }
  }

  // Correlate entries with artifacts
  const entryTraces: EntryTrace[] = [];
  let correlationCount = 0;

  for (const cat of catalogues) {
    for (const entry of cat.entries) {
      const keywords = entryKeywords(entry);
      if (keywords.length === 0) continue;

      const artifacts: GitHubArtifact[] = [];
      const entryCreated = entryDatesMap[entry.id] ?? null;

      // Score issues
      for (const issue of issues) {
        const { confidence, matchedKeywords } = scoreArtifact(
          issue.title, issue.body ?? "", issue.createdAt, keywords, entryCreated
        );
        if (confidence) {
          artifacts.push({
            type: "issue",
            id: `#${issue.number}`,
            title: issue.title,
            url: issue.url,
            date: issue.createdAt,
            confidence,
            matchedKeywords,
          });
        }
      }

      // Score PRs
      for (const pr of prs) {
        const { confidence, matchedKeywords } = scoreArtifact(
          pr.title, pr.body ?? "", pr.createdAt, keywords, entryCreated
        );
        if (confidence) {
          artifacts.push({
            type: "pr",
            id: `#${pr.number}`,
            title: pr.title,
            url: pr.url,
            date: pr.createdAt,
            confidence,
            matchedKeywords,
          });
        }
      }

      // Score commits (title only — body too noisy)
      for (const commit of commits) {
        const { confidence, matchedKeywords } = scoreArtifact(
          commit.subject, "", commit.date, keywords, entryCreated
        );
        if (confidence) {
          artifacts.push({
            type: "commit",
            id: commit.hash,
            title: commit.subject,
            url: repoUrl ? `${repoUrl}/commit/${commit.hash}` : null,
            date: commit.date,
            confidence,
            matchedKeywords,
          });
        }
      }

      // Sort by confidence then date
      artifacts.sort((a, b) => {
        if (a.confidence !== b.confidence) return a.confidence === "high" ? -1 : 1;
        return new Date(b.date).getTime() - new Date(a.date).getTime();
      });

      if (artifacts.length > 0) correlationCount++;

      entryTraces.push({
        entryId: entry.id,
        entryTitle: entry.title,
        catalogue: cat.name,
        artifacts,
      });
    }
  }

  const result: GitHubTrace = {
    project: name,
    repoUrl,
    entries: entryTraces,
    artifactCount: { issues: issues.length, prs: prs.length, commits: commits.length },
    correlationCount,
    cachedAt: new Date().toISOString(),
    error: ghError,
  };

  writeCache(name, result);
  return c.json(result);
});

// Need to import EntryTrace, GitHubTrace and GitHubArtifact for type annotations above
import type { EntryTrace, GitHubTrace, GitHubArtifact } from "../../shared/types";

export default api;
