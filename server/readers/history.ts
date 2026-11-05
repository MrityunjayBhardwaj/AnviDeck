/**
 * History (#90): one project's timeline, put together from sources that already exist. Each
 * lane names its source; a lane that could not be read answers unreadable / partial /
 * not-available, never an empty lane (read-status.ts, AV1).
 *
 *   turns, edits  the project's session transcripts, as the replay reader lists them
 *                 (listReplaySessions: the project's own and its worktrees'), scanned for prompts
 *                 and Edit / Write / MultiEdit / NotebookEdit calls in the window
 *   refusals      anvi's structure-refusals.js through readRefusals (the route passes its answer in)
 *   rulings       calls.jsonl through readCalls
 *   commits       git log of the project's default branch (as the structure guard picks it), by
 *                 committer time: when the commit was made, not when it was authored
 *   catalogue     git log of the catalogue folder, in whatever repository holds it; a folder in
 *                 no repository has no history source, and the lane says so
 *   actions       actions.jsonl in AnviDeck's own folder, the lines that name this project
 *
 * Read-only: it reads files and asks git (log, rev-list, rev-parse, show, diff); it writes nothing.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { listReplaySessions } from "./replay";
import { callsDir, readCalls } from "./calls";
import { defaultRef } from "./structure";
import { resolveDir } from "../../shared/anvi-paths";
import { ENTRY_HEADER_LINE, entryIdFromHeader, parseCatalogueEntries } from "../../shared/parser";
import type { ReplaySessionsResponse } from "../../shared/replay-types";
import type { RefusalsResponse } from "../../shared/refusal-types";
import {
  HISTORY_KINDS,
  type ActionEvent,
  type CatalogueEvent,
  type CodeCompare,
  type CommitEvent,
  type CompareResponse,
  type EditEvent,
  type HistoryEvent,
  type HistoryKind,
  type HistoryResponse,
  type HistoryWindow,
  type KnowledgeCompare,
  type KnowledgeFileCompare,
  type LaneRead,
  type RefusalEvent,
  type RulingEvent,
  type Side,
  type TurnEvent,
} from "../../shared/history-types";

/** At most this many events of one kind are sent; the lane's total and per-day counts cover all of them. */
export const EVENT_CAP = 400;
/** The widest window one request may ask for. */
export const MAX_WINDOW_DAYS = 92;
/** Transcript bytes one request may scan; past it the turns and edits lanes are partial and say how much was left. */
export const MAX_SCAN_BYTES = 600_000_000;
export const PROMPT_CHARS = 160;
const GIT_TIMEOUT_MS = 30_000;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export class HistoryError extends Error {
  constructor(readonly status: 400 | 404, message: string) {
    super(message);
  }
}

// ── the window ─────────────────────────────────────────────────────────────────────────────

/** The window asked for: since < until, at most MAX_WINDOW_DAYS wide. Throws HistoryError(400) otherwise. */
export function windowFrom(since: string | undefined, until: string | undefined, tz: string | undefined, now = new Date()): HistoryWindow {
  const tzMinutes = tz === undefined || tz === "" ? 0 : Number(tz);
  if (!Number.isInteger(tzMinutes) || Math.abs(tzMinutes) > 14 * 60) throw new HistoryError(400, `tz must be minutes east of UTC, a whole number: ${JSON.stringify(tz)}`);
  const parse = (v: string, name: string) => {
    const ms = Date.parse(v);
    if (!/^\d{4}-\d{2}-\d{2}/.test(v) || Number.isNaN(ms)) throw new HistoryError(400, `${name} is not a time: ${JSON.stringify(v)}`);
    return ms;
  };
  const u = until ? parse(until, "until") : now.getTime();
  const s = since ? parse(since, "since") : u - 14 * 86_400_000;
  if (s >= u) throw new HistoryError(400, "since must be before until");
  if (u - s > MAX_WINDOW_DAYS * 86_400_000) throw new HistoryError(400, `the window is ${Math.round((u - s) / 86_400_000)} days; at most ${MAX_WINDOW_DAYS} days are read at once`);
  return { since: new Date(s).toISOString(), until: new Date(u).toISOString(), tzMinutes };
}

