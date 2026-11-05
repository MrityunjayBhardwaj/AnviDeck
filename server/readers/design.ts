/**
 * The Design screen's own reads (#87). Read only: it runs `git log` on the measured project
 * (at the commit the guard measured, never its working tree) and reads Claude Code's settings files.
 *
 *   readFixCost  — the cost curve: files touched per fix, per component pair, from git history.
 *   readEditHooks — which hooks the settings files register for an edit (they run in parallel).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import type { StructureMeasured, StructureProjectResponse } from "../../shared/structure-types";
import type { EditHook, EditHooksAnswer, FixCostAnswer, FixPoint, HookSettingsFile, PairCost, Trend } from "../../shared/design-types";
import type { Run } from "./repo";
import { timedRun } from "./work";
import { readStructure } from "./structure";
import { isAbsent } from "./read-status";

const HOME = process.env.HOME ?? homedir();
export const SETTINGS_PATH = join(HOME, ".claude", "settings.json");

// ── the cost curve ─────────────────────────────────────────────────────────────────────────

/** A fix, by its subject: the bug gitmoji, or a subject that starts with "fix" ("fix:", "fix(x):", "Fix the…"). */
export const FIX_SUBJECT = /^(?:🐛|fix\b)/i;

export const PREDICATE =
  "a fix is a commit whose subject starts with 🐛 or the word fix; it is in a pair's concern when it changes files in both components of the pair (files mapped by the design's own file and folder lists); its cost is the number of files in the package it changed";
export const TREND_RULE =
  "rising when the later half of the fixes touched at least one file more on average than the earlier half, falling when one fewer, else flat; fewer than 3 fixes is too few to say";

export interface Commit {
  sha: string;
  date: string;
  subject: string;
  /** Paths as git prints them: relative to the repository root. */
  files: string[];
}

const RS = "\x1e";
const US = "\x1f";
/** The --format the parser below reads: a record separator, then sha, date and subject. */
export const LOG_FORMAT = `--format=${RS}%H${US}%aI${US}%s`;

/** Parse `git log --name-only` output written with LOG_FORMAT. Newest first, as git prints it. */
export function parseLog(out: string): Commit[] {
  return out
    .split(RS)
    .filter((b) => b.trim())
    .map((b) => {
      const [head, ...rest] = b.split("\n");
      const [sha = "", date = "", subject = ""] = head.split(US);
      return { sha, date, subject, files: rest.map((l) => l.trim()).filter(Boolean) };
    });
}

export interface ComponentMap {
  /** The design's root inside the package ("src/"), from the guard's modules (path minus rel). */
  root: string;
  components: { name: string; dirs: string[]; files: string[] }[];
}

/** The component a package-relative path ("src/engine/x.ts") is in: a listed file first, then the longest listed folder. */
export function componentOf(pkgPath: string, map: ComponentMap): string | null {
  if (!pkgPath.startsWith(map.root)) return null;
  const rel = pkgPath.slice(map.root.length);
  for (const c of map.components) if (c.files.includes(rel)) return c.name;
  let best: { name: string; len: number } | null = null;
  for (const c of map.components)
    for (const d of c.dirs) if ((rel === d || rel.startsWith(d.replace(/\/$/, "") + "/")) && (!best || d.length > best.len)) best = { name: c.name, len: d.length };
  return best?.name ?? null;
}

/** The trend of a files-per-fix series, oldest first, by TREND_RULE. */
export function trendOf(files: number[]): Trend {
  if (files.length < 3) return "too few";
  const half = Math.floor(files.length / 2);
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const d = mean(files.slice(files.length - half)) - mean(files.slice(0, half));
  return d >= 1 ? "rising" : d <= -1 ? "falling" : "flat";
}

/**
 * Files per fix for each pair, from commits on the package (newest first, as git gives them).
 * `pkgRel` is the package's path inside the repository ("packages/editor").
 */
