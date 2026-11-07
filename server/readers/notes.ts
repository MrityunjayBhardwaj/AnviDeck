import { spawn } from "node:child_process";
import { settleAfterExit } from "../child-output";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
  CurrencyAnswer,
  CurrencyCounts,
  CurrencyEntry,
  GtCheckAnswer,
  GtDocCheck,
  SnapshotPoint,
  SnapshotSeries,
  UsageAnswer,
} from "../../shared/notes-types";
import { findAnviDir } from "./catalogue";
import { HEALTH_DIR } from "./home";
import { encodeCwd } from "./replay";
import { errText, isAbsent } from "./read-status";

/**
 * The Notes screen's readers (#89). Read only:
 *   - currency:  anvi's own instrument, `node ~/.claude/anvi/scripts/currency-report.js --json
 *                <project>`, run in the background and kept until asked again. Its counts are
 *                shown as it prints them; AnviDeck never recomputes a verdict (a second
 *                instrument for one question is how two answers come to disagree).
 *                The report only reads (git log/diff/show in the project and the store).
 *   - snapshots: the fleet health series, health-<date>.json in HEALTH_DIR (written by anvi's
 *                catalogue-health.js --write), for one project.
 *   - grounding: anvi's `gt-citation-check.js <ref> --json` (sections that cite code, or say why not).
 *   - usage:     the catalogue-context injector's log lines, /tmp/anvi-hook-<sid>.log, for
 *                sessions whose transcript is in this project's folder (or its worktrees').
 */

const HOME = homedir();
export const CURRENCY_REPORT =
  process.env.ANVIDECK_CURRENCY_REPORT ?? join(HOME, ".claude", "anvi", "scripts", "currency-report.js");
const PROJECTS_DIR = join(HOME, ".claude", "projects");
export const HOOK_LOG_DIR = process.env.ANVIDECK_HOOK_LOG_DIR ?? "/tmp";

// ── Currency: anvi's report, run once per project and kept ───────────────────────────────

/** A large catalogue takes minutes (anvi's 450 entries: over 5 min on 2026-11-05). */
const CURRENCY_TIMEOUT_MS = 20 * 60_000;

export interface Spawned {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}
export type SpawnFn = (cmd: string, args: string[], timeoutMs: number) => Promise<Spawned>;

export const spawnCollect: SpawnFn = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    let out = "";
    let err = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd: HOME, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, error: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout: out, stderr: err, timedOut, error: e.message });
    });
    settleAfterExit(child, cmd, (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err, timedOut });
    });
  });

const ZERO: CurrencyCounts = { GREEN: 0, YELLOW: 0, RED: 0, GRAY: 0, REFERENCE: 0, WITHHELD: 0 };

/**
 * Turn one run of the report into an answer. Exit 0 with JSON → ok; exit 2 → none (no
 * catalogues); exit 3 → withheld; anything else, a timeout, or output that is not the report's
 * JSON → unreadable, with the reason. Never "ok with zero entries" for a run that failed.
 */
