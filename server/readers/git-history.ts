import { outputNeverEnded, readProcess } from "../child-output";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { announcesContinuation, entryIdFromHeader, ENTRY_HEADER_LINE } from "../../shared/parser";
import type {
  TimelinePoint,
  EntryDate,
  EntryDates,
  EntryDatesPending,
  EntryDatesFailed,
} from "../../shared/types";

export const CLAUDE_GIT_DIR = `${process.env.HOME ?? "/Users/mrityunjaybhardwaj"}/.claude`;

/**
 * What a history read found, or why git could not answer (#35). A failed git
 * command (bad hash, no repo, git missing, a lock) is never read as "nothing".
 */
export type GitRead<T> = { ok: true; value: T } | { ok: false; err: string };

/**
 * True for a value shaped like a revision (a hash, HEAD, HEAD~3, a branch name).
 * URL values reach git as arguments, and one starting with "-" would be read as
 * a git option, some of which write files (#56). Callers reject anything else.
 */
export function isRevision(s: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._\/~^@{}-]{0,199}$/.test(s);
}

/** Run a git command in the ~/.claude repo (or `dir`); never throws. */
async function gitCmd(args: string[], dir = CLAUDE_GIT_DIR): Promise<GitRead<string>> {
  const r = await gitIn(dir, args);
  if (!r.ok) return { ok: false, err: r.err || `git ${args[0]} failed in ${dir}` };
  return { ok: true, value: r.out.trim() };
}

/**
 * Get git log as timeline points.
 * Default: last 100 commits.
 */
export async function getTimeline(
  limit = 100,
  offset = 0,
  dir = CLAUDE_GIT_DIR
): Promise<GitRead<TimelinePoint[]>> {
  // Use a unique commit delimiter to avoid ambiguity with --name-only blank lines
  const DELIM = "---COMMIT---";
  const res = await gitCmd([
    "log",
    `--skip=${offset}`,
    `-n`,
    `${limit}`,
    `--format=${DELIM}%n%H|%s|%aI`,
    "--name-only",
  ], dir);
  if (!res.ok) return res;
  const raw = res.value;

  if (!raw) return { ok: true, value: [] };

  const points: TimelinePoint[] = [];
  const blocks = raw.split(DELIM).filter(Boolean);

  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    if (lines.length === 0) continue;

    const metaLine = lines[0];
    const pipeIdx1 = metaLine.indexOf("|");
    if (pipeIdx1 === -1) continue;

    const hash = metaLine.slice(0, pipeIdx1);
    const rest = metaLine.slice(pipeIdx1 + 1);
    const pipeIdx2 = rest.lastIndexOf("|");
    if (pipeIdx2 === -1) continue;

    const message = rest.slice(0, pipeIdx2);
    const dateStr = rest.slice(pipeIdx2 + 1);
    const fileLines = lines.slice(1);

    points.push({
      hash,
      message,
      date: new Date(dateStr),
      filesChanged: fileLines,
    });
  }

  return { ok: true, value: points };
}

/**
 * Show file contents at a specific commit. `value: null` means git answered
 * that the commit exists but holds no such file; an empty file is "".
 */
export async function showAtCommit(
  hash: string,
  filePath: string,
  dir = CLAUDE_GIT_DIR
): Promise<GitRead<string | null>> {
  // --end-of-options: git never reads what follows as an option (#56).
  const res = await gitCmd(["show", "--end-of-options", `${hash}:${filePath}`], dir);
  if (res.ok) return res;
  // `git show` fails the same way for "no such file in this commit" and for
  // "could not look". Only a commit that resolves makes it the former.
  const commit = await gitCmd(["rev-parse", "--verify", "--quiet", "--end-of-options", `${hash}^{commit}`], dir);
  return commit.ok ? { ok: true, value: null } : res;
}

/**
 * Diff between two commits.
 */
export async function diffCommits(
  from: string,
  to: string,
  dir = CLAUDE_GIT_DIR
): Promise<GitRead<string>> {
  return gitCmd(["diff", "--end-of-options", from, to], dir);
}

/**
 * List files at a specific commit under a path.
 */
