import { Hono } from "hono";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  readCatalogues,
  extractBoundaries,
  countSignals,
  findAnviDir,
} from "../readers/catalogue";
import { readProjectMemory, readGlobalMemory } from "../readers/memory";
import {
  getTimeline,
  showAtCommit,
  diffCommits,
} from "../readers/git-history";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import type { ProjectSummary, ProjectState, HookLogEntry } from "../../shared/types";

const api = new Hono();

const CLAUDE_DIR = join(
  process.env.HOME ?? "/Users/mrityunjaybhardwaj",
  ".claude"
);
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");

/**
 * Decode a Claude projects directory name to an absolute path.
 * "-Users-mrityunjaybhardwaj-Documents-projects-sonicPiWeb"
 * → "/Users/mrityunjaybhardwaj/Documents/projects/sonicPiWeb"
 */
function decodeProjectPath(dirName: string): string {
  return dirName.replace(/^-/, "/").replace(/-/g, "/");
}

/**
 * Extract a short project name from the decoded path.
 */
function projectName(decodedPath: string): string {
  return decodedPath.split("/").pop() ?? decodedPath;
}

/**
 * Discover all projects from ~/.claude/projects/
 */
async function discoverProjects(): Promise<
  { encoded: string; decoded: string; name: string }[]
> {
  let dirs: string[];
  try {
    dirs = await readdir(PROJECTS_DIR);
  } catch {
    return [];
  }

  return dirs
    .filter((d) => d.startsWith("-"))
    .map((encoded) => {
      const decoded = decodeProjectPath(encoded);
      return { encoded, decoded, name: projectName(decoded) };
    });
}

// GET /api/projects — all projects with catalogue counts
api.get("/projects", async (c) => {
  const projects = await discoverProjects();
  const summaries: ProjectSummary[] = [];

  for (const proj of projects) {
    const catalogues = await readCatalogues(proj.decoded);
    const memory = await readProjectMemory(proj.encoded);
    const signals = countSignals(catalogues);

    const catalogueCounts: Record<string, number> = {};
    for (const cat of catalogues) {
      catalogueCounts[cat.name] = cat.entries.length;
    }

    summaries.push({
      name: proj.name,
      path: proj.decoded,
      catalogueCounts,
      memoryCount: memory.length,
      ...signals,
    });
  }

  return c.json(summaries);
});

// GET /api/project/:name — full project state
api.get("/project/:name", async (c) => {
  const name = c.req.param("name");
  const projects = await discoverProjects();
  const proj = projects.find((p) => p.name === name);

  if (!proj) return c.json({ error: "Project not found" }, 404);

  const catalogues = await readCatalogues(proj.decoded);
  const memory = await readProjectMemory(proj.encoded);
  const signals = countSignals(catalogues);
  const boundaries = extractBoundaries(catalogues);

  const state: ProjectState = {
    name: proj.name,
    path: proj.decoded,
    catalogues,
    memory,
    boundaries,
    ...signals,
  };

  return c.json(state);
});

// GET /api/project/:name/catalogues — just catalogues
api.get("/project/:name/catalogues", async (c) => {
  const name = c.req.param("name");
  const projects = await discoverProjects();
  const proj = projects.find((p) => p.name === name);

  if (!proj) return c.json({ error: "Project not found" }, 404);

  const catalogues = await readCatalogues(proj.decoded);
  return c.json(catalogues);
});

