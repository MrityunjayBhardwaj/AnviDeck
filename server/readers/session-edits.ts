/**
 * What a terminal Claude Code session edited (#206): every Write, Edit, MultiEdit and NotebookEdit
 * call in its transcript and in its subagents' transcripts, by the absolute path it named.
 *
 * The transcript is `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl` (found in any folder there
 * when the cwd's own has none), and each subagent's is `<that folder>/<sessionId>/subagents/*.jsonl`.
 * A live session's transcript grows while it works and can run to tens of MB, so each file is read
 * from where the last read stopped (cached by path, size and inode); a file that shrank or was
 * replaced is read again from the start.
 *
 * What it does not see: a change made through Bash (sed, a script, git checkout) names no file the
 * way an edit call does.
 *
 * Read-only: it opens transcripts for reading and writes nothing.
 */
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { encodeCwd } from "./replay";
import { isAbsent } from "./read-status";

export const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export interface EditCall {
  abs: string;
  tool: string;
  at: string;
}

export interface SessionEdits {
  edits: EditCall[];
  /** The transcript files read (0: the session has written no transcript yet). */
  files: number;
  /** Set when some of it could not be read: then its edits are not known. */
  unreadable?: string;
}

/**
 * The edit calls in one Claude Code message ({ type: "assistant", message: { content } }), the shape
 * a transcript record and an Agent SDK message share.
 */
export function editCalls(m: unknown, at: string): EditCall[] {
  const msg = m as { type?: string; message?: { content?: unknown } } | null;
  if (!msg || msg.type !== "assistant" || !Array.isArray(msg.message?.content)) return [];
  const out: EditCall[] = [];
  for (const b of msg.message!.content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
    if (b?.type !== "tool_use" || !b.name || !EDIT_TOOLS.has(b.name)) continue;
    const p = b.input?.file_path ?? b.input?.notebook_path;
    if (typeof p === "string" && p.startsWith("/")) out.push({ abs: p, tool: b.name, at });
  }
  return out;
}

interface Cached {
  ino: number;
  /** Bytes read so far, up to the end of the last whole line. */
  offset: number;
  edits: EditCall[];
  bad: number;
}
const cache = new Map<string, Cached>();
const CHUNK = 1 << 20;

/** The edit calls of one transcript file, read on from where the last read stopped. */
function fileEdits(path: string): { edits: EditCall[]; bad: number } {
  const fd = openSync(path, "r");
  try {
    const st = fstatSync(fd);
    let c = cache.get(path);
    if (!c || c.ino !== st.ino || st.size < c.offset) c = { ino: st.ino, offset: 0, edits: [], bad: 0 };
    // Split on newline bytes, never inside a character: `offset` counts bytes.
    let carry = Buffer.alloc(0);
    const buf = Buffer.alloc(CHUNK);
    let pos = c.offset;
    while (pos < st.size) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, st.size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      const last = chunk.lastIndexOf(0x0a);
      if (last < 0) {
        carry = Buffer.from(chunk);
        continue;
      }
      for (const line of chunk.toString("utf8", 0, last).split("\n")) {
        // Only a line that can hold a tool call is parsed: the rest are most of a long transcript.
        if (!line.includes('"tool_use"')) continue;
        let rec: { timestamp?: unknown };
        try {
          rec = JSON.parse(line);
        } catch {
          c.bad++;
          continue;
        }
        c.edits.push(...editCalls(rec, typeof rec.timestamp === "string" ? rec.timestamp : ""));
      }
      carry = Buffer.from(chunk.subarray(last + 1));
      c.offset = pos - carry.length;
    }
    // `carry` is a line still being written: it is read once it ends.
    cache.set(path, c);
    return { edits: c.edits, bad: c.bad };
  } finally {
    closeSync(fd);
  }
}

function mainTranscript(projectsDir: string, sessionId: string, cwd: string): string | null {
  if (cwd) {
    const direct = join(projectsDir, encodeCwd(cwd), `${sessionId}.jsonl`);
    try {
      if (statSync(direct).isFile()) return direct;
    } catch {
      /* look in every folder */
    }
  }
  for (const d of readdirSync(projectsDir)) {
    const p = join(projectsDir, d, `${sessionId}.jsonl`);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* not in this folder */
    }
  }
  return null;
}

/** Everything the session and its subagents edited, or why that is not known. */
export function sessionEdits(sessionId: string, cwd: string, projectsDir = join(homedir(), ".claude", "projects")): SessionEdits {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(sessionId) || /^\.+$/.test(sessionId))
    return { edits: [], files: 0, unreadable: `its session id ${JSON.stringify(sessionId)} does not name a transcript` };
  let main: string | null;
  try {
    main = mainTranscript(projectsDir, sessionId, cwd);
  } catch (e) {
    return { edits: [], files: 0, unreadable: `its transcript could not be looked for in ${projectsDir}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` };
  }
  // No transcript anywhere: Claude Code writes one with the session's first message, so it has
  // made no edit call yet.
  if (!main) return { edits: [], files: 0 };
  const files = [main];
  const subDir = join(dirname(main), sessionId, "subagents");
  try {
    for (const f of readdirSync(subDir).sort()) if (f.endsWith(".jsonl")) files.push(join(subDir, f));
  } catch (e) {
    if (!isAbsent(e)) return { edits: [], files: 1, unreadable: `its subagents' transcripts in ${subDir} could not be listed: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` };
  }
  const edits: EditCall[] = [];
  const problems: string[] = [];
  for (const f of files) {
    try {
      const r = fileEdits(f);
      edits.push(...r.edits);
      if (r.bad) problems.push(`${r.bad} line(s) of ${f} could not be read`);
    } catch (e) {
      problems.push(`${f} could not be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
  }
  return { edits, files: files.length, ...(problems.length ? { unreadable: problems.join("; ") } : {}) };
}
