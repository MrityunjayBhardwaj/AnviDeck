import { appendFileSync, existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existingDirs } from "../../shared/anvi-paths";

/**
 * The git side of starting an agent from an issue (#78): the issue's own worktree and branch,
 * and the links that give the worktree its project's anvi knowledge.
 *
 * What a worktree needs is anvi's rule, not ours. anvi's hooks (`~/.claude/anvi/hooks/anvi-paths.js`,
 * `worktreeLinkGap`) say: a LINKED worktree gets its project's knowledge only through explicit
 * links, `.anvi` and `ref` at the worktree root, each pointing where the MAIN checkout's resolves
 * (realpath). They never resolve a worktree to its main checkout, and the resolver keys the store
 * candidate on the folder's basename (`issue-78`), so without a link the hooks find nothing.
 * After linking we ask anvi's own `worktreeLinkGap` what is still missing (see anviLinkCheck).
 */

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs a command and never throws: a missing binary is code 127 with the reason in stderr. */
export type Run = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<RunResult>;

export const spawnRun: Run = async (cmd, args, opts) => {
  try {
    const p = Bun.spawn([cmd, ...args], { cwd: opts?.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: "", stderr: (e as Error).message };
  }
};

/** git -C <dir> ...: stdout trimmed, or an Error carrying git's own words. */
export async function git(run: Run, dir: string, args: string[]): Promise<string> {
  const r = await run("git", ["-C", dir, ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  return r.stdout.trim();
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** The main checkout of the repository `dir` is in (a linked worktree's main, or the repo itself). */
export async function mainCheckout(run: Run, dir: string): Promise<string> {
  const common = await git(run, dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  // A repo whose common dir is not "<checkout>/.git" (bare, submodule) has no main checkout.
  if (!common.endsWith("/.git")) throw new Error(`${dir} is not in a normal git checkout (git dir ${common})`);
  return real(dirname(common));
}

/** "owner/name" of a GitHub remote URL (https or ssh), or null for anything else. */
export function githubRepoOf(url: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Branch name for an issue: `<kind>/<n>-<slug>`. The kind follows the owner's convention
 * (fix/, feat/, chore/) and is read from the issue's labels, the one place it is stated:
 * a `bug` label → fix, `chore` or `documentation` → chore, anything else → feat.
 */
export function branchFor(issue: { number: number; title: string; labels?: string[] }): string {
  const labels = (issue.labels ?? []).map((l) => l.toLowerCase());
  const kind = labels.includes("bug") ? "fix" : labels.some((l) => l === "chore" || l === "documentation") ? "chore" : "feat";
  return `${kind}/${issue.number}-${slugOf(issue.title)}`;
}

/** Lowercase words joined by "-", at most 40 characters, cut at a word boundary. "issue" when nothing is left. */
export function slugOf(title: string): string {
  // A leading "Area:" prefix ("Workspace: ...") names the area, not the change.
  const words = title.replace(/^[^:]{1,30}:\s+/, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  let out = "";
  for (const w of words) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > 40) break;
    out = next;
  }
  return out || (words[0]?.slice(0, 40) ?? "") || "issue";
}

/** Where an issue's worktree goes: beside Claude Code's own worktrees, one folder per issue. */
export function worktreePathFor(main: string, issue: number): string {
  return join(main, ".claude", "worktrees", `issue-${issue}`);
}

/** The project's default branch as origin names it (origin/HEAD), else "main". */
export async function defaultBranch(run: Run, main: string): Promise<string> {
  const r = await run("git", ["-C", main, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const v = r.code === 0 ? r.stdout.trim().replace(/^origin\//, "") : "";
  return v || "main";
}

/** Does a local branch or a remote-tracking branch of this name exist? Names which. */
export async function branchExists(run: Run, main: string, branch: string): Promise<string | null> {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    const r = await run("git", ["-C", main, "show-ref", "--verify", "--quiet", ref]);
    if (r.code === 0) return ref;
  }
  return null;
}

/**
 * Uncommitted changes that matter for this start: changes to tracked files in the main checkout
 * while it is on the base branch. The worktree starts from the base branch's last commit, so that
 * work would be missing from it. Untracked files, and changes on another branch, do not reach the
 * base and are not counted. Returns the changed paths (empty = nothing that matters).
 */
export async function dirtyOnBase(run: Run, main: string, base: string): Promise<{ onBase: boolean; current: string; changed: string[] }> {
  const current = (await run("git", ["-C", main, "symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
  if (current !== base) return { onBase: false, current, changed: [] };
  // Read raw, never trimmed: each porcelain line starts with its two status columns (" M x").
  const r = await run("git", ["-C", main, "status", "--porcelain=v1", "--untracked-files=no"]);
  if (r.code !== 0) throw new Error(`git status: ${r.stderr.trim()}`);
  const changed = r.stdout.split("\n").filter(Boolean).map((l) => l.slice(3));
  return { onBase: true, current, changed };
}

export type LinkState =
  /** We made the symlink and it resolves to the main checkout's directory. */
  | "linked"
  /** The kind is tracked in the repository: the worktree has the branch's own copy, no link is made. */
  | "tracked"
  /** The main checkout resolves nothing for this kind: there is nothing to link. */
  | "none"
  /** Something else already sits there: left alone, and it does not resolve where the main checkout's does. */
  | "blocked";

export interface LinkResult {
  kind: ".anvi" | "ref";
  state: LinkState;
  /** The path in the worktree. */
  path: string;
  /** What the main checkout resolves (realpath), when it resolves anything. */
  target?: string;
  /** What the worktree path resolves to now (realpath), when it exists. */
  resolvesTo?: string;
  /** True when the path in the worktree exists and resolves to `target` (linked) or exists (tracked). */
  resolves: boolean;
  note: string;
}

export const LINKED_KINDS = [".anvi", "ref"] as const;

/**
 * Link `.anvi` and `ref` into a fresh worktree, as anvi's hooks expect (header). For each kind:
 * the main checkout's resolved directory (shared/anvi-paths, which mirrors anvi's resolver) is the
 * target; a tracked directory of that name is the branch's own and is left as it is; otherwise a
 * symlink `<worktree>/<kind> → target` is made, git is told to ignore it when nothing else does
 * (in the repository's shared info/exclude, as anvi's notice suggests), and the link is read back.
 */
export async function linkKnowledge(run: Run, main: string, worktree: string): Promise<LinkResult[]> {
  const out: LinkResult[] = [];
  for (const kind of LINKED_KINDS) {
    const path = join(worktree, kind);
    const theirs = existingDirs(main, kind)[0];
    const target = theirs ? real(theirs) : undefined;
    const tracked = (await run("git", ["-C", worktree, "ls-files", "--error-unmatch", "--", kind])).code === 0;
    if (tracked) {
      out.push({
        kind, state: "tracked", path, target, resolvesTo: existsSync(path) ? real(path) : undefined, resolves: existsSync(path),
        note: `${kind} is tracked in the repository, so the worktree has the branch's own copy; no link is made`,
      });
      continue;
    }
    if (!target) {
      out.push({ kind, state: "none", path, resolves: false, note: `the main checkout resolves no ${kind}, so there is nothing to link` });
      continue;
    }
    let present = false;
    try {
      lstatSync(path);
      present = true;
    } catch {
      present = false;
    }
    if (present) {
      const now = existsSync(path) ? real(path) : undefined;
      out.push({
        kind, state: now === target ? "linked" : "blocked", path, target, resolvesTo: now, resolves: now === target,
        note: now === target ? `${kind} already resolves to ${target}` : `${path} already exists and resolves to ${now ?? "nothing"}; left as it is`,
      });
      continue;
    }
    symlinkSync(target, path);
    const ignored = (await run("git", ["-C", worktree, "check-ignore", "-q", "--", kind])).code === 0;
    let excluded = "";
    if (!ignored) {
      const common = await git(run, worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      const exclude = join(common, "info", "exclude");
      const line = `/${kind}`;
      const has = existsSync(exclude) && readFileSync(exclude, "utf8").split("\n").includes(line);
      if (!has) {
        const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
        appendFileSync(exclude, `${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`);
      }
      excluded = `; added ${line} to ${exclude} so git does not show the link as a new file`;
    }
    const resolvesTo = existsSync(path) ? real(path) : undefined;
    out.push({
      kind, state: "linked", path, target, resolvesTo, resolves: resolvesTo === target,
      note: `${path} → ${readlinkSync(path)}${excluded}`,
    });
  }
  return out;
}

/** What anvi's own resolver says a worktree is still missing, or why it could not be asked. */
export interface AnviLinkCheck {
  /** "asked": anvi's worktreeLinkGap answered. "not checked": the hooks are not installed or the call failed. */
  state: "asked" | "not checked";
  reason?: string;
  missing: string[];
  differs: { kind: string; have: string; target: string }[];
}

export const ANVI_PATHS_HOOK = join(homedir(), ".claude", "anvi", "hooks", "anvi-paths.js");

/** Ask anvi's `worktreeLinkGap` (the function its hooks use) about the worktree. */
export async function anviLinkCheck(run: Run, worktree: string, hook = ANVI_PATHS_HOOK): Promise<AnviLinkCheck> {
  if (!existsSync(hook)) return { state: "not checked", reason: `${hook} is not installed`, missing: [], differs: [] };
  const script = "const p=require(process.argv[1]);const g=p.worktreeLinkGap(process.argv[2]);process.stdout.write(JSON.stringify(g))";
  const r = await run("node", ["-e", script, hook, worktree]);
  if (r.code !== 0) return { state: "not checked", reason: `anvi's worktreeLinkGap failed: ${r.stderr.trim().slice(0, 300)}`, missing: [], differs: [] };
  try {
    const g = JSON.parse(r.stdout || "null") as null | { missing: { kind: string }[]; differs: { kind: string; have: string; target: string }[] };
    return { state: "asked", missing: g ? g.missing.map((m) => m.kind) : [], differs: g ? g.differs : [] };
  } catch {
    return { state: "not checked", reason: `anvi's worktreeLinkGap answered something that is not JSON: ${r.stdout.slice(0, 200)}`, missing: [], differs: [] };
  }
}