export function costByPair(commits: Commit[], pkgRel: string, map: ComponentMap, pairs: { pair: string; count: number }[]) {
  const prefix = pkgRel ? pkgRel.replace(/\/$/, "") + "/" : "";
  const fixes = commits.filter((c) => FIX_SUBJECT.test(c.subject.trim()));
  let unmappedFiles = 0;
  const touched = fixes.map((c) => {
    const inPkg = c.files.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length));
    const comps = new Set<string>();
    for (const f of inPkg) {
      const k = componentOf(f, map);
      if (k) comps.add(k);
      else unmappedFiles++;
    }
    return { c, files: inPkg.length, comps };
  });
  const out: PairCost[] = pairs.map(({ pair, count }) => {
    const [a, b] = pair.split(" -> ");
    const hits: FixPoint[] = touched
      .filter((t) => t.comps.has(a) && t.comps.has(b))
      .reverse()
      .map((t) => ({ sha: t.c.sha, date: t.c.date, subject: t.c.subject, files: t.files }));
    return { pair, held: count, fixes: hits, trend: trendOf(hits.map((h) => h.files)) };
  });
  return { fixCommits: fixes.length, unmappedFiles, pairs: out };
}

export function componentMapOf(s: StructureMeasured): ComponentMap | null {
  const m = s.modules.find((x) => x.path.endsWith(x.rel));
  if (!m) return null;
  return { root: m.path.slice(0, m.path.length - m.rel.length), components: s.components.map((c) => ({ name: c.name, dirs: c.dirs, files: c.files })) };
}

export interface FixCostOptions {
  run?: Run;
  /** For tests: the structure answer to read at, instead of asking the guard. */
  structure?: (project: string) => Promise<StructureProjectResponse>;
}

