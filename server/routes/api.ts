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
import type { ProjectSummary, ProjectState } from "../../shared/types";

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

export default api;
