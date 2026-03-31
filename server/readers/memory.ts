import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseMemoryFile } from "../../shared/parser";
import type { MemoryEntry } from "../../shared/types";

/**
 * Read all memory entries from a directory of .md files.
 * Skips MEMORY.md (the index file).
 */
export async function readMemoryDir(
  dirPath: string
): Promise<MemoryEntry[]> {
  const entries: MemoryEntry[] = [];

  let files: string[];
  try {
    files = await readdir(dirPath);
  } catch {
    return [];
  }

  for (const file of files) {
    if (!file.endsWith(".md") || file === "MEMORY.md") continue;

    const filePath = join(dirPath, file);
    try {
      const content = await readFile(filePath, "utf-8");
      const entry = parseMemoryFile(content, filePath);
      if (entry) entries.push(entry);
    } catch {
      // Skip unreadable files
    }
  }

  return entries;
}

/**
 * Read global memory from ~/.claude/memory/
 */
export async function readGlobalMemory(): Promise<MemoryEntry[]> {
  const globalDir = join(
    process.env.HOME ?? "/Users/mrityunjaybhardwaj",
    ".claude",
    "memory"
  );
  return readMemoryDir(globalDir);
}

/**
 * Read project-specific memory.
 * Projects store memory at ~/.claude/projects/{encoded-path}/memory/
 */
export async function readProjectMemory(
  encodedProjectName: string
): Promise<MemoryEntry[]> {
  const memoryDir = join(
    process.env.HOME ?? "/Users/mrityunjaybhardwaj",
    ".claude",
    "projects",
    encodedProjectName,
    "memory"
  );
  return readMemoryDir(memoryDir);
}
