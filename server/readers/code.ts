/**
 * Project · Code (#88), the reads: the file tree of the package the design guard judges, at the
 * commit the design reader measured; one file at that commit with git blame; and the `file:line`
 * citations in the project's catalogues placed on the files they name.
 *
 * Read-only. It spawns only `git rev-parse`, `git ls-tree`, `git cat-file`, `git show` and
 * `git blame` against a named commit, never the working tree of another project (the edit
 * path, server/code-edit.ts, is the one place that reads a working copy, because it replaces it).
 *
 * What AnviDeck's agents edited is not read here: the agent host is not a reader's to import. The
 * route asks the host and passes the answer in (`agents`).
 */
import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { spawnSync } from "node:child_process";
import { listStructure, readStructure, safeRef, type MeasureOptions } from "./structure";
import { readCataloguesReport } from "./catalogue";
import type { StructureProjectResponse } from "../../shared/structure-types";
import type { AgentsRead, BlameCommit, CodeFileResponse, CodeTreeResponse, TrapCite, TrapsRead } from "../../shared/code-types";
import type { Catalogue } from "../../shared/types";

/** The rule an edit is judged by, in the words the page shows (server/code-edit.ts enforces it). */
export const EDIT_RULE =
  "Code writes a file only when no running AnviDeck agent works in the folder that holds it, or has edited the same file " +
  "in any checkout of this repository, and only when the file is still the one you opened (same sha256). " +
  "No live terminal Claude Code session may work in the folder that holds it either (what a terminal session edits " +
  "outside its own folder is not known). Only inside the project's own folder: no path outside it, no symlink, nothing under .git.";

/** Files larger than this are not shown (said, never cut). */
export const MAX_FILE_BYTES = 1024 * 1024;

const realOr = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

function git(cwd: string, args: string[], maxBuffer = 64 * 1024 * 1024): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer });
  return { ok: r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim() || (r.error?.message ?? "") };
}

export function gitTop(dir: string): string | null {
  const r = git(dir, ["rev-parse", "--show-toplevel"]);
  return r.ok ? realOr(r.out.trim()) : null;
}

/** A repository- or package-relative path as Code accepts it: no absolute path, no "..", no NUL. */
export function cleanRelPath(p: unknown): string | null {
  if (typeof p !== "string" || p === "" || p.length > 1000 || p.includes("\0") || p.startsWith("/") || p.includes("\\")) return null;
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..")) return null;
  return p;
}

/** The main checkout of a project AnviDeck knows (as the design reader knows it), or why not. */
export function projectTop(
  name: string,
  opts: { path?: string | null; registry?: { locked?: string; user?: string } } = {},
): { top: string; path: string } | { status: 404 | 409 | 503; reason: string } {
  const list = listStructure({ registry: opts.registry });
  if (list.status !== "ok") return { status: 503, reason: list.reason ?? "the project list could not be read" };
  let named = list.projects.filter((p) => p.name === name);
  if (!named.length) return { status: 404, reason: `no project named ${name} is known` };
  if (opts.path) named = named.filter((p) => realOr(p.path) === realOr(opts.path!));
  if (named.length !== 1)
    return { status: 409, reason: named.length ? `${named.length} projects are named ${name}; pass ?path=<dir>: ${named.map((p) => p.path).join(", ")}` : `${opts.path} is not a project named ${name}` };
  const top = gitTop(named[0].path);
  if (!top) return { status: 409, reason: `${named[0].path} is not inside a git checkout, so Code has no commit to read` };
  return { top, path: named[0].path };
}

// ── citations ────────────────────────────────────────────────────────────────────────────

const KIND: Record<string, string> = { hetvabhasa: "error pattern", vyapti: "invariant", krama: "lifecycle", dharana: "focus" };

/** `path/to/file.ext:12`, `file.ts:12-14`, `file.ts:295,329,608`. */
const CITE_RE = /([A-Za-z0-9_.@\/-]*[A-Za-z0-9_-]\.[A-Za-z][A-Za-z0-9]{0,4}):(\d+(?:\s*-\s*\d+)?(?:\s*,\s*\d+(?:\s*-\s*\d+)?)*)/g;
const MAX_RANGE = 400;