export function currencyFromRun(base: Pick<CurrencyAnswer, "project" | "path" | "command" | "startedAt">, run: Spawned, ranAt: string): CurrencyAnswer {
  const out: CurrencyAnswer = { ...base, state: "unreadable", ranAt };
  const said = (run.stderr || run.stdout).trim().split("\n").slice(0, 3).join(" ").slice(0, 400);
  if (run.timedOut) return { ...out, reason: `the report did not finish in ${CURRENCY_TIMEOUT_MS / 60_000} minutes and was stopped` };
  if (run.error) return { ...out, reason: run.error };
  if (run.code === 2) return { ...out, state: "none", reason: said || "the report found no catalogues" };
  if (run.code === 3) return { ...out, state: "withheld", reason: said || "the report refused to read the catalogues" };
  if (run.code !== 0) return { ...out, reason: `exit ${run.code}${said ? `: ${said}` : ""}` };
  let j: any;
  try {
    j = JSON.parse(run.stdout);
  } catch (e) {
    return { ...out, reason: `the report's output is not JSON (${(e as Error).message})` };
  }
  if (!j || typeof j !== "object" || !Array.isArray(j.entries) || typeof j.examined !== "number" || !j.counts) {
    return { ...out, reason: "the report's JSON has no examined/counts/entries" };
  }
  const entries: CurrencyEntry[] = j.entries.map((e: any) => ({
    catalogue: String(e.catalogue ?? ""),
    id: String(e.id ?? ""),
    status: String(e.status ?? ""),
    state: String(e.state ?? ""),
    drifted: Array.isArray(e.drifted) ? e.drifted.map(String) : [],
    // The report joins gone files with ", " (currency-report.js: `unresolvedAll…join(', ')`).
    gone: typeof e.gone === "string" && e.gone ? e.gone.split(", ") : Array.isArray(e.gone) ? e.gone.map(String) : null,
    anchor: String(e.anchor ?? ""),
    ...(e.not_checked ? { not_checked: String(e.not_checked) } : {}),
    ...(e.partial === true ? { partial: true } : {}),
  }));
  const counts = { ...ZERO };
  for (const k of Object.keys(ZERO) as (keyof CurrencyCounts)[]) counts[k] = Number(j.counts[k]) || 0;
  const states: Record<string, number> = {};
  for (const k of ["primaries", "verified", "drifted", "never confirmed", "not checked"]) {
    if (typeof j.states?.[k] === "number") states[k] = j.states[k];
  }
  // Kept, not dropped: a run over part of the evidence must not read as a complete one.
  const partial = Number(j.partial) || 0;
  const withheldKinds = Array.isArray(j.withheld_kinds) ? j.withheld_kinds.map(String) : [];
  return { ...out, state: "ok", examined: j.examined, counts, states, entries, partial, withheldKinds };
}

interface Job {
  answer: CurrencyAnswer;
  running: Promise<CurrencyAnswer> | null;
}
const jobs = new Map<string, Job>();

/**
 * anvi's currency report for `path`. The first call starts the run and answers "measuring";
 * later calls answer the last finished run (or "measuring" while one is running). `refresh`
 * starts a new run unless one is running; the last answer is kept meanwhile.
 */
export function readCurrency(
  project: string,
  path: string,
  opts: { refresh?: boolean; spawnFn?: SpawnFn; script?: string; now?: () => Date } = {},
): CurrencyAnswer {
  const script = opts.script ?? CURRENCY_REPORT;
  const now = opts.now ?? (() => new Date());
  const command = `node ${script.replace(HOME, "~")} --json ${path}`;
  const job = jobs.get(path);
  if (job && (job.running || !opts.refresh)) return shown(job);
  const startedAt = now().toISOString();
  const base = { project, path, command, startedAt };
  const measuring: CurrencyAnswer = { ...base, state: "measuring", ranAt: null };
  const next: Job = { answer: job?.answer ?? measuring, running: null };
  next.running = (opts.spawnFn ?? spawnCollect)("node", [script, "--json", path], CURRENCY_TIMEOUT_MS).then((r) => {
    const a = currencyFromRun(base, r, now().toISOString());
    next.answer = a;
    next.running = null;
    return a;
  });
  jobs.set(path, next);
  return shown(next);
}

/** The last finished answer, marked when a newer run is going. */
function shown(j: Job): CurrencyAnswer {
  return j.running && j.answer.state !== "measuring" ? { ...j.answer, measuringAgain: true } : j.answer;
}

/** Wait for a running report (tests). */
export async function currencySettled(path: string): Promise<CurrencyAnswer | null> {
  const j = jobs.get(path);
  if (!j) return null;
  return j.running ? await j.running : j.answer;
}

export function forgetCurrency(): void {
  jobs.clear();
}

// ── The fleet snapshots, for one project ─────────────────────────────────────────────────

/**
 * The key the snapshots use for a project: the store folder its catalogues really live in
 * (~/.anvideck/projects/<key>/.anvi), else the project's own name.
 */
export function snapshotKey(projectName: string, projectPath: string): string {
  const anvi = findAnviDir(projectPath);
  if (!anvi) return projectName;
  let real = anvi;
  try {
    real = realpathSync(anvi);
  } catch {
    /* keep the path as found */
  }
  const store = join(HOME, ".anvideck", "projects") + "/";
  if (real.startsWith(store) && basename(real) === ".anvi") return basename(dirname(real));
  return projectName;
}

