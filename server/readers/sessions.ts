import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import type { LiveSession, ReadReport } from "../../shared/types";
import { errText, isAbsent, report } from "./read-status";

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
  return readLiveSessionsReport().sessions;
}

/**
 * Live sessions plus a report. No registry directory, or no running session,
 * is "none". A registry directory or file that can't be read or parsed is
 * listed in errors (status unreadable/partial) instead of being skipped
 * silently.
 */
export function readLiveSessionsReport(): { sessions: LiveSession[]; report: ReadReport } {
  const errors: string[] = [];
  let files: string[];
  try {
    files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  } catch (e) {
    return { sessions: [], report: report(0, isAbsent(e) ? [] : [errText(SESSIONS_DIR, e)], SESSIONS_DIR) };
  }

  const sessions: LiveSession[] = [];
  let filesRead = 0;
  for (const file of files) {
    let raw: any;
    try {
      raw = JSON.parse(readFileSync(join(SESSIONS_DIR, file), "utf8"));
    } catch (e) {
      // A file removed between readdir and read is a session that just ended.
      if (!isAbsent(e)) errors.push(errText(join(SESSIONS_DIR, file), e));
      continue;
    }
    filesRead++;
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
      ...(typeof raw.waitingFor === "string" && raw.waitingFor ? { waitingFor: raw.waitingFor } : {}),
    });
  }

  // Busy sessions first, then most-recently-active.
  sessions.sort(
    (a, b) =>
      (a.status === "busy" ? 0 : 1) - (b.status === "busy" ? 0 : 1) ||
      b.updatedAt - a.updatedAt
  );
  // "partial" vs "unreadable" is decided by registry files read, not by how
  // many of them are still alive: dead sessions were read fine.
  const r = report(filesRead, errors, SESSIONS_DIR);
  return { sessions, report: filesRead > 0 && !sessions.length && !errors.length ? { ...r, status: "none" } : r };
}
