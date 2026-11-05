/**
 * Which project a call on a blocked edit belongs to (#179), and whether its key names a refusal
 * anvi's instrument counted (#178). Used by POST /api/refusals/:key/call before the line is
 * appended; reads only (git rev-parse, the structure registry, the refusals cache).
 *
 * The project, first that answers:
 *   1. the page's, when the page names one;
 *   2. the measured answer that lists the key: a tool_use id names one blocked edit, so the
 *      answer's project is the refusal's (an agent started in another repo that edits a package
 *      is counted under that package, and so is its call);
 *   3. the registered package holding the edited file (`refusal.path`), owned the way the
 *      structure reader owns a package;
 *   4. the agent's folder through its git common dir to the main checkout, and only a known project
 *      that IS that checkout: a parent folder that is a project only because Claude was once run
 *      there (/private/tmp, ~/Documents/projects) never claims it. Else the main checkout's name,
 *      and the record says so.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { discoverProjects, ownerOf, readRegistry, type Project } from "./readers/structure";
import type { RefusalsMeasured } from "../shared/refusal-types";

const realOr = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const within = (file: string, dir: string) => {
  const f = realOr(file);
  const d = realOr(dir);
  return f === d || f.startsWith(d + sep);
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

/** What the structure registry knows: its packages and the projects that own them (injectable for tests). */
export interface Known {
  projects: () => Project[];
  packages: () => { dir: string }[];
}

export function knownFromRegistry(): Known {
  let reg: ReturnType<typeof readRegistry> | undefined;
  const r = () => (reg ??= readRegistry());
  return { projects: () => discoverProjects(r()), packages: () => r().packages };
}

/** The project of an agent's folder: the known project that is its repository's main checkout, else that checkout's name. */
export function projectOfFolder(cwd: string, projects: () => Project[] = () => discoverProjects(readRegistry())): ProjectPick {
  const folder = cwd.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? cwd;
  const main = mainCheckout(cwd);
  if ("reason" in main) return { project: folder, projectFrom: `the folder's name: ${main.reason}, so no project owns it` };
  // Only the checkout itself: ownerOf's "deepest folder that holds it" lets a parent that is a
  // project only because Claude was once run there claim every repository below it.
  const owner = projects().find((p) => realOr(p.path) === main.path);
  if (!owner)
    return { project: basename(main.path), projectFrom: `the main checkout's name: ${cwd} → its git common dir's checkout ${main.path}, which is no known project` };
  return { project: owner.name, projectFrom: `${cwd} → its git common dir's checkout ${main.path} → project ${owner.path}` };
}

/** The project owning the registered package that holds `path` (an absolute file), or null when none does. */
export function projectOfFile(path: string, known: Known): ProjectPick | null {
  let pkg: string | null = null;
  for (const p of known.packages()) if (within(path, p.dir) && (!pkg || realOr(p.dir).length > realOr(pkg).length)) pkg = p.dir;
  if (!pkg) return null;
  const owner = ownerOf(pkg, known.projects());
  if (!owner) return null;
  return { project: owner.name, projectFrom: `the edited file ${path} → registered package ${pkg} → project ${owner.path}` };
}

/** The measured answer that lists this key, from any project's answers held. */
export function answerListing(key: string, answers: RefusalsMeasured[]): RefusalsMeasured | undefined {
  return answers.find((a) => a.refusals.some((r) => r.key === key));
}

/**
 * The project of a call the page did not name one for (steps 2–4 above), or null when the call
 * gives nothing to find it from (no listed key, no absolute edited file, no absolute folder).
 */
export function locateProject(ctx: { key: string; cwd?: string; path?: string }, answers: RefusalsMeasured[], known: Known): ProjectPick | null {
  const hit = answerListing(ctx.key, answers);
  if (hit) return { project: hit.project, projectFrom: `anvi's structure-refusals.js, measured ${hit.instrument.ranAt} in package ${hit.package}, lists this key under project ${hit.project}` };
  if (ctx.path && isAbsolute(ctx.path)) {
    const byFile = projectOfFile(ctx.path, known);
    if (byFile) return byFile;
  }
  if (ctx.cwd && isAbsolute(ctx.cwd)) return projectOfFolder(ctx.cwd, known.projects);
  return null;
}

export type KeyCheck = { state: "listed"; measuredAt: string } | { state: "not-listed"; reason: string } | { state: "unverified"; reason: string };

/**
 * Check a refusal key against the measured answers held (any project's: a tool_use id is unique).
 * Refused ("not-listed") only when an answer could have seen the refusal: it measured the package
 * that holds the edited file (`refusal.path`), its window holds the refusal's time, and it ran
 * after it, and it does not list the key. Otherwise unverified with the reason, never refused on a
 * guess: a refusal newer than every answer is real and simply not measured yet, and an answer of
 * another package could never list it.
 */
export function checkKey(key: string, refusal: { at?: string; path?: string } | undefined, answers: RefusalsMeasured[]): KeyCheck {
  const hit = answerListing(key, answers);
  if (hit) return { state: "listed", measuredAt: hit.instrument.ranAt };
  if (!answers.length) return { state: "unverified", reason: "no measured answer of anvi's structure-refusals.js was held when the call was made" };
  const at = refusal?.at;
  const t = at ? Date.parse(at) : NaN;
  if (Number.isNaN(t)) return { state: "unverified", reason: `the call did not say when the refusal happened, so none of the ${answers.length} measured answer(s) could be checked against it` };
  const path = refusal?.path;
  if (!path || !isAbsolute(path))
    return { state: "unverified", reason: `the call did not name the edited file's absolute path, so which package's answer should list it is unknown (${answers.length} measured answer(s) held)` };
  const ofPackage = answers.filter((a) => within(path, a.package));
  if (!ofPackage.length) return { state: "unverified", reason: `no measured answer is of the package holding ${path}` };
  const covering = ofPackage.filter((a) => Date.parse(a.window.since) <= t && t < Date.parse(a.window.until ?? a.instrument.ranAt) && t < Date.parse(a.instrument.ranAt));
  if (!covering.length) return { state: "unverified", reason: `no measured answer of the package holding ${path} covers ${at} (the refusal is outside their windows or newer than their runs)` };
  const a = covering[0];
  return { state: "not-listed", reason: `anvi's structure-refusals.js, measured ${a.instrument.ranAt} over ${a.window.since} – ${a.window.until ?? "its run"} in package ${a.package}, lists no refusal with key ${key}` };
}
