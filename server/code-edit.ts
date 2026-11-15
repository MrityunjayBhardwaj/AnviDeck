/**
 * Edit a file from the Code screen (#88): the one place AnviDeck writes a project file itself.
 *
 * It is reached only through POST /api/code/:project/edit, which the write guard admits only through
 * the desktop app's channel, never over HTTP (#241, #244), and which the action log records either way. It
 * writes a file only when every one of these holds, and refuses with the reason otherwise:
 *
 *   - the path is inside the project's own main checkout: repository-relative, no "..", no
 *     component that is a symlink, nothing under .git, an existing regular file, and not inside
 *     another checkout nested in the folder (an agent's worktree); never a catalogue (.anvi), a
 *     Ground Truth doc (ref/) or Claude Code's configuration (.claude/, .mcp.json): keptFromCode;
 *   - no running AnviDeck agent is touching it (server/code-touch.ts: it works in the folder that
 *     holds the file, or it edited the same file in any checkout, or its edits are not known),
 *     and no live terminal Claude Code session works in the folder that holds it, edited it from
 *     another folder (its transcripts' edit calls, #206), or names no folder (#222); when the agent
 *     host, the sessions or a session's edits cannot be read, nothing is written (could not look
 *     is not "nobody");
 *   - the file on disk is still the one the page showed: the sha256 the page sends must be the
 *     sha256 of the bytes there now, so an approval writes exactly over what was shown. It is
 *     checked twice: before anything is written, and again just before the new text replaces the
 *     file (#207);
 *   - the file and the new text are UTF-8 text (what the page showed is what is written back).
 *
 * The new text goes to a temporary file beside it (with the file's mode), which is then renamed
 * over the file, so a reader never sees half a write.
 */
import { chmodSync, closeSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync, constants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join, sep } from "node:path";
import { cleanRelPath, gitTop, projectTop, EDIT_RULE } from "./readers/code";
import { terminalTouching, touching, type AgentFact, type TerminalSession } from "./code-touch";
import type { SessionEdits } from "./readers/session-edits";
import { readLiveSessionsReport } from "./readers/sessions";
import type { EditResult, Touching, WorkingFile } from "../shared/code-types";
import type { ReadReport } from "../shared/types";

export const MAX_EDIT_BYTES = 2 * 1024 * 1024;

/** A refusal the route answers with this status; `touching` names the agents when one is the reason. */
export class CodeEditError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413 | 500 | 503, message: string, readonly detail: { touching?: Touching[]; reason?: string } = {}) {
    super(message);
  }
}