/** The local day ("YYYY-MM-DD") of a UTC time, `tzMinutes` east of UTC. */
export function dayOf(iso: string, tzMinutes: number): string {
  return new Date(Date.parse(iso) + tzMinutes * 60_000).toISOString().slice(0, 10);
}

const inWindow = (at: string, w: HistoryWindow) => at >= w.since && at < w.until;

// ── git, never throwing ────────────────────────────────────────────────────────────────────

type GitOut = { ok: true; out: string } | { ok: false; err: string };

export async function gitRead(dir: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitOut> {
  try {
    const proc = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe", env: process.env });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    clearTimeout(timer);
    if (timedOut) return { ok: false, err: `git ${args[0]} did not finish within ${timeoutMs / 1000} s and was stopped` };
    if (code !== 0) return { ok: false, err: `git ${args[0]} in ${dir}: ${err.trim() || `exit ${code}`}` };
    return { ok: true, out };
  } catch (e) {
    return { ok: false, err: `git ${args[0]} in ${dir}: ${(e as Error).message}` };
  }
}

const realOr = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

// ── lanes ──────────────────────────────────────────────────────────────────────────────────

function lane(kind: HistoryKind, source: string, all: HistoryEvent[], w: HistoryWindow, cap: number, status?: LaneRead["status"], detail?: string): { lane: LaneRead; events: HistoryEvent[] } {
  const perDay: Record<string, number> = {};
  for (const e of all) perDay[dayOf(e.at, w.tzMinutes)] = (perDay[dayOf(e.at, w.tzMinutes)] ?? 0) + 1;
  // Newest kept when over the cap: the lane says how many were left out.
  const sorted = [...all].sort((a, b) => a.at.localeCompare(b.at));
  const kept = sorted.length > cap ? sorted.slice(sorted.length - cap) : sorted;
  return {
    lane: { kind, status: status ?? (all.length ? "ok" : "none"), source, ...(detail ? { detail } : {}), total: all.length, shown: kept.length, perDay },
    events: kept,
  };
}

function failedLane(kind: HistoryKind, source: string, status: "unreadable" | "not-available" | "measuring", detail: string): LaneRead {
  return { kind, status, source, detail, total: 0, shown: 0, perDay: {} };
}

// ── transcripts: turns and edits ───────────────────────────────────────────────────────────

interface ScannedFile {
  size: number;
  mtimeMs: number;
  turns: { at: string; uuid: string; prompt: string; origin: string | null }[];
  edits: { at: string; id: string; tool: string; file: string }[];
  badLines: number;
}
const scanCache = new Map<string, ScannedFile>();

function promptText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  if (content.some((b) => b?.type === "tool_result")) return null;
  const text = content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join(" ");
  return text || null;
}

