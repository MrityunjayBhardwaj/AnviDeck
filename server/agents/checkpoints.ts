/**
 * Checkpoints per agent turn (#248): a snapshot of the agent's folder at each turn boundary, what
 * each turn changed, and Undo back to a checkpoint.
 *
 * Where things go (the owner's decision on #248):
 * - Snapshots: `<agent dir>/checkpoints/<agent>.git`, a git repository of AnviDeck's own. The
 *   folder `checkpoints/` holds a `.gitignore` of `*`, written before anything else is, so the
 *   store's commit hook never picks a snapshot up: a snapshot holds untracked files (an `.env`),
 *   and git history would keep them for ever. They stay on this machine.
 * - The record: `<agent dir>/turns/<agent>.jsonl`, one line per checkpoint (files changed, a diff
 *   summary) and per Clear. It is backed up with the action log. It names files, never contents.
 * - Nothing is written into the project's repository. The snapshot repository borrows the
 *   project's objects read-only (objects/info/alternates), so unchanged files cost no disk.
 *
 * How a snapshot is taken: `git add -A` with the agent's folder as the work tree and AnviDeck's
 * repository as the git dir, then `write-tree`. It holds tracked and untracked files; files the
 * folder's .gitignore (or the checkout's info/exclude, or your global excludes) leaves out are not
 * in it, and Undo leaves them as they are.
 *
 * Undo: `read-tree -m -u <now> <checkpoint>`, git's own two-tree switch: files added since are
 * removed, changed ones put back, and it refuses rather than overwrite a file that changed after
 * the snapshot it compares with. It never moves the branch or touches the project's index.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readProcess, outputNeverEnded } from "../child-output";
import type { Run, RunResult } from "../readers/repo";
import {
  FILES_KEPT,
  type CheckpointEntry,
  type CheckpointWhen,
  type ClearedEntry,
  type FileChange,
  type TurnRecordLine,
} from "../../shared/checkpoint-types";

/** How long one git step of a snapshot may take before it is given up (the run then starts without one). */
export const SNAPSHOT_STEP_MS = 60_000;

/** What `.gitignore` in `checkpoints/` says: everything in the folder, itself included. */
export const IGNORE_ALL = "# AnviDeck's checkpoint snapshots stay on this machine (#248): never commit them.\n*\n";

/**
 * Runs git outside any inherited git context: every GIT_* variable is dropped, so a server started
 * from inside a git hook cannot point a snapshot at another repository. Time-limited (code 124).
 */
export function gitRunner(ms: number): Run {
  return async (cmd, args, opts) => {
    try {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
      const p = Bun.spawn([cmd, ...args], { cwd: opts?.cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        p.kill();
      }, ms);
      const { stdout, stderr, code, ended } = await readProcess(p, cmd);
      clearTimeout(timer);
      if (timedOut) return { code: 124, stdout, stderr: `git ${args.find((a) => !a.startsWith("-")) ?? ""} took longer than ${ms / 1000}s and was stopped` };
      if (!ended) return { code: 125, stdout: "", stderr: outputNeverEnded(`git ${args[0] ?? ""}`) };
      return { code, stdout, stderr };
    } catch (e) {
      return { code: 127, stdout: "", stderr: (e as Error).message };
    }
  };
}

export class CheckpointError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502 | 503,
    message: string,
    readonly refusal: string,
  ) {
    super(message);
  }
}

const said = (r: RunResult) => (r.stderr || r.stdout).trim().slice(0, 400) || `exit ${r.code}`;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA = /^[0-9a-f]{40}$/;

// Settings for every git call on a snapshot repository: no line-ending rewriting (the snapshot is
// the bytes on disk), no background maintenance or fsmonitor daemon started in the agent's folder.
const QUIET = ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "core.quotePath=false"];

export interface Snapshot {
  tree: string;
  head: CheckpointEntry["head"];
}

export class CheckpointStore {
  /** Snapshot repositories, one per agent; ignored by the store. */
  readonly root: string;
  /** The per-turn record, one file per agent; backed up. */
  readonly recordDir: string;
  private readonly run: Run;
  /** One snapshot or Undo at a time per agent, in the order asked. */
  private readonly chains = new Map<string, Promise<unknown>>();

  /** How old an index.lock must be to count as left behind by a stopped git step. */
  private readonly lockStaleMs: number;

  constructor(agentDir: string, opts: { run?: Run; lockStaleMs?: number } = {}) {
    this.root = join(agentDir, "checkpoints");
    this.recordDir = join(agentDir, "turns");
    this.run = opts.run ?? gitRunner(SNAPSHOT_STEP_MS);
    this.lockStaleMs = opts.lockStaleMs ?? SNAPSHOT_STEP_MS;
  }