export interface EditDeps {
  /** The project's main checkout, as the design reader knows the project. */
  top?: (project: string) => { top: string } | { status: 404 | 409 | 503; reason: string };
  /** The agents and what they edited; throws, or returns { off }, when the host cannot be asked. */
  agents: () => AgentFact[] | { off: string };
  /** Live terminal Claude Code sessions (default: ~/.claude/sessions, read now). */
  sessions?: () => { sessions: TerminalSession[]; report: ReadReport };
  /** What a terminal session edited (default: its transcripts; server/readers/session-edits.ts). */
  sessionEdits?: (t: TerminalSession) => SessionEdits;
  keyOf?: (abs: string) => string | null;
  now?: () => Date;
  /** Tests only: runs after the new text is on disk beside the file, before the last check (#207). */
  beforeReplace?: (abs: string) => void;
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const realOr = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

function topOf(project: string, deps: EditDeps): string {
  const t = (deps.top ?? ((p: string) => projectTop(p)))(project);
  if ("status" in t) throw new CodeEditError(t.status === 503 ? 503 : t.status, t.reason);
  return realOr(t.top);
}

/**
 * Why Code never writes this repository-relative path, or null. Catalogues and Ground Truth docs
 * are changed only by agents (CLAUDE.md), never by AnviDeck directly; Claude Code's own settings,
 * hooks, commands and MCP servers decide what every agent may do, so a write there would change
 * the rules agents run under. Compared in lower case: macOS opens `.Claude` as `.claude`.
 */
export function keptFromCode(rel: string): string | null {
  const parts = rel.toLowerCase().split("/");
  if (parts.includes(".anvi")) return "is a catalogue (.anvi): catalogues are changed only by agents, never by Code";
  if (parts[0] === "ref" || (parts[0] === "artifacts" && parts[1] === "ref"))
    return "is in the Ground Truth folder (ref/): Ground Truth docs are changed only by agents, never by Code";
  if (parts.includes(".claude")) return "is Claude Code's own configuration (.claude/: settings, hooks, commands, worktrees): Code never writes there";
  if (parts[parts.length - 1] === ".mcp.json") return "is Claude Code's MCP server list (.mcp.json): Code never writes there";
  return null;
}

/**
 * The absolute path of a repository-relative path inside `top`, or a refusal. Every component
 * from the top down is checked with lstat, so a symlinked folder cannot lead the write elsewhere.
 */
export function resolveTarget(top: string, relPath: unknown): string {
  const rel = cleanRelPath(relPath);
  if (!rel) throw new CodeEditError(400, "path must be a repository-relative file path (no leading /, no .., no empty part)");
  const parts = rel.split("/");
  if (parts.some((p) => p.toLowerCase() === ".git")) throw new CodeEditError(400, `${rel} is under .git: Code never writes there`);
  const kept = keptFromCode(rel);
  if (kept) throw new CodeEditError(400, `${rel} ${kept}`);
  let p = top;
  for (let i = 0; i < parts.length; i++) {
    p = join(p, parts[i]);
    let st;
    try {
      st = lstatSync(p);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") throw new CodeEditError(404, `${rel} does not exist in ${top} (Code edits existing files only)`);
      throw new CodeEditError(500, `${p} could not be read: ${code ?? (e as Error).message}`);
    }
    if (st.isSymbolicLink()) throw new CodeEditError(400, `${parts.slice(0, i + 1).join("/")} is a symlink: Code never writes through one`);
    if (i < parts.length - 1 && !st.isDirectory()) throw new CodeEditError(404, `${parts.slice(0, i + 1).join("/")} is not a folder`);
    if (i === parts.length - 1 && !st.isFile()) throw new CodeEditError(400, `${rel} is not a regular file`);
  }
  const real = realOr(p);
  if (!real.startsWith(top + sep)) throw new CodeEditError(400, `${rel} resolves outside ${top}`);
  const owner = gitTop(dirname(real));
  if (owner !== top) throw new CodeEditError(409, `${rel} is inside another checkout (${owner ?? "not a git checkout"}), not ${top}`);
  return real;
}

function textOf(buf: Buffer, what: string): string {
  try {
    if (buf.includes(0)) throw new Error("NUL");
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new CodeEditError(409, `${what} is not UTF-8 text: Code edits text files only`);
  }
}

/**
 * Everyone keeping the file read-only now: AnviDeck's running agents, then terminal sessions. An
 * agent's own live session is the agent, so it is named once, as the agent (#252).
 */
function whoTouches(abs: string, deps: EditDeps): Touching[] {
  const facts = agentsNow(deps);
  const agents = touching(abs, facts, deps.keyOf);
  const named = new Set(agents.map((t) => t.id));
  const listedAgents = new Map(facts.filter((f) => f.sessionId && named.has(f.id)).map((f) => [f.sessionId!, f.id]));
  let read: { sessions: TerminalSession[]; report: ReadReport };
  try {
    read = (deps.sessions ?? readLiveSessionsReport)();
  } catch (e) {
    read = { sessions: [], report: { status: "unreadable", errors: [(e as Error).message] } };
  }
  return [...agents, ...terminalTouching(abs, read, listedAgents, { editsOf: deps.sessionEdits, keyOf: deps.keyOf })];
}

function agentsNow(deps: EditDeps): AgentFact[] {
  let a: AgentFact[] | { off: string };
  try {
    a = deps.agents();
  } catch (e) {
    a = { off: (e as Error).message };
  }
  if (!Array.isArray(a))
    throw new CodeEditError(503, `whether an agent is working on this file could not be checked (${a.off}), so nothing is written`);
  return a;
}

function readBytes(abs: string): Buffer {
  try {
    return readFileSync(abs);
  } catch (e) {
    throw new CodeEditError(500, `${abs} could not be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
}

/** The working copy an edit would replace, with its hash and whether it may be written now. */
export function readWorking(project: string, relPath: unknown, deps: EditDeps): WorkingFile {
  const top = topOf(project, deps);
  const abs = resolveTarget(top, relPath);
  const buf = readBytes(abs);
  if (buf.length > MAX_EDIT_BYTES) throw new CodeEditError(413, `${relPath} is ${buf.length} bytes; Code edits files up to ${MAX_EDIT_BYTES} bytes`);
  const text = textOf(buf, String(relPath));
  let who: Touching[];
  let reason: string | undefined;
  try {
    who = whoTouches(abs, deps);
    if (who.length) reason = who.map((t) => t.detail).join("; ");
  } catch (e) {
    if (!(e instanceof CodeEditError)) throw e;
    who = [];
    reason = e.message;
  }
  return {
    project,
    path: String(relPath),
    abs,
    text,
    hash: sha256(buf),
    bytes: buf.length,
    touching: who,
    editable: !reason,
    ...(reason ? { reason } : {}),
    rule: EDIT_RULE,
    readAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
}

/** Write `content` over the file, or refuse. Body: { path, baseHash, content }. */
export function applyEdit(project: string, body: Record<string, unknown>, deps: EditDeps): EditResult {
  const { path, baseHash, content } = body;
  if (typeof baseHash !== "string" || !/^[0-9a-f]{64}$/.test(baseHash))
    throw new CodeEditError(400, "baseHash must be the sha256 (hex) of the file as the page showed it");
  if (typeof content !== "string") throw new CodeEditError(400, "content must be text");
  const next = Buffer.from(content, "utf8");
  if (next.length > MAX_EDIT_BYTES) throw new CodeEditError(413, `the new text is ${next.length} bytes; Code writes files up to ${MAX_EDIT_BYTES} bytes`);
  if (content.includes("\0")) throw new CodeEditError(400, "the new text holds a NUL character: Code writes text files only");

  const top = topOf(project, deps);
  const abs = resolveTarget(top, path);
  // An agent first: its edit may be the very change that made the hash differ.
  const who = whoTouches(abs, deps);
  if (who.length) throw new CodeEditError(409, `not written: ${who.map((t) => t.detail).join("; ")}`, { touching: who });

  const cur = readBytes(abs);
  textOf(cur, String(path));
  const before = sha256(cur);
  if (before !== baseHash)
    throw new CodeEditError(409, `not written: ${path} changed since you opened it (sha256 ${before.slice(0, 12)} on disk, ${baseHash.slice(0, 12)} shown). Open it again to see the change`);
  if (cur.equals(next)) throw new CodeEditError(400, "not written: the text is the same as the file");

  const mode = lstatSync(abs).mode & 0o7777;
  const tmp = join(dirname(abs), `.${basename(abs)}.anvideck-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
      let off = 0;
      while (off < next.length) off += writeSync(fd, next, off, next.length - off);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, mode);
    deps.beforeReplace?.(abs);
    // Checked again with the new text ready, just before it replaces the file (#207): a change
    // made since the first check, while the text was written, is kept and the edit refused. What
    // is left open is the gap between this read and the rename, two system calls.
    const now = sha256(readFileSync(abs));
    if (now !== baseHash) {
      rmSync(tmp, { force: true });
      throw new CodeEditError(409, `not written: ${path} changed while your edit was being written (the check just before replacing it found sha256 ${now.slice(0, 12)}, not the ${baseHash.slice(0, 12)} you opened). The other change is kept; open the file again to see it`);
    }
    renameSync(tmp, abs);
  } catch (e) {
    rmSync(tmp, { force: true });
    if (e instanceof CodeEditError) throw e;
    throw new CodeEditError(500, `not written: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  return { project, path: String(path), abs, before, after: sha256(next), bytes: next.length, writtenAt: (deps.now ?? (() => new Date()))().toISOString() };
}
