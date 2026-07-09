import { join } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { readCatalogues, GROUNDING_CATALOGUES } from "./catalogue";
import { resolveDir } from "../../shared/anvi-paths";
import type { GroundingStatus, GroundTruthDoc } from "../../shared/types";

// file:line citations — allow paths, dotted names, and any-case filenames
// (e.g. src/core/OpfsStorage.ts:52, vite.config.ts:18, GLTFLoader.js:5).
const CODE_CITATION_RE = /[\w./-]+\.[a-z]{1,5}:\d+/gi;
const STAGE_RE = /^##\s+(?:STAGE|Stage)\s/gm;

/**
 * Read grounding status for a project.
 * Scans artifacts/ref/ for Ground Truth docs and sources.
 */
export async function readGroundingStatus(
  projectPath: string
): Promise<GroundingStatus> {
  const catalogues = await readCatalogues(projectPath);

  let totalEntries = 0;
  let groundedEntries = 0;
  for (const cat of catalogues) {
    if (!GROUNDING_CATALOGUES.includes(cat.name)) continue; // dharana excluded — matches anvi's grounding metric
    for (const entry of cat.entries) {
      totalEntries++;
      if (entry.grounded) groundedEntries++;
    }
  }

  const groundTruthDocs = await scanGroundTruthDocs(projectPath);
  const sourceDirectories = await scanSourceDirs(projectPath);

  return {
    totalEntries,
    groundedEntries,
    ungroundedEntries: totalEntries - groundedEntries,
    groundTruthDocs,
    sourceDirectories,
  };
}

async function scanGroundTruthDocs(projectPath: string): Promise<GroundTruthDoc[]> {
  const refDir = resolveDir(projectPath, "ref");
  if (!refDir) return [];
  let files: string[];
  try {
    files = await readdir(refDir);
  } catch {
    return [];
  }

  const docs: GroundTruthDoc[] = [];
  for (const f of files) {
    if (!f.startsWith("GROUND_TRUTH_") || !f.endsWith(".md")) continue;

    const filePath = join(refDir, f);
    try {
      const content = await readFile(filePath, "utf-8");
      const fileStat = await stat(filePath);
      const lines = content.split("\n").length;
      const codeCitations = (content.match(CODE_CITATION_RE) || []).length;
      const stages = (content.match(STAGE_RE) || []).length;
      const system = f.replace("GROUND_TRUTH_", "").replace(".md", "");

      docs.push({
        system,
        path: filePath,
        lines,
        codeCitations,
        stages,
        lastModified: fileStat.mtime,
      });
    } catch {
      // skip unreadable
    }
  }

  return docs;
}

async function scanSourceDirs(projectPath: string): Promise<string[]> {
  const refDir = resolveDir(projectPath, "ref");
  if (!refDir) return [];
  const sourcesDir = join(refDir, "sources");
  try {
    const entries = await readdir(sourcesDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
