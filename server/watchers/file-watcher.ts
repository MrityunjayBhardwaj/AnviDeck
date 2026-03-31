import { watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { WatchEvent } from "../../shared/types";

type WatchCallback = (event: WatchEvent) => void;

/**
 * Watch a directory for changes, emitting events on file modifications.
 * Returns a cleanup function to stop watching.
 */
export function watchDirectory(
  dirPath: string,
  callback: WatchCallback
): (() => void) | null {
  try {
    const watcher = watch(
      dirPath,
      { recursive: true },
      (eventType, filename) => {
        if (!filename) return;
        callback({
          type: eventType as WatchEvent["type"],
          path: join(dirPath, filename),
          timestamp: new Date(),
        });
      }
    );

    return () => watcher.close();
  } catch {
    return null;
  }
}

/**
 * Watch all relevant directories for a project.
 * Returns cleanup function.
 */
export function watchProject(
  projectPath: string,
  anviDir: string | null,
  memoryDir: string | null,
  callback: WatchCallback
): () => void {
  const cleanups: (() => void)[] = [];

  if (anviDir) {
    const cleanup = watchDirectory(anviDir, callback);
    if (cleanup) cleanups.push(cleanup);
  }

  if (memoryDir) {
    const cleanup = watchDirectory(memoryDir, callback);
    if (cleanup) cleanups.push(cleanup);
  }

  return () => cleanups.forEach((fn) => fn());
}

/**
 * Watch the global ~/.claude/ directories.
 */
export function watchGlobal(callback: WatchCallback): () => void {
  const home = process.env.HOME ?? "/Users/mrityunjaybhardwaj";
  const cleanups: (() => void)[] = [];

  // Watch global memory
  const memCleanup = watchDirectory(
    join(home, ".claude", "memory"),
    callback
  );
  if (memCleanup) cleanups.push(memCleanup);

  return () => cleanups.forEach((fn) => fn());
}
