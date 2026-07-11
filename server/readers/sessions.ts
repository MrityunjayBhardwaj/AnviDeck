import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import type { LiveSession } from "../../shared/types";

/**
 * Live Claude Code sessions.
 *
 * Claude Code writes one registry file per session at
 * `~/.claude/sessions/<pid>.json`, carrying { sessionId, cwd, name, status,
 * startedAt, statusUpdatedAt, version, pid, kind }. The transcript lives
 * alongside at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
 *
 * "Live" = running only: a registry file is kept only if its pid is still
 * alive. Stale files from crashed/closed sessions are dropped.
 */
const SESSIONS_DIR = join(homedir(), ".claude", "sessions");

/** True if a process with this pid currently exists (any owner). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (dead); EPERM = exists but not ours (alive).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Current git branch at cwd, or null if not a repo / unreadable. */
function gitBranch(cwd: string): string | null {
  if (!cwd) return null;
  try {
    const out = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

export function readLiveSessions(): LiveSession[] {
  let files: string[];
  try {
    files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const sessions: LiveSession[] = [];
  for (const file of files) {
    let raw: any;
    try {
      raw = JSON.parse(readFileSync(join(SESSIONS_DIR, file), "utf8"));
    } catch {
      continue; // skip malformed registry file
    }
    if (typeof raw?.pid !== "number" || !pidAlive(raw.pid)) continue; // running only

    const cwd: string = typeof raw.cwd === "string" ? raw.cwd : "";
    sessions.push({
      sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "",
      pid: raw.pid,
      name: raw.name || (cwd ? basename(cwd) : "session"),
      project: cwd ? basename(cwd) : "unknown",
      cwd,
      status: typeof raw.status === "string" ? raw.status : "unknown",
      startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
      updatedAt:
        typeof raw.statusUpdatedAt === "number"
          ? raw.statusUpdatedAt
          : typeof raw.updatedAt === "number"
            ? raw.updatedAt
            : typeof raw.startedAt === "number"
              ? raw.startedAt
              : 0,
      version: typeof raw.version === "string" ? raw.version : "",
      kind: typeof raw.kind === "string" ? raw.kind : "",
      branch: gitBranch(cwd),
    });
  }

  // Busy sessions first, then most-recently-active.
  sessions.sort(
    (a, b) =>
      (a.status === "busy" ? 0 : 1) - (b.status === "busy" ? 0 : 1) ||
      b.updatedAt - a.updatedAt
  );
  return sessions;
}
