/**
 * What the design guard refused, read by anvi's own instrument (#86).
 *
 * The source is ~/.claude/anvi/scripts/structure-refusals.js (its header says what it reads and
 * why), run under node the way server/readers/structure.ts runs the structure guard. This reader
 * finds the project's registered package, runs the instrument once per window, caches the answer
 * (it reads every transcript on the machine: minutes, not seconds), and shapes it. Every count is
 * the instrument's: its --json report (sent to a pipe on fd 3, never to a file) gives the calls
 * and their outcomes, its text report gives the notice line and the trial reading verbatim, and
 * its exported readTranscript gives back the guard's words for each refusal
 * (refusals-driver.cjs), because the --json report drops them.
 *
 * Read-only: it writes nothing into any project or the store. The instrument's default-branch
 * section makes a temporary `git archive` under TMPDIR. Each run gets a folder of its own under the
 * structure reader's scratch folder (TMP_ROOT) as its TMPDIR, removed when the run ends, so a run
 * stopped at the time limit (which skips the instrument's own cleanup) leaves nothing behind.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { driverArgs, feedDriver, type DriverName } from "./node-drivers";
import { listStructure, TMP_ROOT } from "./structure";
import { readCalls } from "./calls";
import type {
  Refusal,
  RefusalCache,
  RefusalEdit,
  RefusalInstrument,
  RefusalsResponse,
  RefusalTotals,
  RefusalWindow,
  RefusalCallState,
  RefusalsMeasured,
  CallsRead,
} from "../../shared/refusal-types";

const HOME = process.env.HOME ?? homedir();
export const REFUSALS_SCRIPT = process.env.ANVIDECK_REFUSALS_SCRIPT ?? join(HOME, ".claude", "anvi", "scripts", "structure-refusals.js");
/** The instrument reads every transcript on the machine: 3 min 17 s on 4,404 transcripts (2026-11-05). */
const RUN_TIMEOUT_MS = 10 * 60_000;
export const CACHE_TTL_MS = 15 * 60_000;
/** A run that could not be read is tried again after this, not after CACHE_TTL_MS. */
export const RETRY_MS = 60_000;
/** The window when none is asked: the last 30 days, from midnight UTC, so the cache key holds all day. */
export const DEFAULT_DAYS = 30;

/** What each exit means, from the instrument's own header ("Exit:"). */
export function exitMeaning(code: number | null): string {
  if (code === 1) return "a person must read something: a refusal (right or wrong?), a missed chance, or a possible chance";
  if (code === 2) return "not measured: no transcripts, no edit in the package in the window, a denial in a shape it does not know, or no design to compute exposure with";
  if (code === 3) return "untested: no chance to refuse in the window";
  return code === null ? "killed before it exited" : `exit ${code}, which the instrument's header does not define`;
}

export class RefusalsError extends Error {
  constructor(readonly status: 400, message: string) {
    super(message);
  }
}

export function defaultSince(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - DEFAULT_DAYS);
  return d.toISOString();
}

function isoOf(s: string, name: string): string {
  const d = new Date(s);
  if (!/^\d{4}-\d{2}-\d{2}/.test(s) || isNaN(d.getTime())) throw new RefusalsError(400, `${name} is not a time: ${JSON.stringify(s)}`);
  return d.toISOString();
}

/** `?since=all`: every refusal the transcripts hold (#193). */
export const ALL_TIME = "1970-01-01T00:00:00.000Z";

export function windowOf(since: string | null | undefined, until: string | null | undefined, now: Date = new Date()): RefusalWindow {
  return {
    since: since === "all" ? ALL_TIME : since ? isoOf(since, "since") : defaultSince(now),
    until: until ? isoOf(until, "until") : null,
    chosenBy: since === "all" ? "all time (?since=all)" : since ? "?since" : `the last ${DEFAULT_DAYS} days (from midnight UTC)`,
  };
}

// ── the package ────────────────────────────────────────────────────────────────────────────