export async function listAtCommit(
  hash: string,
  dirPath: string,
  dir = CLAUDE_GIT_DIR
): Promise<GitRead<string[]>> {
  const res = await gitCmd(["ls-tree", "-r", "--name-only", "--end-of-options", hash, "--", dirPath], dir);
  if (!res.ok) return res;
  return { ok: true, value: res.value ? res.value.split("\n").filter(Boolean) : [] };
}

// ---- Per-entry dates ----------------------------------------------------

/**
 * Run git with an explicit -C; never throws. With `timeoutMs`, a git that has
 * not finished by then is stopped and the read answers ok: false, so a read
 * that cannot finish is a failure, never a short answer (#34).
 */
export async function gitIn(
  dir: string,
  args: string[],
  timeoutMs?: number
): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    // env given explicitly: Bun otherwise looks git up on the PATH the process
    // started with, and the tests put a stand-in git first on PATH.
    const proc = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe", env: process.env });
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, timeoutMs)
      : undefined;
    const { stdout: out, stderr: err, code, ended } = await readProcess(proc, `git ${args[0]}`);
    clearTimeout(timer);
    if (timedOut) {
      return { ok: false, out: "", err: `git ${args[0]} did not finish within ${timeoutMs! / 1000} s and was stopped` };
    }
    if (!ended) return { ok: false, out: "", err: outputNeverEnded(`git ${args[0]}`) };
    return { ok: code === 0, out, err: err.trim() };
  } catch (e) {
    return { ok: false, out: "", err: (e as Error).message };
  }
}

/** Git could not answer for a catalogue's history (failed, or ran too long). */
export class EntryDatesGitError extends Error {}

/** How long one `git log -p` or `git blame` may run before the read fails. */
let datesGitTimeoutMs = Number(process.env.ANVIDECK_DATES_GIT_TIMEOUT_MS) || 180_000;
/** For tests: change the limit above; returns the previous one. */
export function setDatesGitTimeoutMs(ms: number): number {
  const prev = datesGitTimeoutMs;
  datesGitTimeoutMs = ms;
  return prev;
}

/** A failed read is reported for this long before a request may try again. */
const FAILURE_HOLD_MS = 30_000;

const dateCache = new Map<
  string,
  { key: string; mtimeMs: number; size: number; value: Record<string, EntryDate> }
>();
/** One read per catalogue file at a time: later requests join it (#34). */
const inFlight = new Map<string, Promise<Record<string, EntryDate>>>();
const lastFailure = new Map<string, { at: number; err: string }>();
let jobsStarted = 0;

/** For tests: how many date reads have been started (joins do not count). */
export function datesJobsStarted(): number {
  return jobsStarted;
}

/** The running read for `real`, or a new one. Never leaves a rejection unhandled. */
function datesJob(real: string): Promise<Record<string, EntryDate>> {
  const running = inFlight.get(real);
  if (running) return running;
  jobsStarted++;
  const job = computeEntryDates(real).finally(() => inFlight.delete(real));
  inFlight.set(real, job);
  job.then(
    () => lastFailure.delete(real),
    (e) => {
      if (e instanceof EntryDatesGitError) lastFailure.set(real, { at: Date.now(), err: e.message });
    }
  );
  return job;
}

/**
 * Per-entry created / lastModified dates for one catalogue file. Waits for
 * the whole read. Throws EntryDatesGitError when git could not answer (a
 * failed or stopped `git log`/`git blame`), and a plain Error when the file
 * itself cannot be read; it never answers a failed read with "no dates".
 */
export async function readEntryDatesForFile(
  filePath: string
): Promise<Record<string, EntryDate>> {
  return datesJob(realpathSync(filePath));
}

export type DatesPeek =
  | { state: "ready"; value: Record<string, EntryDate> }
  | { state: "pending" }
  | { state: "failed"; err: string };

/**
 * Like readEntryDatesForFile, but waits at most `waitMs`: a read still running
 * then answers "pending" and carries on in the background, so the next request
 * finds it done (#34). Throws only when the file itself cannot be read.
 */