export async function readFixCost(project: string, opts: FixCostOptions = {}): Promise<FixCostAnswer> {
  const run = opts.run ?? timedRun(60_000);
  const s = await (opts.structure ?? ((p) => readStructure(p)))(project);
  if (s.status === "no-design") return { status: "no-design", project, reason: "the project registers no design with the structure guard: there are no components, so no pair a fix could belong to" };
  if (s.status !== "measured") return { status: "not-measured", project, reason: `the structure is not measured, so there are no components to sort fixes into: ${s.reason}` };
  const map = componentMapOf(s);
  if (!map) return { status: "not-measured", project, reason: "the guard's module list gave no path to tell the design's root from" };
  const t0 = Date.now();
  const top = await run("git", ["-C", s.package.dir, "rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { status: "unreadable", project, reason: `git rev-parse in ${s.package.dir}: ${(top.stderr || top.stdout).trim() || `exit ${top.code}`}` };
  const repo = top.stdout.trim();
  const pkgRel = relative(repo, s.package.dir);
  const args = ["-C", repo, "log", s.measuredAt.sha, "--no-merges", LOG_FORMAT, "--name-only", "--", pkgRel || "."];
  const r = await run("git", args);
  if (r.code !== 0) return { status: "unreadable", project, reason: `git log: ${(r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.code}`}` };
  const commits = parseLog(r.stdout);
  const cost = costByPair(commits, pkgRel, map, s.byPair);
  return {
    status: "measured",
    project,
    package: s.package.dir,
    at: { ref: s.measuredAt.ref, sha: s.measuredAt.sha, date: s.measuredAt.date },
    predicate: PREDICATE,
    trendRule: TREND_RULE,
    commits: commits.length,
    ...cost,
    command: `git ${args.map((a) => (/[\s\x1e\x1f%]/.test(a) ? JSON.stringify(a) : a)).join(" ")}`,
    ms: Date.now() - t0,
  };
}

// ── the hooks an edit passes through ─────────────────────────────────────────────────────────

const EDIT_TOOLS = ["Write", "Edit", "MultiEdit"];

/** Does a settings matcher (a regex over tool names, or empty for every tool) cover an edit tool? */
export function coversEdit(matcher: unknown): boolean {
  if (matcher === undefined || matcher === null || matcher === "" || matcher === "*") return true;
  if (typeof matcher !== "string") return false;
  try {
    const re = new RegExp(`^(?:${matcher})$`);
    return EDIT_TOOLS.some((t) => re.test(t));
  } catch {
    return EDIT_TOOLS.some((t) => matcher.split("|").includes(t));
  }
}

/** The script a hook command runs ("node \"/x/structure-guard-hook.js\"" → "structure-guard-hook.js"). */
export function hookName(command: string): string {
  const m = /([\w.-]+\.(?:c?js|mjs|ts|sh|py))\b/.exec(command);
  return m ? m[1] : basename(command.trim().split(/\s+/)[0] ?? command);
}

/**
 * PreToolUse hooks registered for an edit, as the file lists them. Claude Code starts all the
 * matching hooks at once, so this order is not the order they run in.
 */
export function editHooksOf(settings: unknown, file = ""): EditHook[] {
  const pre = (settings as { hooks?: { PreToolUse?: unknown } })?.hooks?.PreToolUse;
  if (!Array.isArray(pre)) return [];
  const out: EditHook[] = [];
  for (const group of pre) {
    if (!group || typeof group !== "object" || !coversEdit((group as { matcher?: unknown }).matcher)) continue;
    const hooks = (group as { hooks?: unknown }).hooks;
    if (!Array.isArray(hooks)) continue;
    for (const h of hooks) {
      const command = typeof (h as { command?: unknown })?.command === "string" ? (h as { command: string }).command : "";
      if (command) out.push({ matcher: String((group as { matcher?: unknown }).matcher ?? ""), name: hookName(command), command, file });
    }
  }
  return out;
}

/** Where Claude Code's managed (policy) settings live on this platform. */
export const MANAGED_SETTINGS =
  process.platform === "darwin" ? "/Library/Application Support/ClaudeCode/managed-settings.json" : process.platform === "win32" ? "C:\\ProgramData\\ClaudeCode\\managed-settings.json" : "/etc/claude-code/managed-settings.json";

/** Places Claude Code loads hooks from that this reader does not read. */
export const HOOKS_NOT_READ = "hooks from plugins and from skill or agent frontmatter are not read here";

export interface SettingsFileRef {
  scope: HookSettingsFile["scope"];
  /** null when the file cannot be located (the project's folder is not known). */
  file: string | null;
  reason?: string;
}

/**
 * The settings files Claude Code loads hooks from, for a project: yours, the project's shared and
 * local files, and the managed policy file. `projectDir` null means the project's folder is not
 * known, so its two files cannot be read; that is said, not skipped.
 */
export function settingsFiles(projectDir: string | null, why = "the project's folder is not known"): SettingsFileRef[] {
  return [
    { scope: "user", file: SETTINGS_PATH },
    { scope: "project", file: projectDir ? join(projectDir, ".claude", "settings.json") : null, reason: why },
    { scope: "project-local", file: projectDir ? join(projectDir, ".claude", "settings.local.json") : null, reason: why },
    { scope: "managed", file: MANAGED_SETTINGS },
  ];
}

/** Read every settings file named and collect the hooks registered for edits in each. */
export function readEditHooks(refs: SettingsFileRef[] = settingsFiles(null)): EditHooksAnswer {
  const readAt = new Date().toISOString();
  const files: HookSettingsFile[] = [];
  const hooks: EditHook[] = [];
  for (const ref of refs) {
    if (!ref.file) {
      files.push({ scope: ref.scope, file: `(${ref.scope} settings)`, status: "unreadable", reason: ref.reason ?? "not located" });
      continue;
    }
    let text: string;
    try {
      text = readFileSync(ref.file, "utf8");
    } catch (e) {
      if (isAbsent(e)) files.push({ scope: ref.scope, file: ref.file, status: "absent" });
      else files.push({ scope: ref.scope, file: ref.file, status: "unreadable", reason: (e as NodeJS.ErrnoException).code ?? (e as Error).message });
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      files.push({ scope: ref.scope, file: ref.file, status: "unreadable", reason: `not JSON: ${(e as Error).message}` });
      continue;
    }
    files.push({ scope: ref.scope, file: ref.file, status: "read" });
    hooks.push(...editHooksOf(json, ref.file));
  }
  return { readAt, files, hooks, notRead: HOOKS_NOT_READ };
}
