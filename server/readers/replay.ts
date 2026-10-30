import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import { join, dirname, basename, isAbsolute, relative } from "node:path";
import { homedir } from "node:os";
import type {
  ChangedFile,
  CommitInfo,
  MergeEvidence,
  NoteUsed,
  PrInfo,
  ReadStatus,
  ReplayResponse,
  ReplaySessionSummary,
  ReplaySessionsResponse,
  ReplayStep,
  SourceStatus,
  StepSource,
} from "../../shared/replay-types";

/**
 * Replay reader (issue #15): what one agent did in a time window, what anvi
 * told it, and what it changed. Read only — every file here is opened for
 * reading, and git/gh are only asked read-only questions (log, rev-parse,
 * pr view).
 *
 * Formats, and where each was seen:
 *  - Transcript `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`. No source to cite
 *    (Claude Code is closed); observed in the stave control transcript
 *    811b15d0-…jsonl (7,849 records on 2026-10-30, 2,795 without `timestamp`):
 *      tool calls  = `type:"assistant"` records, `message.content[]` items with
 *                    `type:"tool_use"`, `name`, `id`, `input.file_path|command`
 *      injections  = records with `attachment.type:"hook_additional_context"`,
 *                    `attachment.{hookName, hookEvent, toolUseID, content[]}`;
 *                    a large one is a `<persisted-output>` preview naming the
 *                    full file `<sid>/tool-results/hook-…-additionalContext.txt`
 *      PR links    = `type:"pr-link"` records `{prNumber, prRepository, timestamp}`
 *      untimed     = last-prompt, mode, permission-mode, atis-latch,
 *                    file-history-snapshot, api-request-blob, ai-title, … (no `timestamp`)
 *  - Hook meter: `~/.claude/hooks/hook-meter.js` — `meterDir()` (hook-meter.js:46-49:
 *    $ANVI_METER_DIR, else $CLAUDE_DIR/anvi-meter, else ~/.claude/anvi-meter),
 *    one file per session `fileFor(sid)` (hook-meter.js:53), row
 *    `{ ts, sid, hook, event, bytes, ms, outcome }` (hook-meter.js:17, 88). `ts`
 *    is when the hook STARTED; no file path, so it is joined to the transcript
 *    on sid + time.
 *  - Live hook log: `/tmp/anvi-hook-<sid>.log`, written by
 *    `~/.claude/hooks/catalogue-context-injector.js:1083-1098`, JSON lines
 *    `{ ts, sid, file (project-relative), boundaries, fatality, patterns, invariants }`.
 *  - Merge judgements: `~/.claude/structure-guard-cache/merges.jsonl`
 *    (`~/.claude/hooks/structure-merge-hook.js:45-47`, row written at :357 with
 *    `{ ts, session, …, pr }`).
 */

const CLAUDE_DIR = process.env.CLAUDE_DIR || join(homedir(), ".claude");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
/** Mirrors hook-meter.js meterDir() (hook-meter.js:46-49). */
const METER_DIR = process.env.ANVI_METER_DIR || join(CLAUDE_DIR, "anvi-meter");
const MERGE_LOG = join(CLAUDE_DIR, "structure-guard-cache", "merges.jsonl");
const HOOK_LOG = (sid: string) => join("/tmp", `anvi-hook-${sid}.log`);

const SID_RE = /^[A-Za-z0-9._-]{1,128}$/;
export function isValidSid(sid: string): boolean {
  return SID_RE.test(sid) && !/^\.+$/.test(sid);
}

/** Claude Code's transcript dir name for a cwd: every non-alphanumeric → "-". */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function retentionDays(): number {
  try {
    const s = JSON.parse(readFileSync(join(CLAUDE_DIR, "settings.json"), "utf8"));
    if (typeof s?.cleanupPeriodDays === "number") return s.cleanupPeriodDays;
  } catch {
    /* fall through to the default */
  }
  return 30; // Claude Code's documented default
}