export async function peekEntryDatesForFile(filePath: string, waitMs: number): Promise<DatesPeek> {
  const real = realpathSync(filePath);
  const failed = lastFailure.get(real);
  if (failed && !inFlight.has(real) && Date.now() - failed.at < FAILURE_HOLD_MS) {
    return { state: "failed", err: failed.err };
  }
  const job = datesJob(real);
  // Dates already read for the file as it is now are answered at once, while
  // the read started above checks in the background whether a new commit
  // changed them. Without this, a request on a busy machine could spend its
  // whole wait on that check (rev-parse alone took ~2 s at load 95) and a
  // warm cache would still answer "pending".
  const cached = dateCache.get(real);
  if (cached) {
    try {
      const st = statSync(real);
      if (cached.mtimeMs === st.mtimeMs && cached.size === st.size) return { state: "ready", value: cached.value };
    } catch {
      // fall through: the read itself reports the file
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<"waited">((r) => (timer = setTimeout(() => r("waited"), waitMs)));
  try {
    const v = await Promise.race([job, waited]);
    return v === "waited" ? { state: "pending" } : { state: "ready", value: v };
  } catch (e) {
    if (e instanceof EntryDatesGitError) return { state: "failed", err: e.message };
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export const CATALOGUE_FILES = ["hetvabhasa.md", "vyapti.md", "krama.md", "dharana.md"] as const;

export type StoreDatesAnswer =
  | { code: 200; body: EntryDates }
  | { code: 202; body: EntryDatesPending }
  | { code: 503; body: EntryDatesFailed | { status: "unreadable"; error: string } };

/**
 * Per-entry dates for every catalogue in one `.anvi` folder, answering within
 * about `waitMs`. 200: all read. 202: some still being read in the background
 * (`dates` holds the ones that are done). 503: git could not answer for a
 * catalogue ("failed"), or a catalogue file could not be read ("unreadable").
 * A catalogue that does not exist is simply absent.
 */
export async function readEntryDatesForStore(anviDir: string, waitMs: number): Promise<StoreDatesAnswer> {
  const present = CATALOGUE_FILES.filter((file) => {
    try {
      statSync(join(anviDir, file));
      return true;
    } catch {
      return false; // this catalogue does not exist: nothing to date
    }
  });
  let peeks: { cat: string; peek: DatesPeek }[];
  try {
    peeks = await Promise.all(
      present.map(async (file) => ({
        cat: file.replace(/\.md$/, ""),
        peek: await peekEntryDatesForFile(join(anviDir, file), waitMs),
      }))
    );
  } catch (e) {
    return { code: 503, body: { status: "unreadable", error: `could not read a catalogue in ${anviDir}: ${(e as Error).message}` } };
  }
  const dates: EntryDates = {};
  const pending: string[] = [];
  const failed: string[] = [];
  const errors: string[] = [];
  for (const { cat, peek } of peeks) {
    if (peek.state === "ready") dates[cat] = peek.value;
    else if (peek.state === "pending") pending.push(cat);
    else {
      failed.push(cat);
      errors.push(`${cat}: ${peek.err}`);
    }
  }
  if (failed.length) return { code: 503, body: { status: "failed", error: errors.join("; "), failed, pending, dates } };
  if (pending.length) return { code: 202, body: { status: "pending", pending, dates } };
  return { code: 200, body: dates };
}

/**
 * Reads the history of the file's REAL location (symlinks resolved), so a
 * project's `.anvi -> ~/.anvideck/projects/<p>/.anvi` link is dated from the
 * central store's own repo rather than the project's. Read-only: only
 * `git rev-parse`, `ls-files`, `log` and `blame`.
 */
async function computeEntryDates(real: string): Promise<Record<string, EntryDate>> {
  const st = statSync(real);
  const lines = readFileSync(real, "utf8").split("\n");

  // Current entries and the line span of each.
  const spans: { id: string; start: number; end: number; announced: boolean }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i]!.match(ENTRY_HEADER_LINE);
    if (!h) continue;
    if (spans.length) spans[spans.length - 1]!.end = i;
    const parsed = entryIdFromHeader(h[2]!.trim());
    spans.push({ id: parsed ? parsed.id : "", start: i, end: lines.length, announced: announcesContinuation(h[2]!.trim()) });
  }
  // One span per ID: the entry's own heading, chosen as the parser chooses it
  // (the first heading, unless it announces an update and a later one does not).
  const chosen = new Map<string, (typeof spans)[number]>();
  for (const s of spans) {
    if (!s.id) continue;
    const kept = chosen.get(s.id);
    if (!kept || (kept.announced && !s.announced)) chosen.set(s.id, s);
  }
  const entrySpans = [...chosen.values()];

  const fileDates = (): Record<string, EntryDate> => {
    const out: Record<string, EntryDate> = {};
    for (const s of entrySpans) {
      out[s.id] ??= {
        created: st.birthtime.toISOString(),
        lastModified: st.mtime.toISOString(),
        dateSource: "file",
      };
    }
    return out;
  };

  const top = await gitIn(dirname(real), ["rev-parse", "--show-toplevel"], datesGitTimeoutMs);
  if (!top.ok) {
    if (/not a git repository/i.test(top.err)) return fileDates();
    throw new EntryDatesGitError(`git could not find the repository of ${real}: ${top.err}`);
  }
  const root = top.out.trim();
  const rel = relative(root, real);
  const head = await gitIn(root, ["rev-parse", "--verify", "HEAD"], datesGitTimeoutMs);
  if (!head.ok && !/needed a single revision|unknown revision|ambiguous argument/i.test(head.err)) {
    throw new EntryDatesGitError(`git could not read HEAD in ${root}: ${head.err}`);
  }
  const cacheKey = `${head.out.trim()}|${st.mtimeMs}|${st.size}`;
  const cached = dateCache.get(real);
  if (cached && cached.key === cacheKey) return cached.value;

  const tracked = await gitIn(root, ["ls-files", "--error-unmatch", "--", rel], datesGitTimeoutMs);
  if (!tracked.ok) return fileDates(); // in a repo but never committed
  if (!head.ok) return fileDates(); // added, but the repo has no commit yet

  // The two long reads run side by side; either one failing fails the read.
  const [log, blame] = await Promise.all([
    // created: the first commit whose diff adds the entry's header line.
    gitIn(root, ["log", "--reverse", "--no-color", "-U0", "--format=@@COMMIT@@ %H %aI", "-p", "--", rel], datesGitTimeoutMs),
    // lastModified: newest author-time over the entry's current lines.
    gitIn(root, ["blame", "--line-porcelain", "--", rel], datesGitTimeoutMs),
  ]);
  if (!log.ok) throw new EntryDatesGitError(`git log of ${rel} failed: ${log.err || "no reason given"}`);
  if (!blame.ok) throw new EntryDatesGitError(`git blame of ${rel} failed: ${blame.err || "no reason given"}`);

  const firstSeen = new Map<string, { commit: string; date: string }>();
  let firstCommit = "";
  let cur = { commit: "", date: "" };
  for (const line of log.out.split("\n")) {
    if (line.startsWith("@@COMMIT@@ ")) {
      const [, commit = "", date = ""] = line.split(" ");
      cur = { commit, date };
      if (!firstCommit) firstCommit = commit;
      continue;
    }
    if (!line.startsWith("+#")) continue;
    const h = line.slice(1).match(ENTRY_HEADER_LINE);
    if (!h) continue;
    const parsed = entryIdFromHeader(h[2]!.trim());
    if (parsed && !firstSeen.has(parsed.id)) firstSeen.set(parsed.id, cur);
  }

  const lineTime: (number | null)[] = [];
  let t: number | null = null;
  let uncommitted = false;
  for (const line of blame.out.split("\n")) {
    if (/^[0-9a-f]{40} /.test(line)) {
      uncommitted = /^0{40} /.test(line);
      t = null;
    } else if (line.startsWith("author-time ")) {
      t = uncommitted ? null : Number(line.slice(12)) * 1000;
    } else if (line.startsWith("\t")) {
      lineTime.push(t);
    }
  }

  const out: Record<string, EntryDate> = {};
  for (const s of entrySpans) {
    let newest: number | null = null;
    for (let i = s.start; i < s.end && i < lineTime.length; i++) {
      const t = lineTime[i];
      if (t != null && (newest == null || t > newest)) newest = t;
    }
    const lastModified = newest != null ? new Date(newest).toISOString() : null;
    const seen = firstSeen.get(s.id);
    if (!seen) out[s.id] = { created: null, lastModified, dateSource: "none" };
    else if (seen.commit === firstCommit) out[s.id] = { created: seen.date, lastModified, dateSource: "file" };
    else out[s.id] = { created: seen.date, lastModified, dateSource: "entry" };
  }
  dateCache.set(real, { key: cacheKey, mtimeMs: st.mtimeMs, size: st.size, value: out });
  return out;
}