  repoOf(id: string): string {
    if (!ID.test(id)) throw new CheckpointError(400, `not an agent id: ${id}`, "bad-id");
    return join(this.root, `${id}.git`);
  }

  recordOf(id: string): string {
    if (!ID.test(id)) throw new CheckpointError(400, `not an agent id: ${id}`, "bad-id");
    return join(this.recordDir, `${id}.jsonl`);
  }

  /** Snapshots are kept for this agent on this machine. */
  kept(id: string): boolean {
    return existsSync(this.repoOf(id));
  }

  /**
   * `checkpoints/` exists and ignores everything in it, before any snapshot is written. Throws when
   * that cannot be made true: no snapshot is taken unless it is.
   */
  ensureIgnored(): void {
    mkdirSync(this.root, { recursive: true });
    const f = join(this.root, ".gitignore");
    let now: string | null = null;
    try {
      now = readFileSync(f, "utf8");
    } catch {
      now = null;
    }
    if (now !== IGNORE_ALL) writeFileSync(f, IGNORE_ALL);
    if (readFileSync(f, "utf8") !== IGNORE_ALL) throw new Error(`${f} could not be written`);
  }

  /** Run `fn` after every earlier snapshot or Undo of this agent has finished. */
  serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.chains.set(id, settled);
    void settled.then(() => {
      if (this.chains.get(id) === settled) this.chains.delete(id);
    });
    return next;
  }

  private async git(repo: string, cwd: string, args: string[]): Promise<RunResult> {
    return this.run("git", [...QUIET, `--git-dir=${repo}`, `--work-tree=${cwd}`, ...args], { cwd });
  }

  private async must(repo: string, cwd: string, args: string[], what: string): Promise<string> {
    const r = await this.git(repo, cwd, args);
    if (r.code !== 0) throw new Error(`${what}: ${said(r)}`);
    return r.stdout;
  }

  /** The snapshot repository for an agent, made if missing, pointed at the folder's checkout objects. */
  private async prepare(id: string, cwd: string): Promise<string> {
    this.ensureIgnored();
    const repo = this.repoOf(id);
    if (!existsSync(join(repo, "HEAD"))) {
      const r = await this.run("git", ["init", "-q", "--bare", repo], { cwd: this.root });
      if (r.code !== 0) throw new Error(`the snapshot repository could not be made: ${said(r)}`);
      // A git dir used with a work tree: not bare, so --work-tree is taken as given.
      await this.must(repo, cwd, ["config", "core.bare", "false"], "the snapshot repository could not be set up");
    }
    // Borrow the checkout's objects (read-only) and its local excludes, if the folder is in one.
    const common = await this.run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
    if (common.code === 0 && common.stdout.trim()) {
      const objects = join(common.stdout.trim(), "objects");
      const alt = join(repo, "objects", "info", "alternates");
      if (existsSync(objects) && (!existsSync(alt) || readFileSync(alt, "utf8").trim() !== objects)) {
        mkdirSync(join(repo, "objects", "info"), { recursive: true });
        writeFileSync(alt, `${objects}\n`);
      }
      const exclude = join(common.stdout.trim(), "info", "exclude");
      const mine = join(repo, "info", "exclude");
      mkdirSync(join(repo, "info"), { recursive: true });
      writeFileSync(mine, existsSync(exclude) ? readFileSync(exclude) : "");
    }
    return repo;
  }

  /**
   * A git step stopped at its time limit leaves `index.lock` behind, and every later snapshot of the
   * agent would then fail on it. Snapshots of one agent run one at a time here, so a lock older than
   * the time limit is a leftover: it is removed.
   */
  private dropStaleLock(repo: string): void {
    const lock = join(repo, "index.lock");
    try {
      if (Date.now() - statSync(lock).mtimeMs > this.lockStaleMs) rmSync(lock, { force: true });
    } catch {
      /* no lock */
    }
  }

  /** The folder as it is now, as a tree in the agent's snapshot repository. Records nothing. */
  async snapshot(id: string, cwd: string): Promise<Snapshot> {
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new CheckpointError(409, `the agent's folder ${cwd} no longer exists`, "folder-gone");
    const repo = await this.prepare(id, cwd);
    this.dropStaleLock(repo);
    await this.must(repo, cwd, ["add", "-A", "."], "the folder could not be read into a snapshot");
    const tree = (await this.must(repo, cwd, ["write-tree"], "the snapshot could not be written")).trim();
    if (!SHA.test(tree)) throw new Error(`the snapshot named no tree (${tree.slice(0, 80)})`);
    return { tree, head: await this.headOf(cwd) };
  }

  private async headOf(cwd: string): Promise<CheckpointEntry["head"]> {
    const sha = await this.run("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd });
    if (sha.code !== 0 || !SHA.test(sha.stdout.trim())) return null;
    const br = await this.run("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd });
    return { sha: sha.stdout.trim(), branch: br.code === 0 && br.stdout.trim() ? br.stdout.trim() : null };
  }

  /** Files changed from tree `a` to tree `b`, with line counts; `a` null means nothing before. */
  async changes(id: string, cwd: string, a: string | null, b: string): Promise<{ changes: FileChange[]; count: number }> {
    if (a === null || a === b) return { changes: [], count: 0 };
    const repo = this.repoOf(id);
    const names = await this.must(repo, cwd, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", a, b], "the changes could not be listed");
    const nums = await this.must(repo, cwd, ["diff-tree", "-r", "-z", "--no-renames", "--numstat", a, b], "the changes could not be counted");
    const byPath = new Map<string, { added: number | null; removed: number | null }>();
    // numstat -z: "<added>\t<removed>\t<path>\0" per file.
    for (const rec of nums.split("\0")) {
      const m = rec.match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
      if (!m) continue;
      byPath.set(m[3]!, { added: m[1] === "-" ? null : Number(m[1]), removed: m[2] === "-" ? null : Number(m[2]) });
    }
    // name-status -z: "<status>\0<path>\0" per file.
    const parts = names.split("\0").filter((p) => p !== "");
    const all: FileChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i]!.charAt(0) as FileChange["status"];
      const path = parts[i + 1]!;
      const n = byPath.get(path) ?? { added: null, removed: null };
      all.push({ path, status: status === "A" || status === "D" || status === "T" ? status : "M", ...n });
    }
    return { changes: all.slice(0, FILES_KEPT), count: all.length };
  }

  /** The record as written: its lines, and how many could not be read. */
  read(id: string): { records: TurnRecordLine[]; unreadable: number } {
    const f = this.recordOf(id);
    if (!existsSync(f)) return { records: [], unreadable: 0 };
    const records: TurnRecordLine[] = [];
    let unreadable = 0;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as TurnRecordLine;
        if (r && typeof r === "object" && typeof r.kind === "string") records.push(r);
        else unreadable++;
      } catch {
        unreadable++;
      }
    }
    return { records, unreadable };
  }

  private append(id: string, line: TurnRecordLine): void {
    mkdirSync(this.recordDir, { recursive: true });
    appendFileSync(this.recordOf(id), `${JSON.stringify(line)}\n`);
  }

  /** The newest checkpoint since the last Clear, and the next number to give. */
  private last(id: string): { latest: CheckpointEntry | null; nextN: number } {
    let latest: CheckpointEntry | null = null;
    let maxN = 0;
    for (const r of this.read(id).records) {
      if (r.kind === "checkpoint") {
        maxN = Math.max(maxN, r.n);
        latest = r;
      } else if (r.kind === "cleared") latest = null;
    }
    return { latest, nextN: maxN + 1 };
  }

  /** Checkpoints whose snapshots are still here, newest last. */
  undoable(id: string): CheckpointEntry[] {
    if (!this.kept(id)) return [];
    let out: CheckpointEntry[] = [];
    for (const r of this.read(id).records) {
      if (r.kind === "checkpoint") out.push(r);
      else if (r.kind === "cleared") out = [];
    }
    return out;
  }

  /**
   * Take a checkpoint and record it with what changed since the one before. A failure is recorded
   * too (never thrown), so a turn without a checkpoint says so. `extra` is decided when the
   * snapshot is done (e.g. whether the next turn had started meanwhile).
   */
  capture(
    id: string,
    cwd: string,
    what: { when: CheckpointWhen; run: number; reason?: string; undoTo?: number },
    extra?: () => Partial<Pick<CheckpointEntry, "mayIncludeNext">>,
  ): Promise<CheckpointEntry | null> {
    return this.serial(id, () => this.captureNow(id, cwd, what, extra));
  }

  private async captureNow(
    id: string,
    cwd: string,
    what: { when: CheckpointWhen; run: number; reason?: string; undoTo?: number },
    extra?: () => Partial<Pick<CheckpointEntry, "mayIncludeNext">>,
    snap?: Snapshot,
  ): Promise<CheckpointEntry | null> {
    try {
      const s = snap ?? (await this.snapshot(id, cwd));
      const { latest, nextN } = this.last(id);
      const { changes, count } = await this.changes(id, cwd, latest?.tree ?? null, s.tree);
      const n = nextN;
      await this.must(this.repoOf(id), cwd, ["update-ref", `refs/checkpoints/${n}`, s.tree], "the checkpoint could not be kept");
      const entry: CheckpointEntry = {
        kind: "checkpoint",
        n,
        at: new Date().toISOString(),
        when: what.when,
        run: what.run,
        tree: s.tree,
        head: s.head,
        changes,
        changeCount: count,
        ...(what.reason ? { reason: what.reason } : {}),
        ...(what.undoTo !== undefined ? { undoTo: what.undoTo } : {}),
        ...(extra ? extra() : {}),
      };
      this.append(id, entry);
      return entry;
    } catch (e) {
      const reason = (e as Error).message;
      console.error(`[checkpoints] ${id} ${what.when}: ${reason}`);
      try {
        this.append(id, { kind: "checkpoint-failed", at: new Date().toISOString(), when: what.when, run: what.run, reason });
      } catch (e2) {
        console.error(`[checkpoints] ${id}: the failure could not be recorded either: ${(e2 as Error).message}`);
      }
      return null;
    }
  }

  /** A checkpoint that can be undone to, with its snapshot checked to be whole. */
  async target(id: string, cwd: string, n: number): Promise<CheckpointEntry> {
    const found = this.undoable(id).find((c) => c.n === n);
    if (!found) {
      const ever = this.read(id).records.some((r) => r.kind === "checkpoint" && r.n === n);
      throw new CheckpointError(404, ever ? `checkpoint ${n}'s snapshot was cleared, so it cannot be undone to` : `agent ${id} has no checkpoint ${n}`, ever ? "cleared" : "no-checkpoint");
    }
    const repo = this.repoOf(id);
    const ref = await this.git(repo, cwd, ["rev-parse", "--verify", "-q", `refs/checkpoints/${n}^{tree}`]);
    if (ref.code !== 0 || ref.stdout.trim() !== found.tree) throw new CheckpointError(409, `checkpoint ${n}'s snapshot is missing from ${repo}`, "snapshot-missing");
    // Every object must be readable: the borrowed checkout objects can be pruned by its own gc.
    const whole = await this.git(repo, cwd, ["rev-list", "--objects", "--missing=print", found.tree]);
    if (whole.code !== 0 || /^\?/m.test(whole.stdout)) throw new CheckpointError(409, `checkpoint ${n}'s snapshot is no longer whole (files it needs are gone from the checkout's objects), so it cannot be put back`, "snapshot-broken");
    return found;
  }

  /**
   * Put the folder back to checkpoint `n`. `current` is the tree the preview showed: refused if the
   * folder has changed since. Takes a checkpoint before (so this Undo can be undone) and one after
   * (its changes are what the Undo did). The caller makes sure no agent runs in the folder.
   */
  undo(id: string, cwd: string, n: number, current: string, run: number): Promise<{ before: CheckpointEntry; after: CheckpointEntry; to: CheckpointEntry }> {
    return this.serial(id, async () => {
      const to = await this.target(id, cwd, n);
      const now = await this.snapshot(id, cwd);
      if (now.tree !== current) throw new CheckpointError(409, "the folder has changed since you looked at what Undo would discard; look again", "folder-moved");
      const before = await this.captureNow(id, cwd, { when: "before-undo", run }, undefined, now);
      if (!before) throw new CheckpointError(502, "the checkpoint before Undo could not be kept, so nothing was put back (see the record)", "before-failed");
      const r = await this.git(this.repoOf(id), cwd, ["read-tree", "-m", "-u", now.tree, to.tree]);
      if (r.code !== 0) throw new CheckpointError(502, `git could not put the folder back: ${said(r)}. The checkpoint taken just before (${before.n}) keeps the folder as it was`, "restore-failed");
      const after = await this.captureNow(id, cwd, { when: "after-undo", run, undoTo: n });
      if (!after) throw new CheckpointError(502, `the folder was put back to checkpoint ${n}, but the checkpoint after it could not be recorded (see the record)`, "after-failed");
      return { before, after, to };
    });
  }

  /** Remove an agent's snapshots and say so in the record. The record itself is kept. */
  clear(id: string, reason: string): Promise<ClearedEntry> {
    return this.serial(id, async () => {
      rmSync(this.repoOf(id), { recursive: true, force: true });
      const line: ClearedEntry = { kind: "cleared", at: new Date().toISOString(), reason };
      this.append(id, line);
      return line;
    });
  }
}