export type PackagePick = { dir: string } | { response: RefusalsResponse; notFound?: boolean };

/** The project's package registered with the structure guard, as the structure reader finds it. */
export function packageOf(project: string, opts: { path?: string | null; package?: string | null; registry?: { locked?: string; user?: string } } = {}): PackagePick {
  const list = listStructure({ registry: opts.registry });
  if (list.status !== "ok") return { response: { status: "unreadable", project, reason: list.reason ?? "the structure registry could not be read" } };
  let named = list.projects.filter((p) => p.name === project);
  if (!named.length) return { notFound: true, response: { status: "unreadable", project, reason: `no project named ${project} is known (~/.claude/projects or the structure registry)` } };
  if (opts.path) named = named.filter((p) => p.path === opts.path);
  if (named.length !== 1)
    return { response: { status: "not-measured", project, reason: named.length
      ? `${named.length} projects are named ${project} — pass ?path=<dir> to name one: ${named.map((p) => p.path).join(", ")}`
      : `${opts.path} is not a project named ${project}` } };
  const p = named[0];
  if (!p.hasDesign)
    return { response: { status: "no-design", project, reason: `${project} has no package registered with the structure guard, so no edit there is judged or refused (this is not "0 refusals")` } };
  let pk = p.packages;
  if (opts.package) pk = pk.filter((e) => e.dir === opts.package);
  if (pk.length !== 1)
    return { response: { status: "not-measured", project, reason: pk.length
      ? `${project} has ${pk.length} registered packages — pass ?package=<dir> to name one: ${pk.map((e) => e.dir).join(", ")}`
      : `${opts.package} is not a registered package of ${project}` } };
  return { dir: pk[0].dir };
}

// ── running the instrument ─────────────────────────────────────────────────────────────────

interface Spawned { code: number | null; signal: string | null; stdout: string; stderr: string; fd3: string; ms: number; startError?: string; fd3Error?: string }

/** TMPDIR for one run: a folder of its own under TMP_ROOT, removed by done() when the run ends. */
function scratchTmp(): { dir: string; done: () => void } {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, "refusals-run-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function spawnNode(args: string[], withFd3: boolean, timeoutMs: number, driver?: DriverName): Promise<Spawned> {
  const tmp = scratchTmp();
  const t0 = Date.now();
  return new Promise<Spawned>((resolve) => {
    let child: ReturnType<typeof spawn> | undefined;
    let stdout = "", stderr = "", fd3 = "";
    let fd3Error: string | undefined;
    try {
      child = spawn("node", args, {
        env: { ...process.env, TMPDIR: tmp.dir },
        stdio: withFd3 ? [driver ? "pipe" : "ignore", "pipe", "pipe", "pipe"] : [driver ? "pipe" : "ignore", "pipe", "pipe"],
      });
      if (driver) feedDriver(child.stdin, driver);
      child.stdout!.on("data", (d) => (stdout += d));
      child.stderr!.on("data", (d) => (stderr += d));
      if (withFd3) {
        const s3 = child.stdio[3] as NodeJS.ReadableStream;
        s3.on("data", (d) => (fd3 += d));
        // Bun (1.3.10) sets the extra pipe up with a socket connect that fails now and then ("Failed to
        // connect", ENOENT): 6 of 100 spawns in a row on an idle machine, 2026-11-05 (#219). Its report is
        // then lost; said below, never an unhandled error and never read as "no report".
        s3.on("error", (e: Error) => (fd3Error = e.message));
      }
    } catch (e) {
      // Seen under heavy load (2026-11-05): Bun's spawn threw ENOENT setting up the fd 3 pipe. Said, not thrown.
      child?.kill("SIGKILL");
      resolve({ code: null, signal: null, stdout, stderr, fd3, ms: Date.now() - t0, startError: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr, fd3, ms: Date.now() - t0, startError: e.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, fd3, ms: Date.now() - t0, ...(fd3Error ? { fd3Error } : {}) });
    });
  }).finally(tmp.done);
}

