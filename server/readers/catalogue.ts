import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseCatalogueEntries } from "../../shared/parser";
import { resolveDir } from "../../shared/anvi-paths";
import type { Catalogue, BoundaryInfo, CatalogueEntry, ReadReport } from "../../shared/types";
import { errText, isAbsent, report } from "./read-status";

const CATALOGUE_NAMES = ["hetvabhasa", "vyapti", "krama", "dharana"];

/**
 * The knowledge catalogues that count toward grounding. Matches anvi's
 * session-start hook and anvi-tools, which measure grounding over these three
 * only — dharana is the meta/focus catalogue and is excluded from the denominator.
 */
export const GROUNDING_CATALOGUES = ["hetvabhasa", "vyapti", "krama"];

/**
 * Find the .anvi/ directory for a project.
 * Resolves through the shared resolver, which also checks the centralized
 * `~/.anvideck/projects/{name}/.anvi` location (where anvi now keeps catalogues).
 */
export function findAnviDir(projectPath: string): string | null {
  return resolveDir(projectPath, ".anvi");
}

/**
 * Read all catalogues from a project's .anvi/ directory.
 */
export async function readCatalogues(
  projectPath: string
): Promise<Catalogue[]> {
  return (await readCataloguesReport(projectPath)).catalogues;
}

/**
 * Catalogues plus a report that separates "no .anvi / no catalogue files"
 * (status none) from "a catalogue file exists but could not be read"
 * (unreadable / partial, with the failing path in errors).
 */
export async function readCataloguesReport(
  projectPath: string
): Promise<{ catalogues: Catalogue[]; report: ReadReport }> {
  const anviDir = findAnviDir(projectPath);
  if (!anviDir) return { catalogues: [], report: report(0, []) };

  const catalogues: Catalogue[] = [];
  const errors: string[] = [];

  for (const name of CATALOGUE_NAMES) {
    const filePath = join(anviDir, `${name}.md`);
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch (e) {
      if (!isAbsent(e)) errors.push(errText(filePath, e));
      continue; // absent: this catalogue simply doesn't exist
    }
    try {
      catalogues.push({
        name,
        path: filePath,
        entries: await parsedEntries(filePath, name, fileStat.mtimeMs, fileStat.size),
        lastModified: fileStat.mtime,
      });
    } catch (e) {
      errors.push(errText(filePath, e));
    }
  }

  return { catalogues, report: report(catalogues.length, errors, anviDir) };
}

/**
 * Parsed entries per catalogue file, keyed by mtime + size: a request that
 * finds the file unchanged reuses the last parse instead of re-reading it.
 * Entries are shared between requests, so callers must not mutate them.
 */
const parseCache = new Map<string, { mtimeMs: number; size: number; entries: CatalogueEntry[] }>();

async function parsedEntries(
  filePath: string,
  name: string,
  mtimeMs: number,
  size: number
): Promise<CatalogueEntry[]> {
  const hit = parseCache.get(filePath);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.entries;
  const entries = parseCatalogueEntries(await readFile(filePath, "utf-8"), name);
  parseCache.set(filePath, { mtimeMs, size, entries });
  return entries;
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
