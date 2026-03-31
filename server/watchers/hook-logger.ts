import { watch, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

const TMP_DIR = "/tmp";
const HOOK_PREFIX = "anvi-hook-";
const ROUTE_PREFIX = "anvi-route-";

interface FileState {
  lastSize: number;
  buffer: string;
  cleanup: (() => void) | null;
}

type LogEntry = Record<string, unknown>;
type EntryCallback = (type: "hook" | "route", entry: LogEntry) => void;

const watchedFiles = new Map<string, FileState>();

/**
 * Read new bytes from a file since lastSize, parse JSON lines,
 * call the callback for each parsed entry.
 */
function tailFile(
  filePath: string,
  state: FileState,
  type: "hook" | "route",
  onEntry: EntryCallback
): void {
  try {
    const stat = statSync(filePath);
    const currentSize = stat.size;

    // File was truncated/rotated — reset
    if (currentSize < state.lastSize) {
      state.lastSize = 0;
      state.buffer = "";
    }

    if (currentSize === state.lastSize) return;

    // Read only the new bytes using low-level fd operations
    const bytesToRead = currentSize - state.lastSize;
    const buf = Buffer.alloc(bytesToRead);
    const fd = openSync(filePath, "r");
    try {
      readSync(fd, buf, 0, bytesToRead, state.lastSize);
    } finally {
      closeSync(fd);
    }

    const text = state.buffer + buf.toString("utf8");
    const lines = text.split("\n");

    // Last element is either empty (complete line ending with \n) or partial
    state.buffer = lines.pop() ?? "";
    state.lastSize = currentSize;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        onEntry(type, entry);
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File may have been deleted between events
  }
}

/**
 * Start watching a specific log file.
 */
function watchLogFile(
  filePath: string,
  type: "hook" | "route",
  onEntry: EntryCallback
): void {
  if (watchedFiles.has(filePath)) return;

  const state: FileState = {
    lastSize: 0,
    buffer: "",
    cleanup: null,
  };

  // Catch up on entries written before we started
  tailFile(filePath, state, type, onEntry);

  try {
    const watcher = watch(filePath, () => {
      tailFile(filePath, state, type, onEntry);
    });
    state.cleanup = () => watcher.close();
  } catch {
    state.cleanup = null;
  }

  watchedFiles.set(filePath, state);
}

/**
 * Determine if a filename is a hook or route log.
 */
function classifyFile(filename: string): { type: "hook" | "route" } | null {
  if (filename.startsWith(HOOK_PREFIX) && filename.endsWith(".log")) {
    return { type: "hook" };
  }
  if (filename.startsWith(ROUTE_PREFIX) && filename.endsWith(".log")) {
    return { type: "route" };
  }
  return null;
}

/**
 * Watch /tmp/ for anvi hook and route log files.
 * Calls onEntry for each new JSON log line parsed.
 * Returns a cleanup function.
 */
export function watchHookLogs(onEntry: EntryCallback): () => void {
  // Scan for existing files on startup
  try {
    const files = readdirSync(TMP_DIR);
    for (const f of files) {
      const cls = classifyFile(f);
      if (cls) {
        watchLogFile(join(TMP_DIR, f), cls.type, onEntry);
      }
    }
  } catch {
    // /tmp/ read failed — not fatal
  }

  // Watch /tmp/ directory for new matching files
  let dirWatcher: ReturnType<typeof watch> | null = null;
  try {
    dirWatcher = watch(TMP_DIR, (_eventType, filename) => {
      if (!filename) return;
      const cls = classifyFile(filename);
      if (cls) {
        watchLogFile(join(TMP_DIR, filename), cls.type, onEntry);
      }
    });
  } catch {
    // Directory watch failed — we still have existing file watchers
  }

  return () => {
    dirWatcher?.close();
    for (const [, state] of watchedFiles) {
      state.cleanup?.();
    }
    watchedFiles.clear();
  };
}
