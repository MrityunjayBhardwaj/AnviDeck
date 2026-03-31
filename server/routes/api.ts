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
