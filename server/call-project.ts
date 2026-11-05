/**
 * Which project a call on a blocked edit belongs to (#179), and whether its key names a refusal
 * anvi's instrument counted (#178). Used by POST /api/refusals/:key/call before the line is
 * appended; reads only (git rev-parse, the structure registry, the refusals cache).
 *
 * The project: the page's, when the page names one. Otherwise the agent's folder is mapped the way
 * the structure reader maps a package: through its git common dir to the main checkout (so every
 * worktree of a repository is one project), then to the deepest known project that holds it. Only
 * when nothing owns it is the folder's own name used, and the record says so.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { discoverProjects, ownerOf, readRegistry, type Project } from "./readers/structure";
import type { RefusalsMeasured } from "../shared/refusal-types";

const realOr = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** The main checkout of the repository `dir` is in (its git common dir's parent), or why there is none. */
export function mainCheckout(dir: string): { path: string } | { reason: string } {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--git-common-dir"], { encoding: "utf8" });
  if (r.status !== 0) return { reason: `${dir} is in no git repository (${(r.stderr || r.error?.message || `exit ${r.status}`).trim()})` };
  const out = r.stdout.trim();
  const common = realOr(isAbsolute(out) ? out : resolve(dir, out));
  // A bare repository's common dir is the repository itself; a checkout's is its .git folder.
  return { path: basename(common) === ".git" ? dirname(common) : common };
}

export interface ProjectPick {
  project: string;
  projectFrom: string;
}

/** The project of an agent's folder, as the structure reader would own it. */
export function projectOfFolder(cwd: string, projects: () => Project[] = () => discoverProjects(readRegistry())): ProjectPick {
  const folder = cwd.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? cwd;
  const main = mainCheckout(cwd);
  if ("reason" in main) return { project: folder, projectFrom: `the folder's name: ${main.reason}, so no project owns it` };
  const owner = ownerOf(main.path, projects());
  if (!owner) return { project: folder, projectFrom: `the folder's name: its main checkout ${main.path} is no known project` };
  return { project: owner.name, projectFrom: `${cwd} → its git common dir's checkout ${main.path} → project ${owner.path}` };
}

export type KeyCheck = { state: "listed"; measuredAt: string } | { state: "not-listed"; reason: string } | { state: "unverified"; reason: string };

/**
 * Check a refusal key against the measured answers held for the project. Refused ("not-listed")
 * only when an answer could have seen the refusal (its window holds the refusal's time and it was
 * measured after it) and does not list it; otherwise unverified with the reason, never refused on
 * a guess: a refusal newer than every answer is real and simply not measured yet.
 */
export function checkKey(key: string, at: string | undefined, answers: RefusalsMeasured[]): KeyCheck {
  const hit = answers.find((a) => a.refusals.some((r) => r.key === key));
  if (hit) return { state: "listed", measuredAt: hit.instrument.ranAt };
  if (!answers.length) return { state: "unverified", reason: "no measured answer of anvi's structure-refusals.js was held for this project when the call was made" };
  const t = at ? Date.parse(at) : NaN;
  if (Number.isNaN(t)) return { state: "unverified", reason: `the call did not say when the refusal happened, so none of the ${answers.length} measured answer(s) could be checked against it` };
  const covering = answers.filter((a) => Date.parse(a.window.since) <= t && t < Date.parse(a.window.until ?? a.instrument.ranAt) && t < Date.parse(a.instrument.ranAt));
  if (!covering.length) return { state: "unverified", reason: `no measured answer covers ${at} (the refusal is outside their windows or newer than their runs)` };
  const a = covering[0];
  return { state: "not-listed", reason: `anvi's structure-refusals.js, measured ${a.instrument.ranAt} over ${a.window.since} – ${a.window.until ?? "its run"} in package ${a.package}, lists no refusal with key ${key}` };
}