/** Every health-<date>.json in `dir`, oldest first, with this project's out-of-date figures. */
export function readSnapshotSeries(key: string, dir = HEALTH_DIR): SnapshotSeries {
  const out: SnapshotSeries = { key, dir, status: "none", points: [], notMeasuredIn: [], errors: [] };
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^health-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  } catch (e) {
    if (!isAbsent(e)) {
      out.status = "unreadable";
      out.errors.push(errText(dir, e));
    }
    return out;
  }
  for (const f of files) {
    const file = join(dir, f);
    let d: any;
    try {
      d = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      out.errors.push(errText(file, e));
      continue;
    }
    const p = d?.projects?.[key];
    const date = String(d?.date ?? f.slice(7, 17));
    if (!p) {
      out.notMeasuredIn.push(date);
      continue;
    }
    out.points.push({
      date,
      file,
      examined: Number(p.examined) || 0,
      yellow: Number(p.counts?.YELLOW) || 0,
      red: Number(p.counts?.RED) || 0,
    } satisfies SnapshotPoint);
  }
  out.status = out.errors.length ? (out.points.length ? "partial" : "unreadable") : out.points.length ? "ok" : "none";
  return out;
}

// ── Injector deliveries, for one project's sessions ──────────────────────────────────────

/**
 * Which project a session belongs to: the transcript folder it is in. A worktree's folder is
 * the project's encoded path plus "-…", so the longest known project whose encoded path is the
 * folder name or a "-" prefix of it wins (so "AnviDeck" never takes "AnviDeck-x"'s sessions
 * when AnviDeck-x is itself a known project).
 */
export function ownerOf(folder: string, knownEncoded: string[]): string | null {
  let best: string | null = null;
  for (const k of knownEncoded) {
    if (folder === k || folder.startsWith(k + "-")) if (!best || k.length > best.length) best = k;
  }
  return best;
}

/** Transcript folders, read once per call: sid → folder. */
function sessionFolders(projectsDir: string): Map<string, string> {
  const m = new Map<string, string>();
  let dirs: string[] = [];
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    return m;
  }
  for (const d of dirs) {
    let files: string[] = [];
    try {
      files = readdirSync(join(projectsDir, d));
    } catch {
      continue;
    }
    for (const f of files) if (f.endsWith(".jsonl")) m.set(f.slice(0, -6), d);
  }
  return m;
}

export function readUsage(
  project: string,
  projectPath: string,
  knownPaths: string[],
  opts: { days?: number; now?: Date; logDir?: string; projectsDir?: string } = {},
): UsageAnswer {
  const days = opts.days ?? 30;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - days * 86_400_000);
  const logDir = opts.logDir ?? HOOK_LOG_DIR;
  const out: UsageAnswer = {
    project,
    since: since.toISOString(),
    days,
    coveredFrom: null,
    status: "none",
    errors: [],
    logsRead: 0,
    sessions: 0,
    edits: 0,
    delivered: { hetvabhasa: 0, vyapti: 0, dharana: 0 },
    uses: {},
    malformed: 0,
  };
  let files: string[];
  try {
    files = readdirSync(logDir).filter((f) => f.startsWith("anvi-hook-") && f.endsWith(".log"));
  } catch (e) {
    out.status = isAbsent(e) ? "none" : "unreadable";
    if (!isAbsent(e)) out.errors.push(errText(logDir, e));
    return out;
  }
  const mine = encodeCwd(projectPath);
  const known = [...new Set([...knownPaths, projectPath].map(encodeCwd))];
  const folders = sessionFolders(opts.projectsDir ?? PROJECTS_DIR);
  const seen = new Set<string>();
  const add = (key: string) => (out.uses[key] = (out.uses[key] ?? 0) + 1);
  // The oldest moment any log reaches: the window shown is from here, not `days` ago.
  let earliest = Infinity;
  for (const f of files) {
    const file = join(logDir, f);
    let text: string;
    try {
      const mtime = statSync(file).mtimeMs;
      if (mtime < since.getTime()) {
        out.logsRead++;
        earliest = Math.min(earliest, mtime); // it reaches back before the window
        continue; // nothing in it is newer than the window
      }
      text = readFileSync(file, "utf8");
    } catch (e) {
      if (!isAbsent(e)) out.errors.push(errText(file, e));
      continue;
    }
    out.logsRead++;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let r: any;
      try {
        r = JSON.parse(line);
      } catch {
        out.malformed++;
        continue;
      }
      const ts = Date.parse(r?.ts ?? "");
      if (!Number.isNaN(ts)) earliest = Math.min(earliest, ts);
      if (Number.isNaN(ts) || ts < since.getTime() || ts > now.getTime()) continue;
      const folder = folders.get(String(r?.sid ?? ""));
      if (!folder || ownerOf(folder, known) !== mine) continue;
      seen.add(r.sid);
      out.edits++;
      for (const id of Array.isArray(r.patterns) ? r.patterns : []) (out.delivered.hetvabhasa++, add(`hetvabhasa/${id}`));
      for (const id of Array.isArray(r.invariants) ? r.invariants : []) (out.delivered.vyapti++, add(`vyapti/${id}`));
      for (const id of Array.isArray(r.boundaries) ? r.boundaries : []) (out.delivered.dharana++, add(`dharana/${id}`));
    }
  }
  out.sessions = seen.size;
  if (earliest !== Infinity) out.coveredFrom = new Date(Math.max(earliest, since.getTime())).toISOString();
  out.status = out.errors.length ? (out.logsRead ? "partial" : "unreadable") : out.logsRead ? "ok" : "none";
  return out;
}

