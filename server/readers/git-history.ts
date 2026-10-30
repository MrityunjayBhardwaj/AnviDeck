import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, relative } from "node:path";
import { entryIdFromHeader, ENTRY_HEADER_LINE } from "../../shared/parser";
import type { TimelinePoint, EntryDate } from "../../shared/types";

const CLAUDE_GIT_DIR = `${process.env.HOME ?? "/Users/mrityunjaybhardwaj"}/.claude`;

/**
 * Run a git command in the ~/.claude repo.
 */
async function gitCmd(args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", CLAUDE_GIT_DIR, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output.trim();
}

/**
 * Get git log as timeline points.
 * Default: last 100 commits.
 */
export async function getTimeline(
  limit = 100,
  offset = 0
): Promise<TimelinePoint[]> {
  // Use a unique commit delimiter to avoid ambiguity with --name-only blank lines
  const DELIM = "---COMMIT---";
  const raw = await gitCmd([
    "log",
    `--skip=${offset}`,
    `-n`,
    `${limit}`,
    `--format=${DELIM}%n%H|%s|%aI`,
    "--name-only",
  ]);

  if (!raw) return [];

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

  return points;
}

/**
 * Show file contents at a specific commit.
 */
export async function showAtCommit(
  hash: string,
  filePath: string
): Promise<string | null> {
  try {
    const output = await gitCmd(["show", `${hash}:${filePath}`]);
    return output || null;
  } catch {
    return null;
  }
}

/**
 * Diff between two commits.
 */
export async function diffCommits(
  from: string,
  to: string
): Promise<string> {
  return gitCmd(["diff", from, to]);
}

/**
 * List files at a specific commit under a path.
 */
export async function listAtCommit(
  hash: string,
  dirPath: string
): Promise<string[]> {
  try {
    const output = await gitCmd([
      "ls-tree",
      "-r",
      "--name-only",
      hash,
      dirPath,
    ]);
    return output ? output.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

// ---- Per-entry dates ----------------------------------------------------

/** Run git with an explicit -C; never throws. */
async function gitIn(
  dir: string,
  args: string[]
): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const proc = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { ok: code === 0, out, err: err.trim() };
  } catch (e) {
    return { ok: false, out: "", err: (e as Error).message };
  }
}

const dateCache = new Map<string, { key: string; value: Record<string, EntryDate> }>();

/**
 * Per-entry created / lastModified dates for one catalogue file.
 *
 * Reads the history of the file's REAL location (symlinks resolved), so a
 * project's `.anvi -> ~/.anvideck/projects/<p>/.anvi` link is dated from the
 * central store's own repo rather than the project's. Read-only: only
 * `git rev-parse`, `ls-files`, `log` and `blame`. Throws only if the file
 * itself cannot be read (the caller reports that as unreadable).
 */
export async function readEntryDatesForFile(
  filePath: string
): Promise<Record<string, EntryDate>> {
  const real = realpathSync(filePath);
  const st = statSync(real);
  const lines = readFileSync(real, "utf8").split("\n");

  // Current entries and the line span of each.
  const spans: { id: string; start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i]!.match(ENTRY_HEADER_LINE);
    if (!h) continue;
    if (spans.length) spans[spans.length - 1]!.end = i;
    const parsed = entryIdFromHeader(h[2]!.trim());
    spans.push({ id: parsed ? parsed.id : "", start: i, end: lines.length });
  }
  const entrySpans = spans.filter((s) => s.id);

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

  const top = await gitIn(dirname(real), ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return fileDates(); // not inside a git repo
  const root = top.out.trim();
  const rel = relative(root, real);
  const head = await gitIn(root, ["rev-parse", "HEAD"]);
  const cacheKey = `${head.out.trim()}|${st.mtimeMs}|${st.size}`;
  const cached = dateCache.get(real);
  if (cached && cached.key === cacheKey) return cached.value;

  const tracked = await gitIn(root, ["ls-files", "--error-unmatch", "--", rel]);
  if (!tracked.ok) return fileDates(); // in a repo but never committed

  // created: the first commit whose diff adds the entry's header line.
  const log = await gitIn(root, [
    "log", "--reverse", "--no-color", "-U0", "--format=@@COMMIT@@ %H %aI", "-p", "--", rel,
  ]);
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

  // lastModified: newest author-time over the entry's current lines.
  const blame = await gitIn(root, ["blame", "--line-porcelain", "--", rel]);
  const lineTime: (number | null)[] = [];
  if (blame.ok) {
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
  }

  const out: Record<string, EntryDate> = {};
  for (const s of entrySpans) {
    if (out[s.id]) continue; // repeated header (e.g. an UPDATE sub-section): first wins
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
  dateCache.set(real, { key: cacheKey, value: out });
  return out;
}
