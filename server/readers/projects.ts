import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

/**
 * Project discovery: map each `~/.claude/projects/<encoded>` directory back to
 * the real project path.
 *
 * Claude Code names that directory by replacing EVERY non-alphanumeric
 * character of the session's cwd with `-` (observed: `/Users/x/.anvideck` →
 * `-Users-x--anvideck`, `foxilli_film_test` → `foxilli-film-test`). So the
 * encoding is lossy: a `-` may have been `/`, `-`, `_`, `.` or a space, and
 * "turn every `-` into `/`" sends `MoGraph-DSL` to `MoGraph/DSL`.
 *
 * Resolution order (first that answers wins):
 *   1. transcript — the `cwd` recorded inside the project's own `*.jsonl`
 *      transcripts, accepted only if it re-encodes to this directory name.
 *      Authoritative, and still right after the directory was deleted.
 *   2. filesystem — rebuild the path segment by segment from `/`, keeping only
 *      directory entries that re-encode to the next part of the name. Accepted
 *      only if exactly ONE existing path matches.
 *   3. unresolved — no transcript cwd and zero (or several) filesystem matches.
 *      The path is left null rather than guessed: a wrong path would silently
 *      read another project's notes.
 */

export type PathSource = "transcript" | "filesystem" | "unresolved";

export interface DiscoveredProject {
  /** Directory name under ~/.claude/projects/ */
  encoded: string;
  /** Real project path, or null when it cannot be determined. */
  decoded: string | null;
  /** basename(decoded), or the encoded name when unresolved. */
  name: string;
  pathSource: PathSource;
  /** Filesystem candidates when more than one path matched (ambiguous). */
  candidates?: string[];
}

export const PROJECTS_DIR = join(homedir(), ".claude", "projects");

/** Claude Code's directory-name encoding of a cwd. */
export function encodeProjectPath(p: string): string {
  return p.replace(/[^A-Za-z0-9]/g, "-");
}

const CWD_RE = /"cwd":"((?:[^"\\]|\\.)*)"/g;
const HEAD_BYTES = 256 * 1024;
const MAX_TRANSCRIPTS = 5;

function readHead(file: string): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** cwd from the project's transcripts that re-encodes to `encoded`, or null. */
export function cwdFromTranscripts(projectDir: string, encoded: string): string | null {
  let files: { f: string; m: number }[];
  try {
    files = readdirSync(projectDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        try {
          return { f, m: statSync(join(projectDir, f)).mtimeMs };
        } catch {
          return { f, m: 0 };
        }
      })
      .sort((a, b) => b.m - a.m)
      .slice(0, MAX_TRANSCRIPTS);
  } catch {
    return null;
  }
  for (const { f } of files) {
    let head: string;
    try {
      head = readHead(join(projectDir, f));
    } catch {
      continue;
    }
    for (const m of head.matchAll(CWD_RE)) {
      let cwd: string;
      try {
        cwd = JSON.parse(`"${m[1]}"`);
      } catch {
        continue;
      }
      if (encodeProjectPath(cwd) === encoded) return cwd;
    }
  }
  return null;
}

/**
 * All existing directories whose path re-encodes to `encoded`.
 * Stops after `limit` matches (2 is enough to know it is ambiguous).
 */
export function filesystemMatches(encoded: string, limit = 2): string[] {
  if (!encoded.startsWith("-")) return [];
  const out: string[] = [];
  const walk = (dir: string, rest: string) => {
    if (out.length >= limit) return;
    if (rest === "") {
      out.push(dir);
      return;
    }
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const enc = encodeProjectPath(name);
      let next: string | null = null;
      if (rest === enc) next = "";
      else if (rest.startsWith(enc + "-")) next = rest.slice(enc.length + 1);
      if (next === null) continue;
      const full = join(dir, name);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      walk(full, next);
      if (out.length >= limit) return;
    }
  };
  walk("/", encoded.slice(1));
  return out;
}

export function resolveEncodedProject(encoded: string, projectsDir = PROJECTS_DIR): DiscoveredProject {
  const fromTranscript = cwdFromTranscripts(join(projectsDir, encoded), encoded);
  if (fromTranscript) {
    return { encoded, decoded: fromTranscript, name: basename(fromTranscript), pathSource: "transcript" };
  }
  const matches = filesystemMatches(encoded);
  if (matches.length === 1) {
    return { encoded, decoded: matches[0]!, name: basename(matches[0]!), pathSource: "filesystem" };
  }
  return {
    encoded,
    decoded: null,
    name: encoded,
    pathSource: "unresolved",
    ...(matches.length > 1 ? { candidates: matches } : {}),
  };
}

export type DiscoveryResult =
  | { status: "ok"; projects: DiscoveredProject[] }
  | { status: "unreadable"; projects: []; error: string };

/** Discover every project under ~/.claude/projects/. */
export function discoverProjects(projectsDir = PROJECTS_DIR): DiscoveryResult {
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir);
  } catch (e) {
    return { status: "unreadable", projects: [], error: `${projectsDir}: ${(e as Error).message}` };
  }
  return {
    status: "ok",
    projects: dirs.filter((d) => d.startsWith("-")).map((d) => resolveEncodedProject(d, projectsDir)),
  };
}