// ── Ground Truth docs, as anvi's citation check measures them ────────────────────────────

export const GT_CHECK =
  process.env.ANVIDECK_GT_CHECK ?? join(HOME, ".claude", "anvi", "scripts", "gt-citation-check.js");

/** Turn one run of `gt-citation-check.js <ref> --json` into an answer (exit 0/1 measured, 2 not). */
export function gtCheckFromRun(refDir: string, command: string, run: Spawned, ranAt: string): GtCheckAnswer {
  const out: GtCheckAnswer = { state: "not-measured", command, refDir, ranAt, docs: [] };
  const said = (run.stderr || run.stdout).trim().split("\n")[0]?.slice(0, 300) ?? "";
  if (run.timedOut) return { ...out, reason: "the check did not finish in time and was stopped" };
  if (run.error) return { ...out, reason: run.error };
  if (run.code !== 0 && run.code !== 1) return { ...out, reason: said || `exit ${run.code}` };
  let j: any;
  try {
    j = JSON.parse(run.stdout);
  } catch (e) {
    return { ...out, reason: `the check's output is not JSON (${(e as Error).message})` };
  }
  if (!Array.isArray(j)) return { ...out, reason: "the check's JSON is not a list of docs" };
  const docs: GtDocCheck[] = j.map((d: any) => {
    const all: any[] = Array.isArray(d?.sections) ? d.sections : [];
    const secs = all.filter((s) => s?.verdict !== "preamble");
    const n = (v: string) => secs.filter((s) => s.verdict === v).length;
    const file = basename(String(d?.doc ?? ""));
    return {
      doc: String(d?.doc ?? ""),
      system: file.replace(/^GROUND_TRUTH_/, "").replace(/\.md$/, ""),
      sections: secs.length,
      cited: n("cited"),
      uncitable: n("uncitable"),
      missing: secs.length - n("cited") - n("uncitable"),
      citations: all.reduce((a: number, s) => a + (Number(s?.citations) || 0), 0),
    };
  });
  return { ...out, state: run.code === 1 ? "missing" : "ok", docs };
}

export async function readGtCheck(refDir: string | null, opts: { spawnFn?: SpawnFn; script?: string; now?: () => Date } = {}): Promise<GtCheckAnswer> {
  const now = opts.now ?? (() => new Date());
  if (!refDir) return { state: "none", command: null, refDir: null, ranAt: now().toISOString(), docs: [] };
  const script = opts.script ?? GT_CHECK;
  const command = `node ${script.replace(HOME, "~")} ${refDir} --json`;
  const r = await (opts.spawnFn ?? spawnCollect)("node", [script, refDir, "--json"], 60_000);
  return gtCheckFromRun(refDir, command, r, now().toISOString());
}