function scriptIdentity(path: string): { sha256: string; mtime: string } | { error: string } {
  try {
    return { sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), mtime: statSync(path).mtime.toISOString() };
  } catch (e) {
    return { error: `cannot read the instrument ${path}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` };
  }
}

const firstError = (stderr: string) => {
  const lines = stderr.trim().split("\n").filter(Boolean);
  return lines.find((l) => /Error/.test(l)) ?? lines[0] ?? "";
};

/** "  notices said (not refused): on disk 1 · fixed 12 · …" → { "on disk": 1, fixed: 12, … }, every kind listed. */
export function noticesFrom(report: string): Record<string, number> | null {
  const line = report.split("\n").find((l) => /^\s*notices said \(not refused\):/.test(l));
  if (!line) return null;
  const out: Record<string, number> = {};
  for (const part of line.replace(/^\s*notices said \(not refused\):\s*/, "").split(" · ")) {
    const m = /^(.*\S)\s+(\d+)$/.exec(part.trim());
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

/** The instrument's stop() reasons about its own arguments (structure-refusals.js main), not about the data. */
export const ARGUMENT_REFUSED = /^\s*(?:unrecognised argument|--[\w-]+ is required|--[\w-]+ is not a time|--[\w-]+ \S.* needs a package)/;

const OUTCOME: Record<string, keyof RefusalTotals> = {
  applied: "applied",
  refused: "refused",
  "refused by the check": "refusedByCheckAlone",
  "denied otherwise": "deniedOtherwise",
  errored: "erroredOtherwise",
  "no result": "noResult",
  "timed out": "timedOut",
  cancelled: "cancelled",
  unrecognised: "unrecognised",
};

export interface RunOptions {
  script?: string;
  /** --transcripts (the tests point it at fixtures); default: the instrument's own (~/.claude/projects). */
  transcripts?: string | null;
  timeoutMs?: number;
}

/** Run the instrument once on one package and window, and shape its answer (without the cache and calls). */
export async function runInstrument(project: string, pkgDir: string, win: RefusalWindow, opts: RunOptions = {}): Promise<RefusalsResponse> {
  const script = opts.script ?? REFUSALS_SCRIPT;
  const id = scriptIdentity(script);
  const args = ["--package", pkgDir, "--since", win.since, ...(win.until ? ["--until", win.until] : []),
    ...(opts.transcripts ? ["--transcripts", opts.transcripts] : []), "--json", "/dev/fd/3"];
  const ranAt = new Date().toISOString();
  if ("error" in id) return { status: "unreadable", project, package: pkgDir, window: win, instrument: { name: "structure-refusals.js", path: script, args, ranAt }, reason: id.error };
  const run = await spawnNode([script, ...args], true, opts.timeoutMs ?? RUN_TIMEOUT_MS);
  const instrument: RefusalInstrument = { name: "structure-refusals.js", path: script, sha256: id.sha256, mtime: id.mtime, args, ranAt, ms: run.ms, exit: run.code, exitMeaning: exitMeaning(run.code) };
  const base = { project, package: pkgDir, window: win, instrument };
  if (run.startError) return { status: "unreadable", ...base, reason: `could not start node to run the instrument: ${run.startError}` };
  if (run.signal) return { status: "unreadable", ...base, reason: `the instrument was stopped by ${run.signal}${run.ms >= (opts.timeoutMs ?? RUN_TIMEOUT_MS) ? ` after ${Math.round(run.ms / 1000)} s (the time limit)` : ""}` };
  const report = run.stdout;
  if (run.fd3Error && !run.fd3.trim())
    return { status: "unreadable", ...base, reason: `the pipe the instrument writes its --json report to (fd 3) failed: ${run.fd3Error}; ask again` };
  if (!run.fd3.trim()) {
    // The instrument stops before its report when it cannot measure; it says why on its first line.
    const stop = /structure-refusals: NOT MEASURED — (.*)/.exec(report);
    if (stop && ARGUMENT_REFUSED.test(stop[1]))
      // It refused the arguments this reader gave it: the two disagree on how it is called, which is not its verdict on the data.
      return { status: "unreadable", ...base, reason: `the instrument refused the arguments AnviDeck ran it with (${stop[1].trim()}): AnviDeck and this version of structure-refusals.js disagree on how it is called` };
    if (stop) return { status: "not-measured", ...base, reason: stop[1].trim(), report };
    return { status: "unreadable", ...base, reason: `the instrument exited ${run.code} with no --json report` + (firstError(run.stderr) ? ` (${firstError(run.stderr)})` : "") };
  }
  let json: any;
  try {
    json = JSON.parse(run.fd3);
  } catch (e) {
    return { status: "unreadable", ...base, reason: `the instrument's --json report does not parse: ${(e as Error).message}` };
  }
  if (!json || !Array.isArray(json.calls)) return { status: "unreadable", ...base, reason: "the instrument's --json report has no calls list" };

  const totals: RefusalTotals = { edits: json.calls.length, sessions: new Set(json.calls.map((c: any) => c.session)).size,
    applied: 0, refused: 0, refusedByCheckAlone: 0, deniedOtherwise: 0, erroredOtherwise: 0, noResult: 0, timedOut: 0, cancelled: 0, unrecognised: 0 };
  const unknownOutcomes = new Set<string>();
  for (const c of json.calls) {
    const k = OUTCOME[c.outcome];
    if (k) (totals[k] as number)++;
    else unknownOutcomes.add(String(c.outcome));
  }
  // An outcome the instrument names that this reader does not know would vanish from every total.
  if (unknownOutcomes.size) return { status: "unreadable", ...base, reason: `the instrument reported outcomes this reader does not know: ${[...unknownOutcomes].join(", ")}` };

  const refusedCalls = json.calls.filter((c: any) => c.outcome === "refused" || c.outcome === "refused by the check");
  const unrecCalls = json.calls.filter((c: any) => c.outcome === "unrecognised");
  const wanted = [...refusedCalls, ...unrecCalls].map((c: any) => ({ transcript: c.transcript, id: c.id }));
  let reasons: Record<string, { reason: string | null }> = {};
  let reasonErrors: Record<string, string> = {};
  if (wanted.length) {
    const d = await spawnNode(driverArgs([script, JSON.stringify({ pkgDir: json.package ?? pkgDir, since: json.since ?? win.since, until: json.until ?? win.until, wanted })]), false, 120_000, "refusals");
    let r: any = null;
    try { r = JSON.parse(d.stdout); } catch { /* below */ }
    if (r && r.ok) {
      reasons = r.reasons;
      reasonErrors = r.errors;
    } else {
      const why = r?.reason ?? `the reason re-read exited ${d.code} with no answer${firstError(d.stderr) ? ` (${firstError(d.stderr)})` : ""}`;
      for (const w of wanted) reasonErrors[w.id] = why;
    }
  }
  const edit = (c: any): RefusalEdit => ({ key: c.id, at: c.at, session: c.session, tool: c.tool, file: c.file, outcome: c.outcome });
  const refusals: Refusal[] = refusedCalls.map((c: any) => ({
    key: c.id,
    at: c.at,
    session: c.session,
    tool: c.tool,
    file: c.file,
    checkout: c.checkout,
    checkoutDir: c.checkoutDir,
    version: c.version ?? null,
    transcript: c.transcript,
    refusedBy: c.outcome === "refused" ? "graph rule" : "project's own check",
    checkToo: c.outcome === "refused" ? c.checkToo === true : true,
    design: c.design ?? null,
    violations: Array.isArray(c.violations) ? c.violations : [],
    pairs: Array.isArray(c.pairs) ? c.pairs : [],
    reason: reasons[c.id]?.reason ?? null,
    ...(reasons[c.id]?.reason ? {} : { reasonError: reasonErrors[c.id] ?? "the instrument gave no reason for this call" }),
    call: { state: "none" },
  }));
  const notices = noticesFrom(report);
  const fallback: Record<string, number> = {};
  for (const c of json.calls) for (const k of c.notices ?? []) fallback[k] = (fallback[k] ?? 0) + 1;
  const trial = report.split("\n").find((l) => /^\s*TRIAL READING:/.test(l));
  return {
    status: "measured",
    ...base,
    transcripts: { read: json.transcripts ?? 0, unreadable: json.unreadable ?? 0, badLines: json.badLines ?? 0 },
    totals,
    notices: notices ?? fallback,
    refusals,
    timeouts: json.calls.filter((c: any) => c.outcome === "timed out" || c.outcome === "cancelled").map(edit),
    unrecognised: unrecCalls.map((c: any) => ({ ...edit(c), reason: reasons[c.id]?.reason ?? null })),
    exposure: json.exposure ?? null,
    defaultBranch: json.defaultBranch ?? null,
    byDesign: Array.isArray(json.byDesign) ? json.byDesign : [],
    trialReading: trial ? trial.trim() : null,
    report,
    cache: { at: ranAt, ageMs: 0, refreshing: false, ttlMs: CACHE_TTL_MS },
    calls: { file: "", exists: false, status: "none", lines: 0, unreadableLines: 0, unverified: 0, ofProject: 0, notListed: 0, readAt: ranAt },
  };
}

// ── cache ──────────────────────────────────────────────────────────────────────────────────
// Keyed on everything the answer depends on except the transcripts themselves (which only grow):
// the package, the window, the instrument's bytes, and the transcripts folder. Answers older than
// CACHE_TTL_MS are measured again; until the new run finishes, the old answer is served with its age.
// A run that could not be read never replaces an answer that could: the older answer is kept and
// served with the failure beside it (cache.lastRunFailed). Either is tried again after RETRY_MS.

export interface Entry { value: RefusalsResponse; at: number; started: string; failed?: { at: number; reason: string } }
const cache = new Map<string, Entry>();
const inflight = new Map<string, { started: string; job: Promise<Entry> }>();

export function clearRefusalsCache() { cache.clear(); }

/**
 * Every measured answer this server holds (every project, package and window asked so far),
 * without starting a run. The call route looks a key up across them (#178, #179): a tool_use id
 * names one blocked edit, so the answer listing it is the refusal's whatever project the agent ran
 * in. An empty list means "nothing to check against", never "no refusals".
 */
export function measuredAll(): RefusalsMeasured[] {
  const out: RefusalsMeasured[] = [];
  for (const e of cache.values()) if (e.value.status === "measured") out.push(e.value);
  return out;
}

export interface ReadOptions extends RunOptions {
  since?: string | null;
  until?: string | null;
  path?: string | null;
  package?: string | null;
  registry?: { locked?: string; user?: string };
  /** Wait for a run to finish rather than answer "measuring" (the tests; the route never waits). */
  wait?: boolean;
  /** Start a new run even when the cached answer is fresh (served until it finishes). */
  refresh?: boolean;
  now?: () => number;
  /** Read calls from this folder (the tests). */
  callsDir?: string;
  /** How one run is made (the tests inject it, as other reader tests inject `run`); default runInstrument. */
  run?: (project: string, pkgDir: string, win: RefusalWindow, opts: RunOptions) => Promise<RefusalsResponse>;
}

/** Your call on one refusal, from what readCalls could read: "none" only when nothing could hide one. */
export function callStateOf(read: Omit<CallsRead, "calls">, key: string): RefusalCallState {
  if (read.status === "unreadable") return { state: "unknown", reason: `your calls could not be read (${read.error ?? read.file}), so whether you made one is not known` };
  const s = read.byKey[key];
  if (s) return { state: "called", ...s };
  if (read.status === "partial")
    return { state: "unknown", reason: `${read.unreadableLines} of ${read.lines} lines of ${read.file} could not be read, and one of them may be a call on this refusal` };
  return { state: "none" };
}

function withCalls(r: RefusalsResponse, opts: ReadOptions): RefusalsResponse {
  if (r.status !== "measured") return r;
  const read = readCalls({ dir: opts.callsDir });
  const { calls: _c, byKey: _b, ...meta } = read;
  // Calls on this project whose refusal this answer does not list (outside its window, or a key no
  // refusal has): counted, so a screen can say so rather than hide them (#178).
  const listed = new Set(r.refusals.map((x) => x.key));
  const mine = Object.values(read.byKey).filter((s) => s.latest.project === r.project);
  const notListed = mine.filter((s) => !listed.has(s.latest.key)).length;
  // `unverified` beside them counts this project's calls too, not the whole file's.
  const unverified = read.calls.filter((c) => c.project === r.project && typeof c.unverified === "string").length;
  return { ...r, calls: { ...meta, unverified, ofProject: mine.length, notListed }, refusals: r.refusals.map((x) => ({ ...x, call: callStateOf(read, x.key) })) };
}

function withCache(e: Entry, now: number, refreshing: boolean): RefusalsResponse {
  const v = e.value;
  if (v.status !== "measured" && v.status !== "not-measured" && v.status !== "unreadable") return v;
  const failed = e.failed ? { lastRunFailed: { at: new Date(e.failed.at).toISOString(), reason: e.failed.reason } } : {};
  const ttlMs = v.status === "unreadable" ? RETRY_MS : CACHE_TTL_MS;
  return { ...v, cache: { at: new Date(e.at).toISOString(), ageMs: now - e.at, refreshing, ttlMs, ...failed } } as RefusalsResponse;
}

/** Whether a cached entry is due to be measured again: a failed run is retried sooner than a good answer expires. */
export function isStale(e: Entry | undefined, now: number): boolean {
  if (!e) return true;
  if (e.value.status === "unreadable") return now - e.at > RETRY_MS;
  if (e.failed) return now - e.failed.at > RETRY_MS;
  return now - e.at > CACHE_TTL_MS;
}

/** The entry a finished run leaves: its answer, unless it could not be read and an older answer could. */
export function settle(prev: Entry | undefined, value: RefusalsResponse, at: number, started: string): Entry {
  if (value.status === "unreadable" && prev && prev.value.status !== "unreadable") return { ...prev, failed: { at, reason: value.reason } };
  return { value, at, started };
}

export async function readRefusals(project: string, opts: ReadOptions = {}): Promise<{ response: RefusalsResponse; notFound?: boolean }> {
  const now = opts.now ?? Date.now;
  const win = windowOf(opts.since, opts.until, new Date(now()));
  const pick = packageOf(project, opts);
  if ("response" in pick) return pick;
  const script = opts.script ?? REFUSALS_SCRIPT;
  const id = scriptIdentity(script);
  const key = JSON.stringify([pick.dir, win.since, win.until, "error" in id ? id.error : id.sha256, opts.transcripts ?? null]);
  const start = () => {
    let f = inflight.get(key);
    if (!f) {
      const started = new Date(now()).toISOString();
      const job = (opts.run ?? runInstrument)(project, pick.dir, win, opts).then((value) => {
        const e = settle(cache.get(key), value, now(), started);
        cache.set(key, e);
        return e;
      }).finally(() => inflight.delete(key));
      f = { started, job };
      inflight.set(key, f);
    }
    return f;
  };
  const hit = cache.get(key);
  const stale = isStale(hit, now()) || opts.refresh;
  if (hit && !stale) return { response: withCalls(withCache(hit, now(), inflight.has(key)), opts) };
  const f = start();
  if (opts.wait) {
    const e = await f.job;
    return { response: withCalls(withCache(e, now(), false), opts) };
  }
  if (hit) return { response: withCalls(withCache(hit, now(), true), opts) };
  return { response: { status: "measuring", project, package: pick.dir, window: win, startedAt: f.started } };
}
