import { outputNeverEnded, readProcess } from "../child-output";
import { appendFileSync, existsSync, lstatSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

import { git, githubRepoOf, mainCheckout, real, type Run, type RunResult } from "../readers/repo";

// Read-only repo questions live with the readers (#85); re-exported here for the agent host.
export { git, githubRepoOf, mainCheckout, type Run, type RunResult };

export const spawnRun: Run = async (cmd, args, opts) => {
  try {
    const p = Bun.spawn([cmd, ...args], { cwd: opts?.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const { stdout, stderr, code, ended } = await readProcess(p, cmd);
    if (!ended) return { code: 125, stdout: "", stderr: outputNeverEnded(`${cmd} ${args[0] ?? ""}`) };
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: "", stderr: (e as Error).message };
  }
};

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

/**
 * The local default branch against origin's, as last fetched (#136). No fetch is made: it is a
 * network call, and an SSH remote may not answer the server. `startFrom` is the ref the
 * worktree should start from:
 *   same      both at one commit                           → the local branch
 *   behind    local is an ancestor of origin's (pull only)  → origin's: nothing local is lost, and
 *                                                              it is the tip the PR merges into
 *   ahead     origin's is an ancestor of local's            → the local branch (its unpushed commits
 *                                                              go into the PR; said so)
 *   diverged  each has commits the other lacks              → none: refused, not guessed
 *   no-local  only origin's exists                          → origin's
 *   unknown   origin's was never fetched, or git could not compare → the local branch, and the
 *             summary says the comparison could not be made (never "up to date")
 */
export interface UpstreamCompare {
  state: "same" | "behind" | "ahead" | "diverged" | "no-local" | "unknown";
  base: string;
  localSha?: string;
  originSha?: string;
  /** Commits on origin's branch that the local one lacks, and the other way round. */
  behind: number;
  ahead: number;
  /** When this checkout last updated origin's branch (its reflog), if git recorded it. */
  fetchedAt?: string;
  /** The ref the worktree starts from (`main` or `origin/main`), or null when refused. */
  startFrom: string | null;
  startSha?: string;
  /** One sentence for the plan, the dialog and the agent's prompt. */
  summary: string;
}

const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;

export async function compareWithOrigin(run: Run, main: string, base: string): Promise<UpstreamCompare> {
  const sha = async (ref: string) => {
    const r = await run("git", ["-C", main, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return r.code === 0 ? r.stdout.trim() : undefined;
  };
  const localSha = await sha(`refs/heads/${base}`);
  const originSha = await sha(`refs/remotes/origin/${base}`);
  const o = `origin/${base}`;
  let fetchedAt: string | undefined;
  if (originSha) {
    const r = await run("git", ["-C", main, "reflog", "show", "-n1", "--date=iso-strict", "--format=%gd", `refs/remotes/origin/${base}`]);
    fetchedAt = r.code === 0 ? /@\{(.+)\}/.exec(r.stdout.trim())?.[1] : undefined;
  }
  const asOf = `as of the last fetch${fetchedAt ? ` (${fetchedAt})` : ""}`;
  const at = (s: string) => s.slice(0, 12);
  if (!localSha && !originSha) {
    return { state: "unknown", base, behind: 0, ahead: 0, startFrom: null, summary: `${main} has neither a local ${base} nor a fetched ${o} to start from` };
  }
  if (!originSha) {
    return {
      state: "unknown", base, localSha, behind: 0, ahead: 0, startFrom: base, startSha: localSha,
      summary: `no ${o} has been fetched in this checkout, so whether ${base} is behind it could not be checked; the worktree starts from the local ${base} at ${at(localSha!)}`,
    };
  }
  if (!localSha) {
    return {
      state: "no-local", base, originSha, behind: 0, ahead: 0, fetchedAt, startFrom: o, startSha: originSha,
      summary: `there is no local ${base}; the worktree starts from ${o} at ${at(originSha)}, ${asOf}`,
    };
  }
  const r = await run("git", ["-C", main, "rev-list", "--left-right", "--count", `refs/heads/${base}...refs/remotes/origin/${base}`]);
  const m = r.code === 0 ? /^(\d+)\s+(\d+)\s*$/.exec(r.stdout.trim()) : null;
  if (!m) {
    return {
      state: "unknown", base, localSha, originSha, behind: 0, ahead: 0, fetchedAt, startFrom: base, startSha: localSha,
      summary: `git could not compare ${base} with ${o} (${(r.stderr || r.stdout).trim().slice(0, 200) || `exit ${r.code}`}); the worktree starts from the local ${base} at ${at(localSha)}`,
    };
  }
  const ahead = Number(m[1]);
  const behind = Number(m[2]);
  const common = { base, localSha, originSha, behind, ahead, fetchedAt };
  if (!ahead && !behind) {
    return { ...common, state: "same", startFrom: base, startSha: localSha, summary: `${base} is at ${o}, ${asOf}; the worktree starts from ${base} at ${at(localSha)}` };
  }
  if (!ahead) {
    return {
      ...common, state: "behind", startFrom: o, startSha: originSha,
      summary: `the local ${base} is ${commits(behind)} behind ${o} ${asOf}; the worktree starts from ${o} at ${at(originSha)}, not the local ${base} at ${at(localSha)}`,
    };
  }
  if (!behind) {
    return {
      ...common, state: "ahead", startFrom: base, startSha: localSha,
      summary: `the local ${base} is ${commits(ahead)} ahead of ${o} ${asOf} (not pushed); the worktree starts from the local ${base} at ${at(localSha)}, so the PR carries those commits too`,
    };
  }
  return {
    ...common, state: "diverged", startFrom: null,
    summary: `the local ${base} and ${o} have diverged ${asOf}: ${base} has ${commits(ahead)} that ${o} lacks, and is ${commits(behind)} behind it`,
  };
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
