import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseMemoryFile } from "../../shared/parser";
import type { MemoryEntry, ReadReport } from "../../shared/types";
import { errText, isAbsent, report } from "./read-status";

/**
 * Read all memory entries from a directory of .md files.
 * Skips MEMORY.md (the index file).
 */
export async function readMemoryDir(
  dirPath: string
): Promise<MemoryEntry[]> {
  return (await readMemoryDirReport(dirPath)).entries;
}

/**
 * Memory entries plus a report: an absent directory is "none"; a directory or
 * file that exists but can't be read is "unreadable"/"partial" with the path.
 * Files without frontmatter are not memory entries and are not errors.
 */
export async function readMemoryDirReport(
  dirPath: string
): Promise<{ entries: MemoryEntry[]; report: ReadReport }> {
  const entries: MemoryEntry[] = [];
  const errors: string[] = [];

  let files: string[];
  try {
    files = await readdir(dirPath);
  } catch (e) {
    return { entries, report: report(0, isAbsent(e) ? [] : [errText(dirPath, e)], dirPath) };
  }

  for (const file of files) {
    if (!file.endsWith(".md") || file === "MEMORY.md") continue;

    const filePath = join(dirPath, file);
    try {
      const st = await stat(filePath);
      const hit = memoCache.get(filePath);
      let entry: MemoryEntry | null;
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        entry = hit.entry;
      } else {
        entry = parseMemoryFile(await readFile(filePath, "utf-8"), filePath);
        memoCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, entry });
      }
      if (entry) entries.push(entry);
    } catch (e) {
      errors.push(errText(filePath, e));
    }
  }

  return { entries, report: report(entries.length, errors, dirPath) };
}

/** Parsed memory file keyed by mtime + size (unchanged file → no re-read). */
const memoCache = new Map<string, { mtimeMs: number; size: number; entry: MemoryEntry | null }>();

const HOME = process.env.HOME ?? "/Users/mrityunjaybhardwaj";

/** ~/.claude/memory/ */
export const GLOBAL_MEMORY_DIR = join(HOME, ".claude", "memory");

/** ~/.claude/projects/{encoded-path}/memory/ */
export function projectMemoryDir(encodedProjectName: string): string {
  return join(HOME, ".claude", "projects", encodedProjectName, "memory");
}

/** Read global memory from ~/.claude/memory/ */
export async function readGlobalMemory(): Promise<MemoryEntry[]> {
  return readMemoryDir(GLOBAL_MEMORY_DIR);
}

/** Read project-specific memory from ~/.claude/projects/{encoded-path}/memory/ */
export async function readProjectMemory(
  encodedProjectName: string
): Promise<MemoryEntry[]> {
  return readMemoryDir(projectMemoryDir(encodedProjectName));
}