/** First transcript `<projects>/<dir>/<sid>.jsonl` that exists, or null. */
export function findTranscript(sid: string): string | null {
  let dirs: string[];
  try {
    dirs = readdirSync(PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = join(PROJECTS_DIR, d, `${sid}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

// ─── Session list ────────────────────────────────────────────────────────────

/** Read up to `n` bytes from the start (or end) of a file. */
function readChunk(path: string, n: number, fromEnd: boolean): string {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const len = Math.min(n, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, fromEnd ? size - len : 0);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * The first timestamp and cwd near the start of a transcript. Large records
 * (api-request blobs) can push the first cwd well past 64 KB, so the read grows
 * (64 KB → 1 MB → 8 MB) until a cwd is seen (#30).
 */
function scanHead(path: string): { ts: string | null; cwd: string | null } {
  let head = { ts: null as string | null, cwd: null as string | null };
  for (const n of [65536, 1 << 20, 8 << 20]) {
    head = scanTs(readChunk(path, n, false).split("\n"));
    if (head.cwd || statSync(path).size <= n) break;
  }
  return head;
}

function scanTs(lines: string[]): { ts: string | null; cwd: string | null } {
  let cwd: string | null = null;
  let ts: string | null = null;
  for (const l of lines) {
    try {
      const r = JSON.parse(l);
      if (!cwd && typeof r?.cwd === "string") cwd = r.cwd;
      if (!ts && typeof r?.timestamp === "string") ts = r.timestamp;
      if (ts && cwd) break;
    } catch {
      /* partial line at a chunk edge */
    }
  }
  return { ts, cwd };
}

export function listReplaySessions(project: string): ReplaySessionsResponse {
  const out: ReplaySessionsResponse = { timezone: "UTC", project, status: "none", searched: [], sessions: [], skipped: [] };
  let dirs: string[];
  try {
    dirs = readdirSync(PROJECTS_DIR);
  } catch (e) {
    out.status = existsSync(PROJECTS_DIR) ? "unreadable" : "not-found";
    out.detail = `could not read ${PROJECTS_DIR}: ${(e as Error).message}`;
    return out;
  }
  const suffix = "-" + encodeCwd(project);
  // Sessions started in a worktree live under a longer dir name: the project's
  // own dir name plus "-wt-…" (a sibling worktree) or "--claude-worktrees-…"
  // (<project>/.claude/worktrees/…) (#30). A plain prefix match would also take
  // sibling projects ("basher-ai") and scratchpads, so only these two forms count. They are candidates
  // only; each is checked against the project's repository below.
  const mainDirs = dirs.filter((x) => x.endsWith(suffix));
  const wtDirs = dirs.filter((x) => mainDirs.some((m) => x.startsWith(m + "-wt-") || x.startsWith(m + "--claude-worktrees-")));
  const projectPaths = new Set<string>();
  const summarize = (p: string, f: string, head: { ts: string | null; cwd: string | null }) => {
    const st = statSync(p);
    const tail = scanTs(readChunk(p, 65536, true).split("\n").reverse());
    return {
      sessionId: f.slice(0, -".jsonl".length),
      project,
      cwd: head.cwd,
      transcriptPath: p,
      sizeBytes: st.size,
      modifiedAt: iso(st.mtimeMs),
      firstTs: head.ts,
      lastTs: tail.ts,
    } as ReplaySessionSummary;
  };
  const jsonl = (full: string) => {
    try {
      return readdirSync(full).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }
  };
  for (const d of mainDirs) {
    const full = join(PROJECTS_DIR, d);
    out.searched.push(full);
    for (const f of jsonl(full)) {
      const p = join(full, f);
      try {
        const head = scanHead(p);
        // The encoded dir name is lossy; the record's own cwd decides the project.
        if (head.cwd && basename(head.cwd) !== project) continue;
        if (head.cwd) projectPaths.add(head.cwd);
        out.sessions.push(summarize(p, f, head));
      } catch {
        /* unreadable transcript: listed in neither */
      }
    }
  }
  const storeOf = (dir: string): string | null => {
    const r = run(["git", "-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], undefined, 3000);
    return r.ok && r.out.trim() ? realOr(r.out.trim()) : null;
  };
  const projectPath = [...projectPaths].find((x) => existsSync(x)) ?? [...projectPaths][0] ?? null;
  const projectStore = projectPath && existsSync(projectPath) ? storeOf(projectPath) : null;
  for (const d of wtDirs) {
    const full = join(PROJECTS_DIR, d);
    out.searched.push(full);
    for (const f of jsonl(full)) {
      const p = join(full, f);
      let head: { ts: string | null; cwd: string | null };
      try {
        head = scanHead(p);
      } catch {
        continue;
      }
      const cwd = head.cwd;
      let check: "cwd-is-project" | "same-repository" | "unverified-gone" | null = null;
      let why = "";
      if (!cwd) why = "no cwd recorded";
      else if (basename(cwd) === project) check = "cwd-is-project";
      else if (existsSync(cwd)) {
        const st = storeOf(cwd);
        if (st && projectStore && st === projectStore) check = "same-repository";
        else why = !projectStore ? "the project's own repository could not be resolved" : "a different repository";
      } else if (
        projectPath &&
        (cwd.startsWith(projectPath + "/.claude/worktrees/") ||
          (dirname(cwd) === dirname(projectPath) && basename(cwd).startsWith(project + "-wt-")))
      )
        check = "unverified-gone";
      else why = "directory gone and its name does not mark it as this project's worktree";
      if (!check) {
        out.skipped!.push({ transcriptPath: p, cwd, reason: why });
        continue;
      }
      try {
        const s = summarize(p, f, head);
        s.worktree = { transcriptDir: d, check };
        out.sessions.push(s);
      } catch {
        /* unreadable transcript */
      }
    }
  }
  out.sessions.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  if (out.searched.length === 0) {
    out.status = "not-found";
    out.detail = `no transcript directory ends with "${suffix}" under ${PROJECTS_DIR}`;
  } else {
    out.status = out.sessions.length ? "ok" : "none";
  }
  return out;
}

// ─── Shell commands ──────────────────────────────────────────────────────────

const SHELL_WRITE_PATTERNS: [RegExp, string][] = [
  [/\bgit\s+(mv|rm|apply|restore|checkout\s+--)\b/, "git $1"],
  [/\bsed\s+(-[A-Za-z]*i\b|--in-place)/, "sed -i"],
  [/\bperl\s+-[A-Za-z]*i/, "perl -i"],
  [/open\([^()]*,\s*['"][wa]b?\+?['"]/, "a script opens a file for writing"],
  [/\.write_text\(|writeFileSync\(/, "a script writes a file"],
  [/(^|[;&|(]\s*|&&\s*|\bthen\s+|\bdo\s+)(mv|cp|rm|ln|touch|patch|tee|truncate)\s/, "$2"],
];

/** A guess: does this shell command text write files? Returns the reason or null. */
export function shellWriteReason(cmd: string): string | null {
  for (const [re, label] of SHELL_WRITE_PATTERNS) {
    const m = cmd.match(re);
    if (m) return label.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? "");
  }
  // Output redirection to a real file (not /dev/null, not an fd like 2>&1).
  const redir = /(?:^|[^0-9&>])>>?\s*([^\s&;|<>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = redir.exec(cmd))) {
    const target = m[1];
    if (target === "/dev/null" || target.startsWith("&")) continue;
    return `redirects output to ${target}`;
  }
  return null;
}

/** Directories whose files are throwaway (session scratchpads, temp output), never project code. */
const SCRATCH_ROOTS = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"];
const isScratch = (p: string) => SCRATCH_ROOTS.some((r) => p === r.slice(0, -1) || p.startsWith(r));

/**
 * Where a guessed shell write lands: "project" (could be a code change), "scratch"
 * (temp/scratchpad only) or "link" (only creates links). Targets are found from
 * redirects, cp/mv/tee/touch arguments and `open(<path>, 'w')`; `$VAR` is expanded
 * from `VAR=value` assignments in the same command, and relative targets resolve
 * against the last `cd` before them. When no target can be read (git mv, sed -i,
 * write_text…), the directory the command ran in decides. Still a guess.
 */
export function shellWriteScope(cmd: string): "project" | "scratch" | "link" {
  const vars = new Map<string, string>();
  for (const m of cmd.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)=(['"]?)([^\s'";&|]+)\2/g)) vars.set(m[1], m[3]);
  const expand = (s: string) => s.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (all, v) => vars.get(v) ?? all);
  const cds: { at: number; dir: string }[] = [];
  let cwd = "";
  for (const m of cmd.matchAll(/(?:^|[;&|]\s*|&&\s*)cd\s+(['"]?)([^\s'";&|]+)\1/g)) {
    const d = expand(m[2]);
    cwd = d.startsWith("/") ? d : cwd ? join(cwd, d) : d;
    cds.push({ at: m.index!, dir: cwd });
  }
  const cwdAt = (i: number) => [...cds].reverse().find((c) => c.at < i)?.dir ?? "";
  const resolve = (t: string, i: number) => {
    const e = expand(t.replace(/^['"]|['"]$/g, ""));
    return e.startsWith("/") ? e : join(cwdAt(i) || ".", e);
  };
  const targets: string[] = [];
  for (const m of cmd.matchAll(/(?:^|[^0-9&>])>>?\s*([^\s&;|<>]+)/g)) {
    if (m[1] !== "/dev/null" && !m[1].startsWith("&")) targets.push(resolve(m[1], m.index!));
  }
  for (const m of cmd.matchAll(/(?:^|[;&|(]\s*|&&\s*)(cp|mv)\s+([^;&|\n]+)/g)) {
    const args = m[2].trim().split(/\s+/).filter((a) => !a.startsWith("-"));
    if (args.length >= 2) targets.push(resolve(args[args.length - 1], m.index!));
  }
  for (const m of cmd.matchAll(/(?:^|[;&|(]\s*|&&\s*)(tee|touch)\s+([^;&|\n]+)/g)) {
    for (const a of m[2].trim().split(/\s+/).filter((x) => !x.startsWith("-"))) targets.push(resolve(a, m.index!));
  }
  for (const m of cmd.matchAll(/open\(\s*(['"])([^'"]+)\1\s*,\s*['"][wa]b?\+?['"]/g)) targets.push(resolve(m[2], m.index!));
  const onlyLinks = /(^|[;&|(]\s*|&&\s*)ln\s/.test(cmd) && targets.length === 0 && !SHELL_WRITE_PATTERNS.slice(0, 5).some(([re]) => re.test(cmd));
  if (onlyLinks) return "link";
  // A write whose target could not be read (open(p,'w') with p a variable, git mv…) lands where the command ran.
  const opaque = SHELL_WRITE_PATTERNS.slice(0, 5).some(([re]) => re.test(cmd)) && !/open\(\s*['"]/.test(cmd);
  if (opaque || /open\(\s*[A-Za-z_]/.test(cmd)) targets.push(cwd || ".");
  if (targets.length === 0) targets.push(cwd || ".");
  return targets.every((t) => isScratch(t)) ? "scratch" : "project";
}

/** `cd <abs path>` targets in a command (worktree hints; record cwd is often the main checkout). */
function cdTargets(cmd: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[;&|]\s*|&&\s*)cd\s+(['"]?)(\/[^\s'";&|]+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[2]);
  return out;
}

const GIT_COMMIT_RE = /\bgit\b(?:\s+-C\s+\S+)?[^;&|]*?\bcommit\b/;

// ─── Process helpers (read-only git/gh) ─────────────────────────────────────

function run(cmd: string[], cwd?: string, timeoutMs = 10000): { ok: boolean; out: string; err: string } {
  try {
    const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    return { ok: p.exitCode === 0, out: p.stdout.toString(), err: p.stderr.toString().trim() };
  } catch (e) {
    return { ok: false, out: "", err: (e as Error).message };
  }
}

/** Like run(), but does not block: several can be in flight at once (#28). */
async function runAsync(cmd: string[], timeoutMs = 10000): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    return { ok: code === 0, out, err: err.trim() };
  } catch (e) {
    return { ok: false, out: "", err: (e as Error).message };
  }
}

/**
 * `gh pr view` answers, by "repo#number". A merged or closed PR no longer
 * changes, so its answer is kept for the life of the server; an open PR's
 * answer is kept for 60 s. Failures are never cached (#28).
 */
const PR_OPEN_TTL_MS = 60_000;
const prViewCache = new Map<string, { at: number; out: string }>();
export async function ghPrView(number: number, repo: string): Promise<{ ok: boolean; out: string; err: string; cached: boolean }> {
  const key = `${repo}#${number}`;
  const hit = prViewCache.get(key);
  if (hit) {
    let state = "";
    try {
      state = JSON.parse(hit.out).state;
    } catch {
      /* treat as open */
    }
    if (state === "MERGED" || state === "CLOSED" || Date.now() - hit.at < PR_OPEN_TTL_MS) return { ok: true, out: hit.out, err: "", cached: true };
  }
  const r = await runAsync(["gh", "pr", "view", String(number), "--repo", repo, "--json", "headRefOid,state,mergedAt,changedFiles,files,title,isDraft,url"], 20000);
  if (r.ok) prViewCache.set(key, { at: Date.now(), out: r.out });
  return { ...r, cached: false };
}

// ─── Main reader ─────────────────────────────────────────────────────────────

export interface ReplayOptions {
  from?: string | null;
  to?: string | null;
  /** Ask GitHub (`gh pr view`) about linked PRs. Default true. */
  github?: boolean;
  /** Include each note's full text. Default true. */
  fullText?: boolean;
}

interface RawStep extends Omit<ReplayStep, "seq"> {
  sortMs: number;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export async function readReplay(sessionId: string, opts: ReplayOptions = {}): Promise<ReplayResponse> {
  const t0 = performance.now();
  const timings: Record<string, number> = {};
  const fromMs = opts.from ? Date.parse(opts.from) : -Infinity;
  const toMs = opts.to ? Date.parse(opts.to) : Infinity;
  const inWin = (ms: number) => ms >= fromMs && ms < toMs;

  const res: ReplayResponse = {
    timezone: "UTC",
    sessionId,
    window: {
      from: Number.isFinite(fromMs) ? iso(fromMs) : null,
      to: Number.isFinite(toMs) ? iso(toMs) : null,
    },
    transcript: { status: "not-found" },
    sources: {
      hookMeter: { status: "skipped" },
      hookLog: { status: "skipped" },
      git: { status: "skipped" },
      github: { status: "skipped" },
    },
    steps: [],
    notes: { status: "skipped", items: [] },
    changes: { status: "skipped", files: [] },
    commits: [],
    unattributedCommits: [],
    prs: [],
    timingsMs: timings,
  };

  // ── Transcript ──
  const tPath = findTranscript(sessionId);
  const days = retentionDays();
  if (!tPath) {
    res.transcript = {
      status: "not-found",
      retentionDays: days,
      detail:
        `transcript not found: no ${sessionId}.jsonl under ${PROJECTS_DIR}. ` +
        `Claude Code deletes transcripts after ${days} days (cleanupPeriodDays), ` +
        `so an old session's history is gone — this is not "no steps".`,
    };
    res.notes = { status: "not-found", detail: "transcript not found", items: [] };
    res.changes = { status: "not-found", detail: "transcript not found", files: [] };
  }

  const raw: RawStep[] = [];
  const notes: NoteUsed[] = [];
  const prSeen = new Map<string, { number: number; repo: string; first: number; last: number; line: number }>();
  const repoHints = new Set<string>(); // dirs whose git repos may hold this session's commits
  const cwdHints = new Set<string>(); // the records' own cwd values (a subset of repoHints)
  let sessionFirst = Infinity;
  let sessionLast = -Infinity;
  const sessionToolEdits: { path: string; ms: number; ts: string; tool: string }[] = [];

  if (tPath) {
    let text: string;
    try {
      text = readFileSync(tPath, "utf8");
    } catch (e) {
      res.transcript = { status: "unreadable", path: tPath, detail: (e as Error).message, retentionDays: days };
      text = "";
    }
    if (text) {
      const lines = text.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      // Pass 1: parse, record each line's own time.
      const recs: any[] = new Array(lines.length);
      const own: number[] = new Array(lines.length).fill(NaN);
      let parseErrors = 0;
      for (let i = 0; i < lines.length; i++) {
        try {
          recs[i] = JSON.parse(lines[i]);
        } catch {
          recs[i] = null;
          parseErrors++;
          continue;
        }
        const ts = recs[i]?.timestamp;
        if (typeof ts === "string") {
          const ms = Date.parse(ts);
          if (!Number.isNaN(ms)) own[i] = ms;
        }
      }
      // Pass 2: place untimed records at their previous timed neighbour (next if none precede).
      const placed: number[] = own.slice();
      let prev = NaN;
      for (let i = 0; i < placed.length; i++) {
        if (!Number.isNaN(own[i])) prev = own[i];
        else placed[i] = prev;
      }
      let next = NaN;
      for (let i = placed.length - 1; i >= 0; i--) {
        if (!Number.isNaN(own[i])) next = own[i];
        else if (Number.isNaN(placed[i])) placed[i] = next;
      }
      timings.parse = Math.round(performance.now() - t0);

      let untimed = 0;
      let untimedInWindow = 0;
      const untimedByType: Record<string, number> = {};
      let inWindowRecords = 0;

      for (let i = 0; i < recs.length; i++) {
        const r = recs[i];
        if (!r) continue;
        const hasTs = !Number.isNaN(own[i]);
        if (hasTs) {
          sessionFirst = Math.min(sessionFirst, own[i]);
          sessionLast = Math.max(sessionLast, own[i]);
        } else {
          untimed++;
        }
        const at = placed[i];
        // Tool edits from the WHOLE session: a file edited before the window and
        // committed inside it was still edited through a tool that got notes (#29).
        if (r.type === "assistant" && Array.isArray(r.message?.content) && !Number.isNaN(at)) {
          for (const c of r.message.content) {
            const fp = c?.input?.file_path ?? c?.input?.notebook_path;
            if (c?.type === "tool_use" && EDIT_TOOLS.has(String(c.name)) && typeof fp === "string" && isAbsolute(fp))
              sessionToolEdits.push({ path: fp, ms: at, ts: iso(at), tool: String(c.name) });
          }
        }
        if (Number.isNaN(at) || !inWin(at)) continue;
        inWindowRecords++;
        if (!hasTs) {
          untimedInWindow++;
          const k = String(r.type ?? "?");
          untimedByType[k] = (untimedByType[k] ?? 0) + 1;
        }
        const base = {
          ts: hasTs ? (r.timestamp as string) : null,
          placement: hasTs ? ("timestamp" as const) : ("neighbour" as const),
          placedAt: iso(at),
          line: i + 1,
          sortMs: at,
        };
        if (typeof r.cwd === "string") {
          repoHints.add(r.cwd);
          cwdHints.add(r.cwd);
        }

        if (r.type === "assistant" && Array.isArray(r.message?.content)) {
          for (const c of r.message.content) {
            if (c?.type !== "tool_use") continue;
            const input = c.input ?? {};
            const filePath =
              typeof input.file_path === "string"
                ? input.file_path
                : typeof input.notebook_path === "string"
                  ? input.notebook_path
                  : undefined;
            const command = typeof input.command === "string" ? input.command : undefined;
            const step: RawStep = {
              ...base,
              kind: "tool",
              source: "transcript",
              tool: String(c.name ?? "?"),
              toolUseId: typeof c.id === "string" ? c.id : undefined,
            };
            if (filePath) {
              step.filePath = filePath;
              if (isAbsolute(filePath)) repoHints.add(dirname(filePath));
            }
            if (command) {
              step.command = command;
              const why = shellWriteReason(command);
              if (why) step.mayEditFiles = { source: "guessed", reason: why, scope: shellWriteScope(command) };
              for (const d of cdTargets(command)) repoHints.add(d);
            }
            raw.push(step);
          }
        } else if (r.attachment?.type === "hook_additional_context") {
          const a = r.attachment;
          const parts: string[] = Array.isArray(a.content)
            ? a.content.map((x: unknown) => (typeof x === "string" ? x : JSON.stringify(x)))
            : [typeof a.content === "string" ? a.content : JSON.stringify(a.content ?? "")];
          const inline = parts.join("\n");
          const note: NoteUsed = {
            id: notes.length,
            ts: base.ts,
            hookName: String(a.hookName ?? "?"),
            hookEvent: typeof a.hookEvent === "string" ? a.hookEvent : undefined,
            toolUseId: typeof a.toolUseID === "string" ? a.toolUseID : undefined,
            size: Buffer.byteLength(inline),
            preview: inline.slice(0, 400),
            line: i + 1,
          };
          let full = inline;
          const pm = inline.match(/<persisted-output>[\s\S]*?Full output saved to:\s*(\S+additionalContext\.txt)/);
          if (pm) {
            const p = pm[1];
            try {
              full = readFileSync(p, "utf8");
              note.persisted = { path: p, status: "ok" };
              note.size = Buffer.byteLength(full);
            } catch {
              note.persisted = { path: p, status: existsSync(p) ? "unreadable" : "not-found" };
            }
          }
          if (opts.fullText !== false) note.text = full;
          notes.push(note);
          raw.push({ ...base, kind: "injection", source: "transcript", hookName: note.hookName, detail: { noteId: note.id, size: note.size } });
        } else if (r.type === "pr-link" && typeof r.prNumber === "number") {
          const repo = String(r.prRepository ?? "");
          const key = `${repo}#${r.prNumber}`;
          const s = prSeen.get(key);
          if (!s) prSeen.set(key, { number: r.prNumber, repo, first: at, last: at, line: i + 1 });
          else s.last = Math.max(s.last, at);
        }
      }

      res.transcript = {
        status: inWindowRecords ? "ok" : "none",
        path: tPath,
        count: inWindowRecords,
        records: recs.length,
        parseErrors,
        untimedRecords: untimed,
        untimedInWindow,
        untimedByType,
        retentionDays: days,
        detail: inWindowRecords ? undefined : "transcript read; no records in the window",
      };
      res.notes = {
        status: notes.length ? "ok" : "none",
        detail: notes.length ? undefined : "no notes: anvi injected nothing in this window",
        items: notes,
      };
    }
  }
  timings.transcript = Math.round(performance.now() - t0);

  // Link injections to the tool call they rode on.
  const byToolUse = new Map<string, RawStep>();
  for (const s of raw) if (s.kind === "tool" && s.toolUseId) byToolUse.set(s.toolUseId, s);
  for (const n of notes) {
    const s = n.toolUseId ? byToolUse.get(n.toolUseId) : undefined;
    if (s) (s.noteIds ??= []).push(n.id);
  }

  // PR steps (one per PR, at first sight in the window).
  for (const p of prSeen.values()) {
    raw.push({
      ts: iso(p.first),
      placement: "timestamp",
      placedAt: iso(p.first),
      sortMs: p.first,
      line: p.line,
      kind: "pr",
      source: "transcript",
      pr: p.number,
      repo: p.repo,
    });
  }

  // ── Hook meter ──
  const meterPath = join(METER_DIR, `${sessionId}.jsonl`);
  const meterRows: { ts: string; ms: number; hook: string; event: string; bytes: number; dur: number; outcome: string }[] = [];
  if (!existsSync(meterPath)) {
    res.sources.hookMeter = { status: "not-found", path: meterPath };
  } else {
    try {
      for (const l of readFileSync(meterPath, "utf8").split("\n")) {
        if (!l) continue;
        try {
          const r = JSON.parse(l);
          const ms = Date.parse(r.ts);
          if (Number.isNaN(ms) || !inWin(ms)) continue;
          meterRows.push({ ts: r.ts, ms, hook: r.hook, event: r.event, bytes: r.bytes ?? 0, dur: r.ms ?? 0, outcome: r.outcome });
        } catch {
          /* skip a torn row */
        }
      }
      const c = (o: string) => meterRows.filter((r) => r.outcome === o).length;
      res.sources.hookMeter = {
        status: meterRows.length ? "ok" : "none",
        path: meterPath,
        count: meterRows.length,
        informed: c("informed"),
        refused: c("refused"),
        silent: c("silent"),
      };
    } catch (e) {
      res.sources.hookMeter = { status: "unreadable", path: meterPath, detail: (e as Error).message };
    }
  }
  // Join: a meter row's ts is the hook's START; the transcript record lands after it.
  const claimed = joinMeter(notes, meterRows);
  meterRows.forEach((m, idx) => {
    if (claimed.has(idx) || m.outcome === "silent") return;
    raw.push({
      ts: m.ts,
      placement: "timestamp",
      placedAt: m.ts,
      sortMs: m.ms,
      kind: "hook-run",
      source: "hook-meter",
      hookName: `${m.event} (${m.hook})`,
      detail: { outcome: m.outcome, bytes: m.bytes, ms: m.dur, note: "no matching injection record in the transcript" },
    });
  });

  // ── Live hook log ──
  const logPath = HOOK_LOG(sessionId);
  if (!existsSync(logPath)) {
    res.sources.hookLog = { status: "not-found", path: logPath, detail: "no live hook log (it lives in /tmp and is cleared on reboot)" };
  } else {
    try {
      let n = 0;
      for (const l of readFileSync(logPath, "utf8").split("\n")) {
        if (!l) continue;
        try {
          const r = JSON.parse(l);
          const ms = Date.parse(r.ts);
          if (Number.isNaN(ms) || !inWin(ms)) continue;
          n++;
          raw.push({
            ts: r.ts,
            placement: "timestamp",
            placedAt: iso(ms),
            sortMs: ms,
            kind: "hook-run",
            source: "hook-log",
            hookName: "catalogue-context-injector",
            filePath: typeof r.file === "string" ? r.file : undefined,
            detail: {
              boundaries: Array.isArray(r.boundaries) ? r.boundaries.length : 0,
              fatality: !!r.fatality,
              patterns: Array.isArray(r.patterns) ? r.patterns.length : 0,
              invariants: Array.isArray(r.invariants) ? r.invariants.length : 0,
            },
          });
        } catch {
          /* skip a torn row */
        }
      }
      res.sources.hookLog = { status: n ? "ok" : "none", path: logPath, count: n };
    } catch (e) {
      res.sources.hookLog = { status: "unreadable", path: logPath, detail: (e as Error).message };
    }
  }

  // ── Git: commits this session made in the window ──
  // Record cwd is often the main checkout while the work happens in a worktree a
  // command cd'd into, so every hint dir is resolved to its toplevel AND its object
  // store (git common dir). A worktree and its main checkout share one store, so
  // the store is logged once (`--all`) and a commit is matched to the store, not
  // to a path prefix.
  const tGit = performance.now();
  const gitFrom = Number.isFinite(fromMs) ? fromMs : sessionFirst;
  const gitTo = Number.isFinite(toMs) ? toMs : sessionLast;
  const commitSteps = raw.filter((s) => s.kind === "tool" && s.command && GIT_COMMIT_RE.test(s.command));
  const cdDirs = new Set<string>();
  for (const s of raw) if (s.command) for (const d of cdTargets(s.command)) cdDirs.add(d);
  const repoOf = new Map<string, { top: string; store: string } | null>(); // hint dir → repo
  const dirStatus: { dir: string; status: ReadStatus; detail?: string }[] = [];
  const allCommits = new Map<string, CommitInfo & { store: string }>();
  if (tPath && Number.isFinite(gitFrom) && Number.isFinite(gitTo)) {
    const stores = new Map<string, string>(); // store → a toplevel to run git in
    for (const d of repoHints) {
      if (!existsSync(d)) {
        repoOf.set(d, null);
        // Worth saying for where the session ran or cd'd into (worktrees), not every file's parent.
        if (cdDirs.has(d) || cwdHints.has(d))
          dirStatus.push({ dir: d, status: "not-found", detail: "directory no longer exists (worktree removed?)" });
        continue;
      }
      const r = run(["git", "-C", d, "rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"], undefined, 3000);
      const [top, store] = r.ok ? r.out.trim().split("\n") : [];
      if (!top || !store) {
        repoOf.set(d, null);
        // An existing dir that is not a repo is a definite answer: no commits there.
        if (cdDirs.has(d) || cwdHints.has(d)) dirStatus.push({ dir: d, status: "none", detail: "not a git repository" });
        continue;
      }
      repoOf.set(d, { top, store });
      if (!stores.has(store)) stores.set(store, top);
    }
    for (const [store, top] of stores) {
      const r = run(
        [
          "git", "-C", top, "log", "--all", "--no-color",
          `--since=${iso(gitFrom)}`, `--until=${iso(gitTo)}`,
          "--name-status", "--format=%x1e%H%x1f%cI%x1f%s",
        ],
        undefined,
        15000
      );
      if (!r.ok) {
        dirStatus.push({ dir: store, status: "unreadable", detail: r.err.slice(0, 300) });
        continue;
      }
      let n = 0;
      for (const block of r.out.split("\x1e")) {
        if (!block.trim()) continue;
        const [head, ...rest] = block.split("\n");
        const [sha, cI, subject] = head.split("\x1f");
        const committedMs = Date.parse(cI);
        if (Number.isNaN(committedMs) || !inWin(committedMs)) continue;
        n++;
        const files = rest
          .filter((l) => l.trim())
          .map((l) => {
            const parts = l.split("\t");
            return parts.length > 2
              ? { status: parts[0], path: parts[2], oldPath: parts[1] }
              : { status: parts[0], path: parts[1] ?? "" };
          });
        allCommits.set(sha, { sha, committedAt: iso(committedMs), subject, repoDir: top, files, store });
      }
      dirStatus.push({ dir: store, status: n ? "ok" : "none", detail: `${n} commit(s) in the window, all branches` });
    }
    // "none" only if at least one repository was actually logged; if none could be
    // resolved (all gone, or not repos), we could not look — never "nothing found".
    const logged = dirStatus.filter((d) => d.status === "ok" || d.status === "none").length;
    res.sources.git = {
      status: dirStatus.some((d) => d.status === "ok")
        ? "ok"
        : dirStatus.some((d) => d.status === "unreadable")
          ? "unreadable"
          : logged
            ? "none"
            : "not-found",
      count: allCommits.size,
      dirs: dirStatus,
      detail: logged ? undefined : "no git repository could be resolved from the session's directories",
    };
  } else if (tPath) {
    res.sources.git = { status: "none", detail: "no time window and no timed records" };
  } else {
    res.sources.git = { status: "skipped", detail: "transcript not found, so the session's directories are unknown" };
  }

  // Attribute: a commit is this session's when one of its `git commit` steps ran
  // just before it, in the same object store. Others in the window are listed
  // as unattributed (another agent may share the repo), never claimed.
  const usedSteps = new Set<RawStep>();
  const matched = new Map<string, RawStep>();
  const storeOfSha = new Map<string, string>();
  for (const c of [...allCommits.values()].sort((a, b) => a.committedAt.localeCompare(b.committedAt))) {
    const cm = Date.parse(c.committedAt);
    let best: RawStep | null = null;
    let bestTop: string | null = null;
    for (const s of commitSteps) {
      if (usedSteps.has(s)) continue;
      const d = cm - s.sortMs; // %cI is whole seconds: allow 2 s early
      if (d < -2000 || d > 300000) continue;
      const repos = cdTargets(s.command!).map((x) => repoOf.get(x)).filter((x): x is { top: string; store: string } => !!x);
      let top: string | null = null;
      if (repos.length) {
        const hit = repos.find((x) => x.store === c.store);
        if (!hit) continue;
        top = hit.top;
      }
      if (!best || Math.abs(d) < Math.abs(cm - best.sortMs)) {
        best = s;
        bestTop = top;
      }
    }
    const { store, ...info } = c;
    storeOfSha.set(info.sha, store);
    if (best) {
      usedSteps.add(best);
      if (bestTop) info.repoDir = bestTop; // the worktree it was made in
      res.commits.push(info);
      matched.set(info.sha, best);
      raw.push({
        ts: info.committedAt,
        placement: "timestamp",
        placedAt: info.committedAt,
        sortMs: Math.max(cm, best.sortMs) + 1, // just after the command that made it
        kind: "commit",
        source: "commit",
        sha: info.sha,
        subject: info.subject,
        detail: { repoDir: info.repoDir, files: info.files.length, order: "placed just after the command that made it" },
      });
    } else {
      res.unattributedCommits.push(info);
    }
  }
  timings.git = Math.round(performance.now() - tGit);

  // ── Order steps ──
  raw.sort((a, b) => a.sortMs - b.sortMs || (a.line ?? 0) - (b.line ?? 0));
  res.steps = raw.map(({ sortMs, ...s }, seq) => ({ seq, ...s }));
  const seqOf = new Map<RawStep, number>();
  raw.forEach((s, i) => seqOf.set(s, i));
  for (const c of res.commits) {
    const s = matched.get(c.sha);
    if (s) c.matchedStepSeq = seqOf.get(s);
  }

  // ── PRs (GitHub, read-only) ──
  const tGh = performance.now();
  const committedShas = new Set(res.commits.map((c) => c.sha));
  const prFiles = new Map<number, { path: string; additions: number; deletions: number }[]>();
  let ghFailures = 0;
  let ghCached = 0;
  const prList = [...prSeen.values()];
  const views = await Promise.all(
    prList.map((p) => (opts.github !== false && p.repo ? ghPrView(p.number, p.repo) : Promise.resolve(null)))
  );
  prList.forEach((p, i) => {
    const info: PrInfo = {
      number: p.number,
      repo: p.repo,
      firstSeen: iso(p.first),
      lastSeen: iso(p.last),
      read: { status: "skipped" },
    };
    const r = views[i];
    if (r) {
      if (r.cached) ghCached++;
      if (!r.ok) {
        ghFailures++;
        info.read = { status: "unreadable", detail: r.err.slice(0, 300) };
      } else {
        try {
          const j = JSON.parse(r.out);
          info.read = { status: "ok" };
          info.headRefOid = j.headRefOid;
          info.state = j.state;
          info.mergedAt = j.mergedAt || null;
          info.changedFiles = j.changedFiles;
          info.headCommittedInWindow = committedShas.has(j.headRefOid);
          if (info.headCommittedInWindow && Array.isArray(j.files)) prFiles.set(p.number, j.files);
          info.merge = mergeEvidence(p.number, p.repo, info.mergedAt ?? null);
        } catch (e) {
          ghFailures++;
          info.read = { status: "unreadable", detail: (e as Error).message };
        }
      }
    }
    res.prs.push(info);
  });
  res.sources.github =
    opts.github === false
      ? { status: "skipped", detail: "github=0" }
      : prSeen.size === 0
        ? { status: "none", detail: "no PR linked in the window" }
        : {
            status: ghFailures === prSeen.size ? "unreadable" : "ok",
            count: prSeen.size - ghFailures,
            detail: ghCached ? `${ghCached} of ${prSeen.size} PR answer(s) from cache (merged/closed: kept; open: 60 s)` : undefined,
          };
  timings.github = Math.round(performance.now() - tGh);

  // ── Changes ──
  if (tPath && res.transcript.status !== "unreadable") {
    const files = new Map<string, ChangedFile>();
    for (const s of res.steps) {
      if (s.kind !== "tool" || !s.tool || !EDIT_TOOLS.has(s.tool) || !s.filePath) continue;
      if (!files.has(s.filePath)) files.set(s.filePath, { path: s.filePath, how: ["tool"], viaShell: false });
    }
    const prOfSha = new Map<string, PrInfo>();
    for (const p of res.prs) if (p.headRefOid && p.headCommittedInWindow) prOfSha.set(p.headRefOid, p);
    // A tool edit counts for a committed file when it names the same file in the same
    // object store (main checkout vs worktree, /tmp vs /private/tmp) at or before the
    // commit, anywhere in the session (#29). Exact path equality missed all three.
    // Only edits whose file name matches a committed file can match it; resolving
    // every edited folder of a long session costs one git call each (#28).
    const tChanges = performance.now();
    const committedNames = new Set(res.commits.flatMap((c) => c.files.map((f) => basename(f.path))));
    const keyCache = new Map<string, { store: string; top: string } | null>();
    const editsByKey = new Map<string, { path: string; ms: number; ts: string; tool: string }[]>();
    for (const e of sessionToolEdits) {
      if (!committedNames.has(basename(e.path))) continue;
      const k = repoFileKey(e.path, keyCache);
      if (k) (editsByKey.get(k) ?? editsByKey.set(k, []).get(k)!).push(e);
    }
    for (const c of res.commits) {
      const pr = prOfSha.get(c.sha);
      const prF = pr ? prFiles.get(pr.number) : undefined;
      const store = storeOfSha.get(c.sha);
      const cm = Date.parse(c.committedAt);
      for (const f of c.files) {
        const abs = join(c.repoDir, f.path);
        const prior = store
          ? (editsByKey.get(`${realOr(store)}\0${f.path}`) ?? []).filter((x) => x.ms <= cm + 2000)
          : [];
        // Only edits at or before this commit can explain its content; a later edit cannot.
        const e: ChangedFile = files.get(abs) ?? { path: abs, how: [], viaShell: true };
        e.viaShell = prior.length === 0;
        if (prior.length) {
          const last = prior[prior.length - 1];
          e.toolEdit = { path: last.path, ts: last.ts, tool: last.tool };
        }
        if (!e.how.includes("commit")) e.how.push("commit");
        e.status = f.status;
        if (f.oldPath) e.oldPath = f.oldPath;
        e.sha = c.sha;
        const pf = prF?.find((x) => x.path === f.path);
        if (pr && pf) {
          e.how.push("pr");
          e.pr = pr.number;
          e.additions = pf.additions;
          e.deletions = pf.deletions;
        }
        if (e.viaShell) {
          e.notesGap = "no notes given for these files";
          e.designRules = designRulesLabel(pr);
        }
        files.set(abs, e);
      }
    }
    res.changes = {
      status: files.size ? "ok" : "none",
      detail: files.size ? undefined : "no Edit/Write calls and no attributed commits in the window",
      files: [...files.values()],
    };
    timings.changes = Math.round(performance.now() - tChanges);
  }

  timings.total = Math.round(performance.now() - t0);
  return res;
}

/**
 * Give each hook-meter row to the injection it most likely produced: same event,
 * row started within [note − (row ms + 5 s), note + 1 s], and among eligible
 * notes the NEAREST one in time (#30). Rows are taken nearest-pair first, so two
 * same-event injections a few seconds apart cannot swap rows. A note may get
 * several rows (several hooks feed one injection). Returns the claimed row indexes.
 */
export function joinMeter(
  notes: { ts: string | null; hookName: string; meter?: { hook: string; bytes: number; ts: string }[] }[],
  rows: { ts: string; ms: number; hook: string; event: string; bytes: number; dur: number }[]
): Set<number> {
  const pairs: { n: number; r: number; d: number }[] = [];
  notes.forEach((n, ni) => {
    if (!n.ts) return;
    const nm = Date.parse(n.ts);
    const event = n.hookName.split(":")[0];
    rows.forEach((m, ri) => {
      if (m.event !== event || m.bytes === 0) return;
      if (m.ms <= nm + 1000 && m.ms >= nm - (m.dur + 5000)) pairs.push({ n: ni, r: ri, d: Math.abs(nm - m.ms) });
    });
  });
  pairs.sort((a, b) => a.d - b.d);
  const claimed = new Set<number>();
  for (const p of pairs) {
    if (claimed.has(p.r)) continue;
    claimed.add(p.r);
    const m = rows[p.r];
    (notes[p.n].meter ??= []).push({ hook: m.hook, bytes: m.bytes, ts: m.ts });
  }
  for (const n of notes) n.meter?.sort((a, b) => a.ts.localeCompare(b.ts));
  return claimed;
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * "<object store>\0<repo-relative path>" for an absolute file path, or null when it
 * is not inside a git repository. A worktree and its main checkout share one store,
 * so the same file reached through either gets the same key (#29).
 */
export function repoFileKey(absPath: string, cache = new Map<string, { store: string; top: string } | null>()): string | null {
  let dir = dirname(absPath);
  const rest = [basename(absPath)];
  while (!existsSync(dir) && dir !== dirname(dir)) {
    rest.unshift(basename(dir));
    dir = dirname(dir);
  }
  const real = realOr(dir);
  let repo = cache.get(real);
  if (repo === undefined) {
    const r = run(["git", "-C", real, "rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"], undefined, 3000);
    const [top, store] = r.ok ? r.out.trim().split("\n") : [];
    repo = top && store ? { top: realOr(top), store: realOr(store) } : null;
    cache.set(real, repo);
  }
  if (!repo) return null;
  const rel = relative(repo.top, join(real, ...rest));
  return rel.startsWith("..") ? null : `${repo.store}\0${rel}`;
}

/** The design-rules label for a file changed only through the shell. */
function designRulesLabel(pr: PrInfo | undefined): string {
  const notAtEdit = "checked at merge, not at edit";
  if (!pr) return "not checked at edit; no linked PR found, so no merge check can be shown";
  const m = pr.merge;
  if (!m || m.how === "unknown") return `not checked at edit; could not tell how PR #${pr.number} was merged`;
  if (m.how === "not-merged") return `not checked at edit; PR #${pr.number} not merged yet (checked at merge only if merged with gh pr merge in a Claude session)`;
  if (m.how === "no-hook-run")
    return `not checked at edit, and no merge-hook run was found for PR #${pr.number} (merged outside a Claude session?)`;
  let s = `${notAtEdit} (PR #${pr.number} merged with gh pr merge in Claude session ${m.sessionId})`;
  if (m.judgementRow === "none") s += "; the merge hook ran but wrote no judgement row for this PR";
  return s;
}

/**
 * How a PR was merged, from local evidence.
 *
 * A structure-merge-hook.js run in the hook meter is only a POINTER to a
 * candidate session: the hook is registered `"if": "Bash(gh pr merge:*)"`
 * (~/.claude/settings.json), but a Claude Code version that ignores `if` runs it
 * for every Bash call (structure-merge-hook.js header, "WHAT IT COSTS"), and the
 * meter holds thousands of its rows. So the merge is confirmed only by the
 * candidate session's own transcript: a Bash `gh pr merge` naming this PR,
 * shortly before GitHub's `mergedAt`.
 */
export function mergeEvidence(pr: number, repo: string, mergedAt: string | null): MergeEvidence {
  if (!mergedAt) return { how: "not-merged" };
  const mm = Date.parse(mergedAt);
  if (Number.isNaN(mm)) return { how: "unknown", detail: `unreadable mergedAt "${mergedAt}"` };
  const BEFORE = 600000; // a merge command may wait on checks; look 10 min back
  const AFTER = 60000; // clocks differ (local vs GitHub)
  let files: string[];
  try {
    files = readdirSync(METER_DIR).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return { how: "unknown", detail: `could not read ${METER_DIR}` };
  }
  // 1. Candidate sessions: any merge-hook run in the window.
  const candidates = new Map<string, string>(); // sid → nearest hook-run ts
  for (const f of files) {
    const p = join(METER_DIR, f);
    try {
      if (statSync(p).mtimeMs < mm - BEFORE) continue; // last written before the window
      for (const l of readFileSync(p, "utf8").split("\n")) {
        if (!l.includes("structure-merge-hook")) continue;
        try {
          const r = JSON.parse(l);
          const d = mm - Date.parse(r.ts);
          if (d < -AFTER || d > BEFORE || typeof r.sid !== "string") continue;
          const prev = candidates.get(r.sid);
          if (!prev || Math.abs(d) < Math.abs(mm - Date.parse(prev))) candidates.set(r.sid, r.ts);
        } catch {
          /* torn row */
        }
      }
    } catch {
      /* unreadable meter file: skip */
    }
  }
  if (candidates.size === 0)
    return { how: "no-hook-run", detail: "no structure-merge-hook.js run metered in the 10 min before mergedAt (merged outside a Claude session?)" };

  // 2. Confirm in each candidate's transcript.
  const prRe = new RegExp(`(^|[^0-9])${pr}([^0-9]|$)`);
  const repoName = repo.split("/").pop()?.toLowerCase() ?? "";
  const unverifiable: string[] = [];
  for (const [sid, hookTs] of [...candidates].sort((a, b) => Math.abs(mm - Date.parse(a[1])) - Math.abs(mm - Date.parse(b[1])))) {
    const t = isValidSid(sid) ? findTranscript(sid) : null;
    if (!t) {
      unverifiable.push(sid);
      continue;
    }
    let text: string;
    try {
      text = readFileSync(t, "utf8");
    } catch {
      unverifiable.push(sid);
      continue;
    }
    for (const l of text.split("\n")) {
      if (!l.includes("gh pr merge")) continue;
      let r: any;
      try {
        r = JSON.parse(l);
      } catch {
        continue;
      }
      const at = Date.parse(r?.timestamp);
      if (r?.type !== "assistant" || Number.isNaN(at) || mm - at < -AFTER || mm - at > BEFORE) continue;
      for (const c of r.message?.content ?? []) {
        const cmd = c?.type === "tool_use" ? c.input?.command : null;
        if (typeof cmd !== "string") continue;
        for (const seg of cmd.split(/&&|\|\||;|\n/)) {
          if (!/\bgh\s+pr\s+merge\b/.test(seg) || !prRe.test(seg)) continue;
          // A --repo/-R flag must name this repo; without one the cwd decides (accepted).
          const rm = seg.match(/(?:--repo|-R)[=\s]+(\S+)/);
          if (rm && !rm[1].toLowerCase().endsWith(repoName)) continue;
          return {
            how: "claude-session",
            sessionId: sid,
            hookRunAt: hookTs,
            commandAt: r.timestamp,
            judgementRow: judgementRowFor(pr, sid),
          };
        }
      }
    }
  }
  return {
    how: "unknown",
    detail:
      `merge-hook runs were metered near mergedAt in ${candidates.size} session(s), but no transcript shows ` +
      `\`gh pr merge\` for #${pr}` + (unverifiable.length ? `; ${unverifiable.length} transcript(s) not found` : ""),
  };
}

/**
 * Did the merge hook, run in the merging session, write a judgement row for
 * this PR? A row only counts when both its `pr` AND its `session` match: rows
 * for the same PR written by another run (a later probe or a re-check, e.g.
 * session "probe-702-control") say nothing about the merge itself.
 */
export function judgementRowFor(
  pr: number,
  sessionId: string,
  logText?: string
): MergeEvidence["judgementRow"] {
  let text: string;
  try {
    text = logText ?? readFileSync(MERGE_LOG, "utf8");
  } catch {
    return "could-not-read";
  }
  return text
    .split("\n")
    .filter(Boolean)
    .some((l) => {
      try {
        const row = JSON.parse(l);
        return row.pr === pr && row.session === sessionId;
      } catch {
        return false;
      }
    })
    ? "found"
    : "none";
}

export type { StepSource, SourceStatus, ReplaySessionSummary };