// GET /api/project/:name/memory — project memory
api.get("/project/:name/memory", async (c) => {
  const name = c.req.param("name");
  const projects = await discoverProjects();
  const proj = projects.find((p) => p.name === name);

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

// GET /api/routing-architecture — three-tier context architecture with file sizes
api.get("/routing-architecture", async (c) => {
  const home = process.env.HOME ?? "/Users/mrityunjaybhardwaj";
  const anviDir = join(home, ".claude", "anvi", "cognitive-os");
  const claudeMdPath = join(home, ".claude", "CLAUDE.md");

  function fileInfo(filePath: string, displayName?: string) {
    try {
      const stat = statSync(filePath);
      const sizeBytes = stat.size;
      const estimatedTokens = Math.round(sizeBytes / 4);
      return {
        path: filePath,
        name: displayName ?? filePath.split("/").pop() ?? filePath,
        sizeBytes,
        estimatedTokens,
      };
    } catch {
      return {
        path: filePath,
        name: displayName ?? filePath.split("/").pop() ?? filePath,
        sizeBytes: 0,
        estimatedTokens: 0,
      };
    }
  }

  // Tier 1: Always loaded
  const tier1Files = [
    fileInfo(claudeMdPath, "CLAUDE.md (global)"),
    fileInfo(join(anviDir, "base-layer.md"), "base-layer.md"),
  ];

  // Tier 2: Hook injection (dynamic, no static files)
  const tier2Files = [
    {
      path: join(home, ".claude", "hooks", "catalogue-context-injector.js"),
      name: "catalogue-context-injector.js (dynamic injection)",
      sizeBytes: 0,
      estimatedTokens: 500, // average injection size
    },
  ];

  // Tier 3: Per-activity routing
  const routingTable = [
    {
      activity: "Debugging",
      files: ["adaptive-observation.md", "diagnose.md"],
      catalogues: ["hetvabhasa.md"],
    },
    {
      activity: "Planning",
      files: ["dharana-spec.md", "design.md"],
      catalogues: ["dharana.md"],
    },
    {
      activity: "Implementing",
      files: ["dhyana-spec.md"],
      catalogues: ["dharana.md", "vyapti.md", "krama.md"],
    },
    {
      activity: "Verifying",
      files: ["adaptive-observation.md", "review.md"],
      catalogues: ["dharana.md"],
    },
    {
      activity: "Resuming",
      files: ["dhyana-spec.md", "dharana-spec.md"],
      catalogues: ["dharana.md"],
    },
  ];

  // Build tier 3 file list (unique)
  const tier3FileNames = new Set<string>();
  for (const route of routingTable) {
    for (const f of route.files) tier3FileNames.add(f);
  }

  const tier3Files = [...tier3FileNames].map((f) => {
    // Try modes/ subdirectory first, then root
    const modesPath = join(anviDir, "modes", f);
    const rootPath = join(anviDir, f);
    try {
      statSync(modesPath);
      return fileInfo(modesPath, f);
    } catch {
      return fileInfo(rootPath, f);
    }
  });

  const tier1Total = tier1Files.reduce((s, f) => s + f.estimatedTokens, 0);
  const tier2Total = tier2Files.reduce((s, f) => s + f.estimatedTokens, 0);
  const tier3Total = tier3Files.reduce((s, f) => s + f.estimatedTokens, 0);

  // Build routing table with token costs
  const routingTableWithCosts = routingTable.map((route) => {
    const files = route.files.map((f) => {
      const modesPath = join(anviDir, "modes", f);
      const rootPath = join(anviDir, f);
      try {
        statSync(modesPath);
        return fileInfo(modesPath, f);
      } catch {
        return fileInfo(rootPath, f);
      }
    });
    const totalTokens =
      tier1Total + files.reduce((s, f) => s + f.estimatedTokens, 0);
    return {
      activity: route.activity,
      files: route.files,
      catalogues: route.catalogues,
      totalTokens,
      fileDetails: files,
    };
  });

  return c.json({
    tiers: [
      {
        tier: 1,
        name: "Always Loaded",
        description: "Loaded every prompt. Global instructions + base cognitive checks.",
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
    totalCapacity: 200_000,
  });
});

// GET /api/cross-project — cross-project pattern analysis
api.get("/cross-project", async (c) => {
  const projects = await discoverProjects();
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
    const catalogues = await readCatalogues(proj.decoded);
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

// GET /api/project/:name/entry-dates — creation dates for catalogue entries
api.get("/project/:name/entry-dates", async (c) => {
  const name = c.req.param("name");
  const projects = await discoverProjects();
  const proj = projects.find((p) => p.name === name);
  if (!proj) return c.json({ error: "Project not found" }, 404);

  const dates: Record<string, { created: string; lastModified: string }> = {};

  // Find .anvi directory
  const { findAnviDir: findDir } = await import("../readers/catalogue");
  const anviDir = findDir(proj.decoded);
  if (!anviDir) return c.json(dates);

  // Get file-level dates from git, then parse entry IDs per file
  const anviFiles = ["hetvabhasa.md", "vyapti.md", "krama.md", "dharana.md"];

  for (const file of anviFiles) {
    const filePath = join(anviDir, file);
    try {
      statSync(filePath);
    } catch {
      continue;
    }

    // Get file modification date from filesystem as fallback
    let fileCreated: string;
    let fileModified: string;
    try {
      const stat = statSync(filePath);
      fileCreated = stat.birthtime.toISOString();
      fileModified = stat.mtime.toISOString();
    } catch {
      continue;
    }

    // Try git for more accurate dates
    try {
      const gitCreated = execSync(
        `git log --diff-filter=A --format="%aI" -- "${filePath}" | tail -1`,
        { cwd: proj.decoded, encoding: "utf8", timeout: 5000 }
      ).trim();
      if (gitCreated) fileCreated = gitCreated;

      const gitModified = execSync(
        `git log -1 --format="%aI" -- "${filePath}"`,
        { cwd: proj.decoded, encoding: "utf8", timeout: 5000 }
      ).trim();
      if (gitModified) fileModified = gitModified;
    } catch {
      // git failed — use filesystem dates
    }

    // Parse entry IDs from the file
    try {
      const content = readFileSync(filePath, "utf8");
      const entryPattern = /^##\s+(SP\d+|SV\d+|SK\d+|SD\d+|B\d+|H\d+|V\d+|K\d+|D\d+)[:\s]/gm;
      let match;
      while ((match = entryPattern.exec(content)) !== null) {
        dates[match[1]] = { created: fileCreated, lastModified: fileModified };
      }
    } catch {
      // parse failed
    }
  }

  return c.json(dates);
});

export default api;
