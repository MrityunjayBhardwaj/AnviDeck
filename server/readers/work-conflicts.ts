import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Run } from "./repo";
import type { PairResult, PrConflicts } from "../../shared/work-types";

/**
 * "No conflict with other open PRs" (#85): git merge-tree of each open PR's head against its own
 * base's tip (a stacked PR's base is another PR's branch, not the default branch) and against
 * every other open PR's head.
 *
 * The commits are fetched into a scratch bare repository under ANVIDECK_WORK_TMP (default
 * /private/tmp/claude-501/anvideck-work), made once per repo with `git clone --bare --shared`
 * from the project's main checkout, so it borrows that checkout's objects and fetches only what
 * is missing. Nothing is written into the project's repository: no ref, no FETCH_HEAD, no object.
 * Fetches name their refspecs without a destination, so only the scratch repo's FETCH_HEAD
 * moves; no refs/remotes/pr/* ref is ever kept.
 */

export const WORK_TMP = process.env.ANVIDECK_WORK_TMP ?? "/private/tmp/claude-501/anvideck-work";

const said = (r: { stderr: string; stdout: string; code: number }) => (r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.code}`;

/** One clone or fetch at a time per scratch repo. */
const locks = new Map<string, Promise<unknown>>();
async function serial<T>(key: string, f: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(f, f);
  locks.set(key, next.catch(() => undefined));
  return next;
}

/** Parse `git merge-tree --write-tree --name-only --no-messages` by its exit code: 0 clean, 1 conflicts, else could not merge. */
export function pairFrom(r: { code: number; stdout: string; stderr: string }): PairResult {
  if (r.code === 0) return { state: "clean" };
  if (r.code === 1) {
    const files: string[] = [];
    for (const l of r.stdout.split("\n").slice(1)) {
      if (l === "") break;
      if (!files.includes(l)) files.push(l);
    }
    return { state: "conflict", files };
  }
  return { state: "unchecked", reason: `git merge-tree could not merge them: ${said(r)}` };
}

export interface ConflictHead {
  number: number;
  oid: string;
  /** The PR's own base branch and its tip. */
  base: { name: string; oid: string };
}

export interface ConflictInput {
  repo: string;
  /** The project's main checkout: the scratch repo borrows its objects. */
  main: string;
  heads: ConflictHead[];
  tmpRoot?: string;
}

/** Each PR's conflicts with its base and with every other open PR. Never throws: a failure is "unchecked" with the reason. */
export async function conflictsOf(run: Run, inp: ConflictInput): Promise<Map<number, PrConflicts>> {
  const out = new Map<number, PrConflicts>();
  if (!inp.heads.length) return out;
  const all = (reason: string) => {
    for (const h of inp.heads) out.set(h.number, { state: "unchecked", reason });
    return out;
  };
  const scratch = join(inp.tmpRoot ?? WORK_TMP, `${inp.repo.replace("/", "__")}.git`);
  const gd = ["--git-dir", scratch];
  const has = async (oid: string) => (await run("git", [...gd, "cat-file", "-e", `${oid}^{commit}`])).code === 0;

  const prep = await serial(scratch, async () => {
    if (!existsSync(join(scratch, "HEAD"))) {
      const c = await run("git", ["clone", "--bare", "--shared", "--quiet", inp.main, scratch]);
      if (c.code !== 0) return `could not make the scratch repository for merge checks: ${said(c)}`;
    }
    const want = new Set<string>();
    for (const h of inp.heads) {
      if (!(await has(h.oid))) want.add(`refs/pull/${h.number}/head`);
      if (!(await has(h.base.oid))) want.add(`refs/heads/${h.base.name}`);
    }
    if (want.size) {
      // Destination-less refspecs: only the scratch repo's FETCH_HEAD records them.
      const f = await run("git", [...gd, "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "-c", "gc.auto=0", "fetch", "--no-tags", "--quiet", `https://github.com/${inp.repo}.git`, ...want]);
      if (f.code !== 0) return `could not fetch the PR heads from GitHub: ${said(f)}`;
    }
    const present = new Set<string>();
    for (const h of inp.heads) for (const o of [h.oid, h.base.oid]) if (!present.has(o) && (await has(o))) present.add(o);
    return present;
  });
  if (typeof prep === "string") return all(prep);
  const present = prep;

  const mt = async (a: string, b: string) => pairFrom(await run("git", [...gd, "merge-tree", "--write-tree", "--name-only", "--no-messages", a, b]));
  const pair = new Map<string, PairResult>();
  const key = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  for (const h of inp.heads) {
    if (!present.has(h.oid)) {
      out.set(h.number, { state: "unchecked", reason: `PR #${h.number}'s head ${h.oid.slice(0, 12)} could not be fetched (it may have moved since GitHub was read)` });
      continue;
    }
    const others: { number: number; result: PairResult }[] = [];
    for (const o of inp.heads) {
      if (o.number === h.number) continue;
      if (!present.has(o.oid)) {
        others.push({ number: o.number, result: { state: "unchecked", reason: `PR #${o.number}'s head could not be fetched` } });
        continue;
      }
      const k = key(h.number, o.number);
      if (!pair.has(k)) pair.set(k, await mt(h.oid, o.oid));
      others.push({ number: o.number, result: pair.get(k)! });
    }
    const base: PairResult = present.has(h.base.oid)
      ? await mt(h.base.oid, h.oid)
      : { state: "unchecked", reason: `the base ${h.base.name} at ${h.base.oid.slice(0, 12)} could not be fetched (it may have moved since GitHub was read)` };
    out.set(h.number, { state: "checked", base, others });
  }
  return out;
}
