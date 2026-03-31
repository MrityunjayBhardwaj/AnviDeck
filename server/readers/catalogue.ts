import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseCatalogueEntries } from "../../shared/parser";
import type { Catalogue, BoundaryInfo } from "../../shared/types";

const CATALOGUE_NAMES = ["hetvabhasa", "vyapti", "krama", "dharana"];

/**
 * Find the .anvi/ directory for a project.
 * Checks both `{projectPath}/.anvi` and `{projectPath}/artifacts/.anvi`.
 */
export function findAnviDir(projectPath: string): string | null {
  const candidates = [
    join(projectPath, ".anvi"),
    join(projectPath, "artifacts", ".anvi"),
  ];

  for (const candidate of candidates) {
    try {
      const s = Bun.file(candidate);
      // Bun.file doesn't check dirs — use sync stat
      const fs = require("node:fs");
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Read all catalogues from a project's .anvi/ directory.
 */
export async function readCatalogues(
  projectPath: string
): Promise<Catalogue[]> {
  const anviDir = findAnviDir(projectPath);
  if (!anviDir) return [];

  const catalogues: Catalogue[] = [];

  for (const name of CATALOGUE_NAMES) {
    const filePath = join(anviDir, `${name}.md`);
    try {
      const content = await readFile(filePath, "utf-8");
      const fileStat = await stat(filePath);
      const entries = parseCatalogueEntries(content);

      catalogues.push({
        name,
        path: filePath,
        entries,
        lastModified: fileStat.mtime,
      });
    } catch {
      // Catalogue file doesn't exist — skip
    }
  }

  return catalogues;
}

/**
 * Extract boundary info from dharana catalogue entries.
 */
export function extractBoundaries(
  catalogues: Catalogue[]
): BoundaryInfo[] {
  const dharana = catalogues.find((c) => c.name === "dharana");
  if (!dharana) return [];

  return dharana.entries
    .filter((e) => e.id.startsWith("B"))
    .map((e) => ({
      id: e.id,
      name: e.title,
      fatality: e.tags.includes("FATALITY"),
      patternCount: countPatterns(e.origin),
    }));
}

function countPatterns(origin?: string): number {
  if (!origin) return 0;
  // Count SP/SV/SK pattern references
  const refs = origin.match(/[A-Z]{2}\d+/g);
  return refs ? refs.length : 0;
}

/**
 * Count fatality signals, misaligned invariants, and blind spots from catalogues.
 */
export function countSignals(catalogues: Catalogue[]): {
  fatalitySignals: number;
  misalignedInvariants: number;
  blindSpots: number;
} {
  let fatalitySignals = 0;
  let misalignedInvariants = 0;
  let blindSpots = 0;

  for (const cat of catalogues) {
    for (const entry of cat.entries) {
      if (entry.tags.includes("FATALITY")) fatalitySignals++;
      if (entry.tags.includes("MISALIGNED")) misalignedInvariants++;
      if (entry.tags.includes("BLIND SPOT")) blindSpots++;
    }
  }

  return { fatalitySignals, misalignedInvariants, blindSpots };
}
