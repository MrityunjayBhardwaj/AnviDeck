import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { discoverProjects } from "./projects";

/**
 * Questions about a project's repository that only read: which checkout is its main one, which
 * GitHub repo its origin is, and which projects AnviDeck knows. Shared by the agent host's
 * start-from-issue (#78, server/agents/*, which re-exports these) and the Work screen's readers
 * (#85), so a reader never has to import the agent host to ask them.
 */

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs a command and never throws: a missing binary is code 127 with the reason in stderr. */
export type Run = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<RunResult>;

/** git -C <dir> ...: stdout trimmed, or an Error carrying git's own words. */
export async function git(run: Run, dir: string, args: string[]): Promise<string> {
  const r = await run("git", ["-C", dir, ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  return r.stdout.trim();
}

/** The real path of `p`, or `p` itself when it cannot be resolved. */
export const real = (p: string) => {
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

export interface KnownProject {
  name: string;
  path: string;
}

/** AnviDeck's project list (the same discovery GET /api/projects uses): name and resolved path. */
export function knownProjects(): KnownProject[] {
  const d = discoverProjects();
  return d.status === "ok" ? d.projects.filter((p) => p.decoded).map((p) => ({ name: p.name, path: p.decoded! })) : [];
}