/** Prompts and edit calls in one transcript. Cached by path, size and mtime. Throws when the file cannot be read. */
export function scanTranscript(path: string): ScannedFile {
  const st = statSync(path);
  const hit = scanCache.get(path);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit;
  const text = readFileSync(path, "utf8");
  const out: ScannedFile = { size: st.size, mtimeMs: st.mtimeMs, turns: [], edits: [], badLines: 0 };
  let i = 0;
  while (i < text.length) {
    let j = text.indexOf("\n", i);
    if (j === -1) j = text.length;
    // Only records' own heads are looked at: a record's "type" can sit after a long message, so
    // the role is matched too. api-request records copy messages and are never events: the type
    // check after parsing excludes them; skipping them here only saves parsing large lines.
    const head = text.slice(i, Math.min(j, i + 600));
    const isUser = head.includes('"type":"user"') || head.includes('"role":"user"');
    const isAssistant = head.includes('"role":"assistant"');
    if ((isUser || isAssistant) && !head.startsWith('{"type":"api-request')) {
      const line = text.slice(i, j);
      if (isUser || /"name":"(?:Edit|Write|MultiEdit|NotebookEdit)"/.test(line)) {
        let r: any;
        try {
          r = JSON.parse(line);
        } catch {
          out.badLines++;
          r = null;
        }
        if (r && typeof r.timestamp === "string" && !r.isSidechain) {
          if (r.type === "user" && !r.isMeta && !r.isCompactSummary) {
            const p = promptText(r.message?.content);
            // Command wrappers and interrupts are records, not prompts someone wrote.
            if (p && !/^\s*<(?:command-|local-command-|bash-|task-notification)/.test(p) && !/^\[Request interrupted/.test(p))
              out.turns.push({ at: r.timestamp, uuid: String(r.uuid ?? r.timestamp), prompt: p.replace(/\s+/g, " ").trim().slice(0, PROMPT_CHARS), origin: r.origin?.kind ?? null });
          } else if (r.type === "assistant" && Array.isArray(r.message?.content)) {
            for (const b of r.message.content) {
              if (b?.type === "tool_use" && EDIT_TOOLS.has(b.name)) {
                const file = b.input?.file_path ?? b.input?.notebook_path;
                if (typeof file === "string") out.edits.push({ at: r.timestamp, id: String(b.id ?? `${r.uuid}:${file}`), tool: b.name, file });
              }
            }
          }
        }
      }
    }
    i = j + 1;
  }
  scanCache.set(path, out);
  return out;
}

export async function readTranscriptLanes(sessionsRead: ReplaySessionsResponse, w: HistoryWindow, projectPath: string, cap: number, maxBytes = MAX_SCAN_BYTES) {
  const source = `session transcripts under ~/.claude/projects (${sessionsRead.searched.length} folder${sessionsRead.searched.length === 1 ? "" : "s"}: the project's and its worktrees')`;
  if (sessionsRead.status === "unreadable" || sessionsRead.status === "not-found") {
    const why = sessionsRead.detail ?? `the transcripts could not be listed (${sessionsRead.status})`;
    // not-found: this project has no transcript folder; unreadable: it could not be listed.
    const st = sessionsRead.status === "not-found" ? "not-available" : "unreadable";
    return { turn: { lane: failedLane("turn", source, st, why), events: [] }, edit: { lane: failedLane("edit", source, st, why), events: [] }, sessions: [] };
  }
  const overlapping = sessionsRead.sessions.filter((s) => {
    const first = s.firstTs ?? s.modifiedAt;
    const last = s.lastTs ?? s.modifiedAt;
    return first < w.until && last >= w.since;
  });
  const turns: TurnEvent[] = [];
  const edits: EditEvent[] = [];
  const sessions: HistoryResponse["sessions"] = [];
  const failed: string[] = [];
  let bad = 0;
  let bytes = 0;
  const skipped: string[] = [];
  // Newest first, so a scan stopped at the byte budget keeps the most recent sessions.
  for (const s of [...overlapping].sort((a, b) => (b.lastTs ?? b.modifiedAt).localeCompare(a.lastTs ?? a.modifiedAt))) {
    if (bytes + s.sizeBytes > maxBytes && bytes > 0) {
      skipped.push(s.sessionId);
      continue;
    }
    bytes += s.sizeBytes;
    let f: ScannedFile;
    try {
      // One file at a time, giving the event loop back between files: a cold scan of hundreds of
      // MB must not stall every other request the server is answering.
      await new Promise((r) => setImmediate(r));
      f = scanTranscript(s.transcriptPath);
    } catch (e) {
      failed.push(`${s.transcriptPath}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
      continue;
    }
    bad += f.badLines;
    const t = f.turns.filter((x) => inWindow(x.at, w));
    const e = f.edits.filter((x) => inWindow(x.at, w));
    for (const x of t) turns.push({ kind: "turn", at: x.at, id: `${s.sessionId}:${x.uuid}`, session: s.sessionId, prompt: x.prompt, origin: x.origin });
    for (const x of e)
      edits.push({ kind: "edit", at: x.at, id: x.id, session: s.sessionId, tool: x.tool, file: x.file.startsWith(projectPath + "/") ? relative(projectPath, x.file) : x.file });
    if (t.length || e.length) {
      const times = [...t, ...e].map((x) => x.at).sort();
      sessions.push({ id: s.sessionId, first: times[0], last: times[times.length - 1], turns: t.length, edits: e.length, cwd: s.cwd });
    }
  }
  const notes: string[] = [];
  if (failed.length) notes.push(`${failed.length} of ${overlapping.length} transcripts could not be read (${failed.slice(0, 3).join("; ")})`);
  if (skipped.length) notes.push(`${skipped.length} older sessions were not scanned: this request's scan stopped at ${Math.round(maxBytes / 1e6)} MB of transcripts — narrow the window to see them`);
  if (bad) notes.push(`${bad} transcript lines that looked like prompts or edits were not JSON and are not counted`);
  const partial = failed.length || skipped.length || bad;
  const st = (n: number): LaneRead["status"] => (partial ? (n || overlapping.length > failed.length ? "partial" : "unreadable") : n ? "ok" : "none");
  const detail = [`${overlapping.length} sessions overlap the window; ${Math.round(bytes / 1e6)} MB scanned. Subagent transcripts are not included.`, ...notes].join(" ");
  sessions.sort((a, b) => a.first.localeCompare(b.first));
  return {
    turn: lane("turn", `${source}: user prompts that are not tool results, commands or subagent records`, turns, w, cap, st(turns.length), detail),
    edit: lane("edit", `${source}: Edit, Write, MultiEdit and NotebookEdit calls (the call, whatever its outcome)`, edits, w, cap, st(edits.length), detail),
    sessions,
  };
}

// ── refusals and rulings ───────────────────────────────────────────────────────────────────

export function readRefusalLane(r: RefusalsResponse, w: HistoryWindow, cap: number) {
  const source = "anvi's structure-refusals.js (GET /api/refusals): edits the design guard refused";
  if (r.status === "measuring") return { lane: failedLane("refusal", source, "measuring", `the instrument is running since ${r.startedAt} (it reads every transcript on the machine; minutes)`), events: [] };
  if (r.status === "no-design" || r.status === "not-measured") return { lane: failedLane("refusal", source, "not-available", r.reason), events: [] };
  if (r.status === "unreadable") return { lane: failedLane("refusal", source, "unreadable", r.reason), events: [] };
  const events: RefusalEvent[] = r.refusals.filter((x) => inWindow(x.at, w)).map((x) => ({
    kind: "refusal",
    at: x.at,
    id: x.key,
    session: x.session,
    tool: x.tool,
    file: x.file,
    pairs: x.pairs.map((p) => p.pair),
    refusedBy: x.refusedBy,
    reason: x.reason,
    design: x.design,
    call: x.call.state === "called"
      ? { state: "called", call: x.call.latest.call, at: x.call.latest.at, ...(x.call.latest.note ? { note: x.call.latest.note } : {}), earlier: x.call.earlier.length }
      : x.call,
  }));
  const winNote = `measured ${r.cache.at} over ${r.window.since}${r.window.until ? ` – ${r.window.until}` : " onwards"} in package ${r.package}`;
  const before = r.window.since > w.since ? ` The instrument's window starts ${r.window.since}, after this window does: refusals before it are not counted.` : "";
  return lane("refusal", source, events, w, cap, before ? "partial" : undefined, `${winNote}.${before}`);
}

export function readRulingLane(project: string, w: HistoryWindow, cap: number, dir?: string) {
  const read = readCalls({ dir: dir ?? callsDir(), project });
  const source = `your calls on refusals: ${read.file}`;
  if (read.status === "unreadable") return { lane: failedLane("ruling", source, "unreadable", read.error ?? "could not be read"), events: [] };
  const latestAt = new Map(Object.entries(read.byKey).map(([k, s]) => [k, s.latest.at]));
  const events: RulingEvent[] = read.calls.filter((c) => inWindow(c.at, w)).map((c) => ({
    kind: "ruling",
    at: c.at,
    id: `${c.key}@${c.at}`,
    key: c.key,
    call: c.call,
    ...(c.note ? { note: c.note } : {}),
    ...(c.refusal ? { refusal: c.refusal } : {}),
    superseded: latestAt.get(c.key) !== c.at,
  }));
  const detail = read.exists ? (read.unreadableLines ? `${read.unreadableLines} of ${read.lines} lines are not calls and are not shown` : undefined) : "no call has been recorded yet (the file does not exist)";
  return lane("ruling", source, events, w, cap, read.status === "partial" ? "partial" : undefined, detail);
}

// ── commits ────────────────────────────────────────────────────────────────────────────────

const US = "\x1f";

export async function repoTop(dir: string): Promise<GitOut> {
  const r = await gitRead(dir, ["rev-parse", "--show-toplevel"]);
  return r.ok ? { ok: true, out: r.out.trim() } : r;
}

/** The project's default branch, as the structure guard picks it (origin/HEAD, else the one of origin/main, origin/master). */
export async function projectRef(projectPath: string): Promise<{ top: string; ref: string; why: string } | { reason: string }> {
  const top = await repoTop(projectPath);
  if (!top.ok) return { reason: `${projectPath} is not in a git repository (${top.err})` };
  const d = defaultRef(top.out);
  if ("notMeasured" in d) return { reason: d.notMeasured };
  return { top: top.out, ref: d.ref, why: d.why };
}

/**
 * Commits in the window: every commit's time (one short line each, so the lane's total and
 * per-day counts cover all of them), and the newest `cap` with subject, author and files.
 */
async function logEvents(dir: string, args: string[], w: HistoryWindow, cap: number): Promise<{ ok: true; times: string[]; rows: string[][] } | { ok: false; err: string }> {
  const range = [`--since=${w.since}`, `--until=${w.until}`];
  const times = await gitRead(dir, ["log", ...range, "--format=%cI", ...args.filter((a) => a !== "--name-status")]);
  if (!times.ok) return times;
  const log = await gitRead(dir, ["log", `-n`, String(cap), ...range, `--format=%x1e%H${US}%cI${US}%an${US}%s`, ...args]);
  if (!log.ok) return log;
  const rows = log.out.split("\x1e").filter((b) => b.trim()).map((b) => b.split("\n")[0].split(US).concat([b.split("\n").slice(1).join("\n")]));
  return { ok: true, times: times.out.split("\n").filter(Boolean).map((t) => new Date(t).toISOString()), rows };
}

export async function readCommitLane(projectPath: string, w: HistoryWindow, cap: number) {
  const ref = await projectRef(projectPath);
  if ("reason" in ref) return { lane: failedLane("commit", "git log of the project's default branch", "not-available", ref.reason), events: [] as HistoryEvent[] };
  const source = `git log ${ref.ref} in ${ref.top} (the default branch, by ${ref.why}; as of the last fetch), by committer time`;
  const r = await logEvents(ref.top, ["--end-of-options", ref.ref, "--"], w, cap);
  if (!r.ok) return { lane: failedLane("commit", source, "unreadable", r.err), events: [] as HistoryEvent[] };
  const events: CommitEvent[] = r.rows.map(([sha, at, author, subject]) => ({ kind: "commit", at: new Date(at).toISOString(), id: sha, sha, subject, author }));
  return withTimes(lane("commit", source, events, w, cap), r.times, w);
}

/** The lane's total and per-day counts from every commit's time, not only the `cap` rows sent. */
function withTimes(l: { lane: LaneRead; events: HistoryEvent[] }, times: string[], w: HistoryWindow) {
  const perDay: Record<string, number> = {};
  for (const t of times) perDay[dayOf(t, w.tzMinutes)] = (perDay[dayOf(t, w.tzMinutes)] ?? 0) + 1;
  l.lane.total = Math.max(times.length, l.events.length);
  l.lane.perDay = perDay;
  l.lane.status = l.lane.total ? "ok" : "none";
  return l;
}

// ── catalogue changes ──────────────────────────────────────────────────────────────────────

/** Where a project's catalogues live and which repository, if any, keeps their history. */
export async function catalogueRepo(projectPath: string, anviDir?: string | null): Promise<{ dir: string; top: string; rel: string } | { reason: string }> {
  const dir = anviDir === undefined ? resolveDir(projectPath, ".anvi") : anviDir;
  if (!dir) return { reason: `${projectPath} has no catalogue folder (.anvi in the project, artifacts/.anvi, or ~/.anvideck/projects/<name>/.anvi)` };
  const real = realOr(dir);
  const top = await repoTop(real);
  if (!top.ok) return { reason: `the catalogue folder ${dir} is in no git repository, so catalogue changes have no history source (${top.err})` };
  const rel = relative(realOr(top.out), real) || ".";
  const tracked = await gitRead(top.out, ["ls-files", "--", rel]);
  if (tracked.ok && !tracked.out.trim()) return { reason: `the catalogue folder ${dir} is in ${top.out} but git tracks none of its files, so catalogue changes have no history source` };
  return { dir, top: top.out, rel };
}

export async function readCatalogueLane(projectPath: string, w: HistoryWindow, cap: number, anviDir?: string | null) {
  const repo = await catalogueRepo(projectPath, anviDir);
  if ("reason" in repo) return { lane: failedLane("catalogue", "git log of the catalogue folder", "not-available", repo.reason), events: [] as HistoryEvent[] };
  const source = `git log -- ${repo.rel} in ${repo.top} (commits that changed the catalogue folder), by committer time`;
  const r = await logEvents(repo.top, ["--name-status", "--end-of-options", "HEAD", "--", repo.rel], w, cap);
  if (!r.ok) return { lane: failedLane("catalogue", source, "unreadable", r.err), events: [] as HistoryEvent[] };
  const prefix = repo.rel === "." ? "" : repo.rel + "/";
  const events: CatalogueEvent[] = r.rows.map(([sha, at, , subject, rest]) => ({
    kind: "catalogue",
    at: new Date(at).toISOString(),
    id: sha,
    sha,
    subject,
    files: (rest ?? "").split("\n").filter((l) => /^[A-Z]\d*\t/.test(l)).map((l) => {
      const parts = l.split("\t");
      const file = parts[parts.length - 1];
      return { status: parts[0][0], file: file.startsWith(prefix) ? file.slice(prefix.length) : file };
    }),
  }));
  return withTimes(lane("catalogue", source, events, w, cap), r.times, w);
}

// ── AnviDeck's own actions ─────────────────────────────────────────────────────────────────

/** actions.jsonl lines that name this project (body.project, or an agent started in its folder). Read here: readers may not import the action log. */
export function readActionLane(project: string, projectPath: string, w: HistoryWindow, cap: number, dir?: string) {
  const file = join(dir ?? callsDir(), "actions.jsonl");
  const source = `AnviDeck's action log: ${file} (lines naming this project)`;
  if (!existsSync(file)) return lane("action", source, [], w, cap, "none", "nothing has been logged yet (the file does not exist)");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return { lane: failedLane("action", source, "unreadable", `${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`), events: [] as HistoryEvent[] };
  }
  const lines = text.split("\n").filter((l) => l.trim());
  let bad = 0;
  let otherOrNone = 0;
  const events: ActionEvent[] = [];
  lines.forEach((l, n) => {
    let r: any;
    try {
      r = JSON.parse(l);
    } catch {
      bad++;
      return;
    }
    if (!r || typeof r.at !== "string" || typeof r.method !== "string") {
      bad++;
      return;
    }
    const body = r.body && typeof r.body === "object" ? r.body : {};
    const mine = body.project === project || (typeof body.cwd === "string" && realOr(body.cwd) === realOr(projectPath));
    if (!mine) {
      otherOrNone++;
      return;
    }
    if (!inWindow(r.at, w)) return;
    events.push({ kind: "action", at: r.at, id: `${n}`, method: r.method, path: String(r.path ?? ""), result: String(r.result ?? ""), status: Number(r.status) || 0, ...(r.reason ? { reason: String(r.reason) } : {}), ...(r.target ? { target: String(r.target) } : {}) });
  });
  const detail = `${otherOrNone} of ${lines.length} logged actions name another project or none and are not on this timeline${bad ? `; ${bad} lines are not actions` : ""}.`;
  return lane("action", source, events, w, cap, bad ? "partial" : undefined, detail);
}

// ── the whole timeline ─────────────────────────────────────────────────────────────────────

export interface HistoryOptions {
  project: string;
  path: string;
  window: HistoryWindow;
  refusals: RefusalsResponse;
  sessions?: ReplaySessionsResponse;
  callsDir?: string;
  anviDir?: string | null;
  cap?: number;
}

export async function readHistory(o: HistoryOptions): Promise<HistoryResponse> {
  const t0 = Date.now();
  const cap = o.cap ?? EVENT_CAP;
  const w = o.window;
  const sessionsRead = o.sessions ?? listReplaySessions(o.project);
  const tr = await readTranscriptLanes(sessionsRead, w, o.path, cap);
  const [commit, catalogue] = await Promise.all([readCommitLane(o.path, w, cap), readCatalogueLane(o.path, w, cap, o.anviDir)]);
  const parts: Record<HistoryKind, { lane: LaneRead; events: HistoryEvent[] }> = {
    turn: tr.turn,
    edit: tr.edit,
    refusal: readRefusalLane(o.refusals, w, cap),
    ruling: readRulingLane(o.project, w, cap, o.callsDir),
    commit,
    catalogue,
    action: readActionLane(o.project, o.path, w, cap, o.callsDir),
  };
  const lanes = Object.fromEntries(HISTORY_KINDS.map((k) => [k, parts[k].lane])) as Record<HistoryKind, LaneRead>;
  const events = HISTORY_KINDS.flatMap((k) => parts[k].events).sort((a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind));
  return { project: o.project, path: o.path, window: w, readAt: new Date().toISOString(), ms: Date.now() - t0, cap, lanes, events, sessions: tr.sessions };
}

// ── compare two points ─────────────────────────────────────────────────────────────────────

async function commitAt(top: string, at: string, args: string[]): Promise<GitOut & { row?: { sha: string; date: string; subject: string } | null }> {
  const r = await gitRead(top, ["log", "-1", `--before=${at}`, `--format=%H${US}%cI${US}%s`, ...args]);
  if (!r.ok) return r;
  const line = r.out.trim();
  if (!line) return { ok: true, out: "", row: null };
  const [sha, date, subject] = line.split(US);
  return { ok: true, out: line, row: { sha, date: new Date(date).toISOString(), subject } };
}

export async function compareCode(projectPath: string, a: string, b: string, fileCap = 200): Promise<Side<CodeCompare>> {
  const ref = await projectRef(projectPath);
  if ("reason" in ref) return { ok: false, reason: ref.reason };
  const [ca, cb] = await Promise.all([commitAt(ref.top, a, ["--end-of-options", ref.ref, "--"]), commitAt(ref.top, b, ["--end-of-options", ref.ref, "--"])]);
  if (!ca.ok) return { ok: false, reason: ca.err };
  if (!cb.ok) return { ok: false, reason: cb.err };
  const base = { repo: ref.top, ref: ref.ref, refWhy: ref.why, a: ca.row ? { at: a, ...ca.row } : null, b: cb.row ? { at: b, ...cb.row } : null };
  if (!ca.row || !cb.row) return { ok: true, value: { ...base, commits: 0, shortstat: "", files: [], filesTotal: 0 } };
  const [count, short, num] = await Promise.all([
    gitRead(ref.top, ["rev-list", "--count", `${ca.row.sha}..${cb.row.sha}`]),
    gitRead(ref.top, ["diff", "--shortstat", ca.row.sha, cb.row.sha]),
    gitRead(ref.top, ["diff", "--numstat", ca.row.sha, cb.row.sha]),
  ]);
  for (const r of [count, short, num]) if (!r.ok) return { ok: false, reason: r.err };
  const rows = (num as { out: string }).out.split("\n").filter(Boolean).map((l) => {
    const [ad, de, ...f] = l.split("\t");
    return { file: f.join("\t"), added: ad === "-" ? null : Number(ad), deleted: de === "-" ? null : Number(de) };
  });
  return {
    ok: true,
    value: { ...base, commits: Number((count as { out: string }).out.trim()) || 0, shortstat: (short as { out: string }).out.trim(), files: rows.slice(0, fileCap), filesTotal: rows.length },
  };
}

/** Entries by id → their text, so a changed body, field or continuation counts as changed. */
function entriesOf(md: string, name: string): Map<string, string> {
  // Which entries exist: the parser's answer, so the counts match every other screen's.
  const ids = parseCatalogueEntries(md, name).map((e) => e.id);
  // What each holds: every block under a heading of its ID (continuations included), verbatim.
  const text = new Map<string, string>();
  let cur: string | null = null;
  for (const l of md.split("\n")) {
    const h = ENTRY_HEADER_LINE.exec(l);
    if (h) cur = entryIdFromHeader(h[2].trim())?.id ?? null;
    if (cur) text.set(cur, (text.get(cur) ?? "") + l.trimEnd() + "\n");
  }
  return new Map(ids.map((id) => [id, text.get(id) ?? ""]));
}

export const COMPARED_CATALOGUES = ["hetvabhasa.md", "vyapti.md", "krama.md", "dharana.md"];

export function diffEntries(file: string, before: string | null, after: string | null): KnowledgeFileCompare {
  const name = file.replace(/\.md$/, "");
  const A = before === null ? null : entriesOf(before, name);
  const B = after === null ? null : entriesOf(after, name);
  const a = A ?? new Map<string, string>();
  const b = B ?? new Map<string, string>();
  return {
    file,
    before: A ? A.size : null,
    after: B ? B.size : null,
    added: [...b.keys()].filter((k) => !a.has(k)),
    removed: [...a.keys()].filter((k) => !b.has(k)),
    changed: [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k)),
  };
}

export async function compareKnowledge(projectPath: string, a: string, b: string, anviDir?: string | null): Promise<Side<KnowledgeCompare>> {
  const repo = await catalogueRepo(projectPath, anviDir);
  if ("reason" in repo) return { ok: false, reason: repo.reason };
  const path = ["--end-of-options", "HEAD", "--", repo.rel];
  const [ca, cb] = await Promise.all([commitAt(repo.top, a, path), commitAt(repo.top, b, path)]);
  if (!ca.ok) return { ok: false, reason: ca.err };
  if (!cb.ok) return { ok: false, reason: cb.err };
  const base = { repo: repo.top, dir: repo.dir, a: ca.row ? { at: a, sha: ca.row.sha, date: ca.row.date } : null, b: cb.row ? { at: b, sha: cb.row.sha, date: cb.row.date } : null };
  const prefix = repo.rel === "." ? "" : repo.rel + "/";
  const show = async (sha: string | undefined, file: string): Promise<{ ok: true; text: string | null } | { ok: false; err: string }> => {
    if (!sha) return { ok: true, text: null };
    const exists = await gitRead(repo.top, ["ls-tree", "--name-only", sha, "--", prefix + file]);
    if (!exists.ok) return { ok: false, err: exists.err };
    if (!exists.out.trim()) return { ok: true, text: null };
    const r = await gitRead(repo.top, ["show", `${sha}:${prefix}${file}`]);
    return r.ok ? { ok: true, text: r.out } : { ok: false, err: r.err };
  };
  const files: KnowledgeFileCompare[] = [];
  for (const f of COMPARED_CATALOGUES) {
    const [x, y] = await Promise.all([show(ca.row?.sha, f), show(cb.row?.sha, f)]);
    if (!x.ok) return { ok: false, reason: x.err };
    if (!y.ok) return { ok: false, reason: y.err };
    if (x.text === null && y.text === null) continue;
    files.push(diffEntries(f, x.text, y.text));
  }
  let commits = 0;
  if (ca.row && cb.row) {
    const c = await gitRead(repo.top, ["rev-list", "--count", `${ca.row.sha}..${cb.row.sha}`, "--", repo.rel]);
    if (!c.ok) return { ok: false, reason: c.err };
    commits = Number(c.out.trim()) || 0;
  } else if (cb.row) {
    const c = await gitRead(repo.top, ["rev-list", "--count", cb.row.sha, "--", repo.rel]);
    if (!c.ok) return { ok: false, reason: c.err };
    commits = Number(c.out.trim()) || 0;
  }
  return { ok: true, value: { ...base, commits, files } };
}

export async function readCompare(project: string, projectPath: string, a: string, b: string, anviDir?: string | null): Promise<CompareResponse> {
  const [code, knowledge] = await Promise.all([compareCode(projectPath, a, b), compareKnowledge(projectPath, a, b, anviDir)]);
  return { project, a, b, code, knowledge };
}