export function citesIn(text: string): { path: string; lines: number[]; cite: string }[] {
  const out: { path: string; lines: number[]; cite: string }[] = [];
  for (const m of text.matchAll(CITE_RE)) {
    const path = m[1].replace(/^\.\//, "");
    // A URL's host and port ("http://x.com:80") is not a file and line.
    if (path.startsWith("//") || text.slice(Math.max(0, (m.index ?? 0) - 1), m.index).endsWith(":")) continue;
    const lines: number[] = [];
    for (const part of m[2].split(",")) {
      const [a, b] = part.split("-").map((x) => Number(x.trim()));
      if (!a) continue;
      const end = b && b >= a && b - a <= MAX_RANGE ? b : a;
      for (let n = a; n <= end; n++) lines.push(n);
    }
    if (lines.length) out.push({ path, lines, cite: m[0] });
  }
  return out;
}

/**
 * Place every `file:line` citation of the catalogues on the files of the repository at the commit:
 * a citation names a file when the file's repository path is the cited path or ends with
 * "/<cited path>". It is placed only when exactly one file does; when several do, it is counted as
 * ambiguous, never guessed.
 */
export function placeCites(catalogues: Catalogue[], repoFiles: string[], packageRel: string): Omit<TrapsRead, "status" | "dir" | "errors"> {
  const placed: TrapCite[] = [];
  const ambiguous = new Map<string, number>();
  let ambiguousCites = 0;
  let cites = 0;
  let elsewhere = 0;
  const bySuffix = (p: string) => repoFiles.filter((f) => f === p || f.endsWith("/" + p));
  const memo = new Map<string, string[]>();
  for (const cat of catalogues) {
    for (const e of cat.entries) {
      const fields: [string, string][] = [["title", e.title], ...Object.entries(e.sections)];
      for (const [field, text] of fields) {
        for (const c of citesIn(text ?? "")) {
          cites++;
          let hit = memo.get(c.path);
          if (!hit) memo.set(c.path, (hit = bySuffix(c.path)));
          if (hit.length > 1) {
            ambiguousCites++;
            ambiguous.set(c.cite, hit.length);
            continue;
          }
          const f = hit[0];
          const inPkg = f !== undefined && (packageRel === "" || f.startsWith(packageRel + "/"));
          if (!inPkg) {
            elsewhere++;
            continue;
          }
          placed.push({
            catalogue: cat.name,
            kind: KIND[cat.name] ?? cat.name,
            entryId: e.id,
            title: e.title,
            field,
            cite: c.cite,
            file: packageRel ? f.slice(packageRel.length + 1) : f,
            lines: c.lines,
          });
        }
      }
    }
  }
  return { cites, placed, elsewhere, ambiguousCites, ambiguous: [...ambiguous].map(([cite, candidates]) => ({ cite, candidates })) };
}

// ── the tree ─────────────────────────────────────────────────────────────────────────────

export interface CodeTreeOptions {
  ref?: string | null;
  path?: string | null;
  package?: string | null;
  signal?: AbortSignal;
  registry?: { locked?: string; user?: string };
  /** What AnviDeck's agents edited in this package; the route asks the agent host. */
  agents?: (ctx: { top: string; packageDir: string; packageRel: string }) => AgentsRead;
  /** The design reader (the tests pass their own). */
  structure?: (project: string, opts: MeasureOptions) => Promise<StructureProjectResponse>;
}

const noAgents = (reason: string): AgentsRead => ({ status: "off", reason, registry: null, total: 0, running: 0, agents: [] });

export async function readCodeTree(project: string, opts: CodeTreeOptions = {}): Promise<{ response: CodeTreeResponse; notFound?: boolean }> {
  const s = await (opts.structure ?? readStructure)(project, { ref: opts.ref ?? null, path: opts.path ?? null, package: opts.package ?? null, signal: opts.signal, registry: opts.registry });
  let packageDir: string;
  let commit: { ref: string; sha: string; date: string | null; why: string };
  if (s.status === "measured") {
    packageDir = s.package.dir;
    commit = { ref: s.measuredAt.ref, sha: s.measuredAt.sha, date: s.measuredAt.date, why: s.refChosenBy === "?ref" ? "?ref" : s.measuredAt.why };
  } else if (s.status === "no-design") {
    if (!s.measuredAt) return { response: { status: "not-measured", project, reason: `${s.path} is not a git checkout; Code reads files only at a commit`, structure: s } };
    const t = gitTop(s.path);
    if (!t) return { response: { status: "could-not-read", project, reason: `${s.path} is no longer a git checkout`, structure: s } };
    packageDir = t;
    commit = { ref: s.measuredAt.ref, sha: s.measuredAt.sha, date: null, why: s.refChosenBy };
  } else {
    const unknown = s.status === "could-not-read" && /^no project named /.test(s.reason);
    return { response: { status: s.status, project, reason: s.reason, structure: s }, notFound: unknown };
  }
  const top = gitTop(packageDir);
  if (!top) return { response: { status: "could-not-read", project, reason: `${packageDir} is not inside a git checkout`, structure: s } };
  const packageRel = relative(top, realOr(packageDir));
  if (packageRel.startsWith("..")) return { response: { status: "could-not-read", project, reason: `${packageDir} is not inside ${top}`, structure: s } };

  const all = git(top, ["ls-tree", "-r", "--name-only", "-z", commit.sha]);
  if (!all.ok) return { response: { status: "could-not-read", project, reason: `git ls-tree ${commit.sha.slice(0, 12)} failed: ${all.err}`, structure: s } };
  const repoFiles = all.out.split("\0").filter(Boolean);
  const files = packageRel === "" ? repoFiles : repoFiles.filter((f) => f.startsWith(packageRel + "/")).map((f) => f.slice(packageRel.length + 1));

  const cat = await readCataloguesReport(top);
  const placedAll = placeCites(cat.catalogues, repoFiles, packageRel);
  const traps: TrapsRead = { status: cat.report.status, dir: cat.report.path ?? null, errors: cat.report.errors, ...placedAll };

  let agents: AgentsRead;
  try {
    agents = opts.agents ? opts.agents({ top, packageDir: realOr(packageDir), packageRel }) : noAgents("no agent host was given to this reader");
  } catch (e) {
    agents = noAgents(`the agent host could not be asked: ${(e as Error).message}`);
  }

  return {
    response: {
      status: "ok",
      project,
      top,
      packageDir,
      packageRel,
      commit,
      files,
      filesFrom: `git ls-tree -r ${commit.sha.slice(0, 12)}${packageRel ? ` -- ${packageRel}` : ""} in ${top}`,
      structure: s,
      agents,
      traps,
      editRule: EDIT_RULE,
    },
  };
}

// ── one file ─────────────────────────────────────────────────────────────────────────────

/** git blame --porcelain → the commit of each line, and each commit once. */
export function parseBlame(out: string): { lines: string[]; commits: Record<string, BlameCommit> } {
  const lines: string[] = [];
  const commits: Record<string, BlameCommit> = {};
  let cur: string | null = null;
  let final = 0;
  for (const l of out.split("\n")) {
    const h = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(l);
    if (h) {
      cur = h[1];
      final = Number(h[2]);
      commits[cur] ??= { sha: cur, author: "", at: "", summary: "" };
      continue;
    }
    if (!cur) continue;
    if (l.startsWith("\t")) {
      lines[final - 1] = cur;
      continue;
    }
    const sp = l.indexOf(" ");
    const k = sp < 0 ? l : l.slice(0, sp);
    const v = sp < 0 ? "" : l.slice(sp + 1);
    if (k === "author") commits[cur].author = v;
    else if (k === "author-time") commits[cur].at = new Date(Number(v) * 1000).toISOString();
    else if (k === "summary") commits[cur].summary = v;
  }
  return { lines, commits };
}

export function readCodeFile(project: string, repoPath: unknown, sha: unknown, opts: { path?: string | null; registry?: { locked?: string; user?: string } } = {}): { response: CodeFileResponse; status: number } {
  const file = typeof repoPath === "string" ? repoPath : "";
  const bad = (reason: string) => ({ response: { status: "bad-request" as const, project, file, reason }, status: 400 });
  const rel = cleanRelPath(repoPath);
  if (!rel) return bad("path must be a repository-relative file path (no leading /, no .., no empty part)");
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha) || !safeRef(sha)) return bad("sha must be a full commit id (40 hex)");
  const t = projectTop(project, opts);
  if ("status" in t) return { response: { status: "could-not-read", project, file: rel, sha, reason: t.reason }, status: t.status };
  const top = t.top;
  if (!git(top, ["rev-parse", "--verify", "-q", `${sha}^{commit}`]).ok)
    return { response: { status: "not-found", project, file: rel, sha, reason: `${sha.slice(0, 12)} is not a commit in ${top} (Code never fetches)` }, status: 404 };
  const size = git(top, ["cat-file", "-s", `${sha}:${rel}`]);
  if (!size.ok) return { response: { status: "not-found", project, file: rel, sha, reason: `${rel} is not in ${sha.slice(0, 12)}` }, status: 404 };
  const bytes = Number(size.out.trim());
  if (bytes > MAX_FILE_BYTES) return { response: { status: "too-big", project, file: rel, sha, reason: `${rel} is ${bytes} bytes at ${sha.slice(0, 12)}; Code shows files up to ${MAX_FILE_BYTES} bytes` }, status: 200 };
  const shown = spawnSync("git", ["-C", top, "show", `${sha}:${rel}`], { maxBuffer: MAX_FILE_BYTES * 2 });
  if (shown.status !== 0) return { response: { status: "could-not-read", project, file: rel, sha, reason: `git show failed: ${String(shown.stderr ?? "").trim()}` }, status: 500 };
  const buf = shown.stdout as Buffer;
  let text: string;
  try {
    if (buf.includes(0)) throw new Error("NUL byte");
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return { response: { status: "not-text", project, file: rel, sha, reason: `${rel} is not UTF-8 text at ${sha.slice(0, 12)}` }, status: 200 };
  }
  const b = git(top, ["blame", "--porcelain", sha, "--", rel]);
  const blame = b.ok ? { status: "ok" as const, ...parseBlame(b.out) } : { status: "unreadable" as const, reason: `git blame failed: ${b.err}` };
  return { response: { status: "ok", project, file: rel, sha, text, bytes: buf.length, blame }, status: 200 };
}
