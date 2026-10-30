/**
 * Structure map data — read from anvi's own structure guard, not a separate import walk.
 *
 * The graph and its verdicts come from the guard's exported functions, run under node by
 * structure-driver.cjs (beside this file). This reader only finds the packages, picks the commit,
 * caches, and shapes the answer.
 *
 * Read-only. It writes nothing into any measured project: the guard measures a ref through a
 * temporary `git archive` (structure-guard.js checkoutAtRef) under TMPDIR, which this reader points
 * at a directory of its own under /private/tmp/claude-501/, and the guard removes it itself.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type {
  EdgeClass,
  GuardSource,
  StructureComponent,
  StructureFolder,
  StructureListResponse,
  StructureMeasured,
  StructureNoDesign,
  StructureNotMeasured,
  StructurePackageEntry,
  StructureProjectListing,
  StructureProjectResponse,
} from "../../shared/structure-types";

const HOME = process.env.HOME ?? homedir();

/** The lock directory the anvi hooks read (anvi hooks/structure-lock.js LOCK_DIRS / lockDir). */
export const LOCK_DIR = process.platform === "linux" ? "/etc/anvi" : "/Library/Application Support/anvi";
export const LOCKED_REGISTRY = join(LOCK_DIR, "structure-guard.json");
/** The user's own registry (anvi hooks/structure-lock.js userRegistry). */
export const USER_REGISTRY = join(HOME, ".claude", "structure-guard.json");

/**
 * The guard script, found where the merge hook finds it (structure-merge-hook.js guardScript):
 * the installed copy under ~/.claude/anvi/scripts.
 */
export const GUARD_PATH = process.env.ANVIDECK_STRUCTURE_GUARD ?? join(HOME, ".claude", "anvi", "scripts", "structure-guard.js");
const DRIVER = join(import.meta.dir, "structure-driver.cjs");
/** Where the guard's temporary `git archive` goes (TMPDIR for the child). */
export const TMP_ROOT = process.env.ANVIDECK_STRUCTURE_TMP ?? "/private/tmp/claude-501/anvideck-structure";
const GUARD_TIMEOUT_MS = 120_000;

// ── registry ────────────────────────────────────────────────────────────────────────────────

interface Registry {
  packages: StructurePackageEntry[];
  locked: string | null;
  user: string | null;
  errors: string[];
  /** set when the LOCKED registry exists but cannot be read: which packages it locks is unknown */
  fatal: string | null;
}

function realOr(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

function entriesOf(file: string, source: "locked" | "user"): StructurePackageEntry[] {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (!raw || !Array.isArray(raw.packages)) throw new Error(`the registry ${file} has no "packages" list`);
  return raw.packages
    .filter((e: any) => e && typeof e.dir === "string")
    .map((e: any) => ({
      dir: e.dir,
      design: e.design,
      baseline: e.baseline,
      designId: typeof e.designId === "string" ? e.designId : null,
      extractor: typeof e.extractor === "string" ? e.extractor : null,
      source,
      check: e.check ?? null,
    }));
}

/**
 * The registry the hooks judge by, with the same precedence as anvi's registryInForce
 * (hooks/structure-lock.js): locked entries first, then the user's entries for every package the
 * lock does not name. A locked registry that cannot be read is fatal — falling back to the user's
 * entries would show a locked package under a design the hooks do not use.
 */
export function readRegistry(paths: { locked?: string; user?: string } = {}): Registry {
  const lockedPath = paths.locked ?? LOCKED_REGISTRY;
  const userPath = paths.user ?? USER_REGISTRY;
  const reg: Registry = { packages: [], locked: null, user: null, errors: [], fatal: null };
  let locked: StructurePackageEntry[] = [];
  if (existsSync(lockedPath)) {
    try { locked = entriesOf(lockedPath, "locked"); reg.locked = lockedPath; }
    catch (e: any) { reg.fatal = `cannot read the locked registry ${lockedPath}: ${e.message}`; return reg; }
  }
  let user: StructurePackageEntry[] = [];
  if (existsSync(userPath)) {
    try { user = entriesOf(userPath, "user"); reg.user = userPath; }
    catch (e: any) { reg.errors.push(`cannot read the user registry ${userPath}: ${e.message}`); }
  }
  const taken = new Set(locked.map((e) => realOr(e.dir)));
  reg.packages = [...locked, ...user.filter((e) => !taken.has(realOr(e.dir)))];
  return reg;
}

// ── projects ────────────────────────────────────────────────────────────────────────────────

interface Project { name: string; path: string }

/**
 * Projects as AnviDeck already knows them (~/.claude/projects/<encoded path>), kept only when
 * the decoded path is a directory, plus the git toplevel of every registered package.
 */
export function discoverProjects(reg: Registry = readRegistry()): Project[] {
  const out = new Map<string, Project>();
  const add = (p: string) => {
    const name = p.split("/").pop() || p;
    const prev = out.get(name);
    if (!prev || p.length < prev.path.length) out.set(name, { name, path: p });
  };
  try {
    for (const d of readdirSync(join(HOME, ".claude", "projects"))) {
      if (!d.startsWith("-")) continue;
      const decoded = d.replace(/^-/, "/").replace(/-/g, "/");
      try { if (statSync(decoded).isDirectory()) add(decoded); } catch { /* not a real path */ }
    }
  } catch { /* no projects dir */ }
  for (const e of reg.packages) {
    const top = gitTop(e.dir);
    if (top) add(top);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A package belongs to ONE project: the deepest known project directory that contains it. Without
 * "deepest", a parent folder that is itself a known project (~/Documents/projects) would claim
 * every package below it and show a design it does not have.
 */
function ownerOf(dir: string, projects: Project[]): Project | null {
  const d = realOr(dir);
  let best: Project | null = null;
  for (const p of projects) {
    const root = realOr(p.path);
    if ((d === root || d.startsWith(root + sep)) && (!best || root.length > realOr(best.path).length)) best = p;
  }
  return best;
}

function packagesOfProject(project: Project, reg: Registry, projects: Project[]): StructurePackageEntry[] {
  return reg.packages.filter((e) => ownerOf(e.dir, projects)?.path === project.path);
}

export function listStructure(): StructureListResponse {
  const reg = readRegistry();
  const registry = { locked: reg.locked, user: reg.user, errors: reg.errors };
  if (reg.fatal) return { status: "could-not-read", reason: reg.fatal, registry, projects: [] };
  const known = discoverProjects();
  const projects: StructureProjectListing[] = known.map((p) => {
    const pk = packagesOfProject(p, reg, known);
    return {
      name: p.name,
      path: p.path,
      hasDesign: pk.length > 0,
      packages: pk.map((e) => ({ dir: e.dir, designId: e.designId, source: e.source })),
    };
  });
  return { status: "ok", registry, projects };
}

// ── git (read-only: rev-parse, symbolic-ref, show, ls-tree) ─────────────────────────────────

function git(cwd: string, ...args: string[]): string | null {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function gitTop(dir: string): string | null {
  const t = git(dir, "rev-parse", "--show-toplevel");
  return t ? realOr(t) : null;
}

/** A ref as a word git will not read as an option. */
export function safeRef(ref: string): boolean {
  return /^[A-Za-z0-9._\/@{}^~-]{1,200}$/.test(ref) && !ref.startsWith("-") && !ref.includes("..");
}

/**
 * The ref measured when none is asked, as the guard chooses it (structure-guard.js defaultRef):
 * origin/HEAD, else the only one of origin/main and origin/master; two or none is a guess, refused.
 */
export function defaultRef(top: string): { ref: string; why: string } | { notMeasured: string } {
  const head = git(top, "symbolic-ref", "-q", "refs/remotes/origin/HEAD");
  if (head) return { ref: head.replace(/^refs\/remotes\//, ""), why: "origin/HEAD" };
  const have = ["origin/main", "origin/master"].filter((r) => git(top, "rev-parse", "--verify", "-q", `refs/remotes/${r}`));
  if (have.length === 1)
    return { ref: have[0], why: `origin/HEAD is not set, and ${have[0]} is the only one of origin/main, origin/master` };
  return {
    notMeasured: `cannot tell the default branch of ${top}: origin/HEAD is not set and ` +
      (have.length ? "both origin/main and origin/master exist" : "neither origin/main nor origin/master exists") +
      " — pass ?ref=<branch> to name the one to measure",
  };
}

// ── guard source identity ───────────────────────────────────────────────────────────────────

function sha256File(p: string): string | null {
  try { return createHash("sha256").update(readFileSync(p)).digest("hex"); } catch { return null; }
}

export function guardSource(guardPath = GUARD_PATH): GuardSource | { error: string } {
  const sha = sha256File(guardPath);
  if (!sha) return { error: `cannot read the structure guard at ${guardPath}` };
  const mtime = statSync(guardPath).mtime.toISOString();
  // The shared modules, found where the guard finds them (structure-guard.js loadFromCandidates).
  const find = (name: string) =>
    [join(dirname(guardPath), "..", "hooks", name), join(HOME, ".claude", "hooks", name)].find((c) => existsSync(c)) ?? null;
  const rulesPath = find("structure-rules.js");
  const rulesSha = rulesPath ? sha256File(rulesPath) : null;
  return {
    label: `structure-guard ${guardPath}@sha256:${sha.slice(0, 12)} (mtime ${mtime})`,
    guard: { path: guardPath, sha256: sha, mtime },
    rules: rulesPath && rulesSha ? { path: realOr(rulesPath), sha256: rulesSha } : null,
    graph: (() => { const g = find("structure-graph.js"); return g ? realOr(g) : null; })(),
  };
}

// ── the guard run ───────────────────────────────────────────────────────────────────────────

interface DriverInput {
  dir: string;
  design: string;
  baseline: string;
  designId: string | null;
  extractor: string | null;
  ref: string;
}

/** Run the guard's functions under node (as the merge hook runs the guard: structure-merge-hook.js guardAt). */
function runDriver(input: DriverInput, guardPath: string): Promise<{ json: any; ms: number; stderr: string }> {
  mkdirSync(TMP_ROOT, { recursive: true });
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn("node", [DRIVER, guardPath, JSON.stringify(input)], {
      env: { ...process.env, TMPDIR: TMP_ROOT },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), GUARD_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ json: { status: "not-measured", reason: `could not start node to run the guard: ${e.message}` }, ms: Date.now() - t0, stderr });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      let json: any = null;
      try { json = JSON.parse(stdout); } catch { /* below */ }
      if (!json)
        json = {
          status: "not-measured",
          reason: `the guard run exited ${signal ? `on ${signal}` : code} with no verdict` +
            (stderr.trim() ? ` (${stderr.trim().split("\n").find((l) => /Error/.test(l)) ?? stderr.trim().split("\n")[0]})` : ""),
        };
      resolve({ json, ms: Date.now() - t0, stderr });
    });
  });
}

// ── cache ───────────────────────────────────────────────────────────────────────────────────
// Keyed on everything the answer depends on: the package, the resolved commit, the design's and
// the baseline's bytes, and the guard's own bytes. A key that omits an input serves a stale
// answer; re-locking a new baseline must miss the cache, not hit it.

const cache = new Map<string, StructureProjectResponse>();
const inflight = new Map<string, Promise<StructureProjectResponse>>();
const CACHE_MAX = 64;

function remember(key: string, value: StructureProjectResponse) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, value);
}

export function clearStructureCache() { cache.clear(); }

// ── the per-project answer ──────────────────────────────────────────────────────────────────

export interface MeasureOptions {
  ref?: string | null;
  /** Override registry entry fields — used by the tests to measure against a historical baseline. */
  entry?: Partial<StructurePackageEntry>;
  guardPath?: string;
  /** Which registered package, when the project owns more than one (its dir). */
  package?: string | null;
  /** Registry files to read instead of the lock and the user's — for the tests. */
  registry?: { locked?: string; user?: string };
}

export async function readStructure(projectName: string, opts: MeasureOptions = {}): Promise<StructureProjectResponse> {
  const t0 = Date.now();
  const refAsked = opts.ref ?? null;
  if (refAsked !== null && !safeRef(refAsked))
    return { status: "not-measured", project: projectName, refAsked, reason: `the ref ${JSON.stringify(refAsked)} is not one this reader passes to git` };

  const reg = readRegistry(opts.registry);
  if (reg.fatal) return { status: "could-not-read", project: projectName, refAsked, reason: reg.fatal };
  const known = discoverProjects(reg);
  const project = known.find((p) => p.name === projectName);
  if (!project) return { status: "could-not-read", project: projectName, refAsked, reason: `no project named ${projectName} is known (~/.claude/projects or the structure registry)` };

  const pkgs = packagesOfProject(project, reg, known);
  if (!pkgs.length) return readFolders(project, refAsked, t0);
  // Several packages: the caller names one. Measuring the first would hide the rest behind "measured".
  let picked = pkgs[0];
  if (opts.package) {
    const want = realOr(opts.package);
    const hit = pkgs.find((e) => realOr(e.dir) === want);
    if (!hit)
      return { status: "not-measured", project: projectName, refAsked,
        reason: `${opts.package} is not a registered package of ${projectName}; its packages: ${pkgs.map((e) => e.dir).join(", ")}` };
    picked = hit;
  } else if (pkgs.length > 1) {
    return { status: "not-measured", project: projectName, refAsked,
      reason: `${projectName} has ${pkgs.length} registered packages — pass ?package=<dir> to name one: ${pkgs.map((e) => e.dir).join(", ")}` };
  }
  const entry: StructurePackageEntry = { ...picked, ...(opts.entry ?? {}) };

  const guardPath = opts.guardPath ?? GUARD_PATH;
  const src = guardSource(guardPath);
  if ("error" in src) return { status: "could-not-read", project: projectName, package: entry, refAsked, reason: src.error };

  const top = gitTop(entry.dir);
  if (!top)
    return { status: "not-measured", project: projectName, package: entry, refAsked, source: src,
      reason: `${entry.dir} is not inside a git checkout, so there is no commit to measure (the working tree is never measured)` };
  const chosen = refAsked ? { ref: refAsked, why: "?ref" } : defaultRef(top);
  if ("notMeasured" in chosen) return { status: "not-measured", project: projectName, package: entry, refAsked, source: src, reason: chosen.notMeasured };
  const sha = git(top, "rev-parse", "--verify", "-q", `${chosen.ref}^{commit}`);
  if (!sha)
    return { status: "not-measured", project: projectName, package: entry, refAsked, source: src,
      reason: `${chosen.ref} is not a commit in ${top} (this reader never fetches into a measured repository)` };

  const designSha = sha256File(entry.design);
  if (!designSha) return { status: "could-not-read", project: projectName, package: entry, refAsked, source: src, reason: `cannot read the design ${entry.design}` };
  const baselineSha = sha256File(entry.baseline);
  if (!baselineSha) return { status: "could-not-read", project: projectName, package: entry, refAsked, source: src, reason: `cannot read the baseline ${entry.baseline}` };

  const key = JSON.stringify([realOr(entry.dir), sha, designSha, baselineSha, src.guard.sha256, src.rules?.sha256 ?? null, entry.designId, entry.extractor]);
  const hit = cache.get(key);
  // The verdict depends only on the key; who asked, and through which registry entry, is this request's.
  if (hit) return withTiming({ ...hit, project: projectName, package: entry } as StructureProjectResponse, "hit", Date.now() - t0, refAsked);
  let job = inflight.get(key);
  if (!job) {
    job = measure(projectName, entry, sha, chosen, src, guardPath, refAsked).finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  const fresh = await job;
  // A run that crashed or timed out is not cached: the next request tries again.
  if (fresh.status === "measured" || (fresh.status === "not-measured" && fresh.measuredAt)) remember(key, fresh);
  return withTiming(fresh, "miss", Date.now() - t0, refAsked);
}

function withTiming(r: StructureProjectResponse, kind: "hit" | "miss", ms: number, refAsked: string | null): StructureProjectResponse {
  if (r.status === "no-design") return { ...r, refAsked, timing: { cache: kind, ms } };
  const guardMs = "timing" in r && r.timing ? r.timing.guardMs : null;
  return { ...r, refAsked, timing: { cache: kind, ms, guardMs } } as StructureProjectResponse;
}

async function measure(
  project: string,
  entry: StructurePackageEntry,
  sha: string,
  chosen: { ref: string; why: string },
  src: GuardSource,
  guardPath: string,
  refAsked: string | null,
): Promise<StructureProjectResponse> {
  // The guard is handed the resolved commit, so what it measures is exactly what the cache key names.
  const { json, ms } = await runDriver(
    { dir: entry.dir, design: entry.design, baseline: entry.baseline, designId: entry.designId, extractor: entry.extractor, ref: sha },
    guardPath,
  );
  // The guard's reason starts with how IT chose the ref — "--ref", since it was handed the hash
  // (structure-guard.js checkoutAtRef: `chosen.why + borrowed…`). That is this reader's plumbing;
  // the choice the user made is `chosen.why`. What follows (whose node_modules) is kept.
  const guardWhy = json.measuredAt ? String(json.measuredAt.why).replace(/^--ref(;\s*)?/, "") : "";
  const measuredAt = json.measuredAt
    ? { ...json.measuredAt, ref: chosen.ref, why: guardWhy ? `${chosen.why}; ${guardWhy}` : chosen.why }
    : undefined;
  if (json.status !== "measured") {
    const r: StructureNotMeasured = { status: "not-measured", project, package: entry, refAsked, reason: json.reason, source: src,
      timing: { cache: "miss", ms, guardMs: ms } };
    if (measuredAt) r.measuredAt = measuredAt;
    return r;
  }

  let design: any = {};
  try { design = JSON.parse(readFileSync(entry.design, "utf8")); } catch { /* the driver read it a moment ago */ }
  const perComponent = new Map<string, number>();
  for (const m of json.modules) if (m.component) perComponent.set(m.component, (perComponent.get(m.component) ?? 0) + 1);
  const components: StructureComponent[] = Object.entries<any>(design.components ?? {}).map(([name, c]) => ({
    name,
    dirs: Array.isArray(c?.dirs) ? c.dirs : [],
    files: Array.isArray(c?.files) ? c.files : [],
    why: typeof c?.why === "string" ? c.why : null,
    modules: perComponent.get(name) ?? 0,
  }));
  const byClass: Record<EdgeClass, number> = { internal: 0, allowed: 0, grandfathered: 0, new: 0, unmapped: 0 };
  for (const e of json.edges) byClass[e.class as EdgeClass]++;
  const tally = (r: any) => ({ total: r.total, grandfathered: r.grandfathered, new: r.new.length, fixed: r.fixed.length });

  const out: StructureMeasured = {
    status: "measured",
    project,
    package: entry,
    refAsked,
    refChosenBy: chosen.why,
    measuredAt: measuredAt!,
    designId: json.designId,
    baselineDesignId: json.baselineDesignId,
    components,
    allowedPairs: (design.allowed ?? []).map(([a, b]: [string, string]) => `${a} -> ${b}`),
    edgeNotes: design.edgeNotes && typeof design.edgeNotes === "object" ? design.edgeNotes : {},
    modules: json.modules,
    edges: json.edges,
    cycles: json.cycles,
    rules: json.rules,
    byPair: json.byPair,
    unmapped: json.unmapped,
    absences: json.absences,
    counts: {
      modules: json.modules.length,
      edges: json.edges.length,
      examinedBetweenComponents: json.rules.divergence.examined,
      byClass,
      divergence: tally(json.rules.divergence),
      cycle: tally(json.rules.cycle),
      baselineKeys: json.baselineKeys,
      relativeImports: json.relative,
      unresolvedRelative: json.unresolved,
    },
    extractor: json.extractor,
    typeOnlyImports: json.typeOnlyImports,
    source: src,
    timing: { cache: "miss", ms, guardMs: ms },
  };
  return out;
}

// ── a project with no design: its folders, nothing blocked ──────────────────────────────────

const folderCache = new Map<string, StructureNoDesign>();

function readFolders(project: Project, refAsked: string | null, t0: number): StructureProjectResponse {
  const top = gitTop(project.path);
  let files: string[];
  let measuredAt: { ref: string; sha: string } | null = null;
  let refChosenBy = "not a git checkout: read as it is on disk";
  if (top) {
    const chosen = refAsked ? { ref: refAsked, why: "?ref" } : defaultRef(top);
    if ("notMeasured" in chosen) return { status: "not-measured", project: project.name, refAsked, reason: chosen.notMeasured };
    const sha = git(top, "rev-parse", "--verify", "-q", `${chosen.ref}^{commit}`);
    if (!sha) return { status: "not-measured", project: project.name, refAsked, reason: `${chosen.ref} is not a commit in ${top}` };
    const key = `${top}\0${sha}`;
    const hit = folderCache.get(key);
    if (hit) return { ...hit, refAsked, timing: { cache: "hit", ms: Date.now() - t0 } };
    const r = spawnSync("git", ["-C", top, "ls-tree", "-r", "--name-only", "-z", sha], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) return { status: "could-not-read", project: project.name, refAsked, reason: `git ls-tree ${sha.slice(0, 8)} failed: ${r.stderr.trim()}` };
    files = r.stdout.split("\0").filter(Boolean);
    measuredAt = { ref: chosen.ref, sha };
    refChosenBy = chosen.why;
  } else {
    files = [];
    const walk = (d: string) => {
      let ents;
      try { ents = readdirSync(join(project.path, d), { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        const rel = d ? `${d}/${e.name}` : e.name;
        if (e.isDirectory()) walk(rel); else files.push(rel);
      }
    };
    walk("");
  }
  const direct = new Map<string, number>(), total = new Map<string, number>();
  for (const f of files) {
    const parts = f.split("/");
    const parent = parts.slice(0, -1).join("/") || ".";
    direct.set(parent, (direct.get(parent) ?? 0) + 1);
    for (let i = 0; i < parts.length; i++) {
      const d = parts.slice(0, i).join("/") || ".";
      total.set(d, (total.get(d) ?? 0) + 1);
    }
  }
  const folders: StructureFolder[] = [...total.keys()].sort().map((p) => ({ path: p, files: direct.get(p) ?? 0, total: total.get(p) ?? 0 }));
  const out: StructureNoDesign = {
    status: "no-design",
    project: project.name,
    path: project.path,
    label: "nothing blocked",
    refAsked,
    refChosenBy,
    measuredAt,
    treeFrom: top ? "git" : "disk",
    folders,
    files: files.length,
    timing: { cache: "miss", ms: Date.now() - t0 },
  };
  if (top && measuredAt) folderCache.set(`${top}\0${measuredAt.sha}`, out);
  return out;
}

/** For the tests: the path of the driver, so a control can run the guard CLI beside it. */
export const STRUCTURE_DRIVER = DRIVER;
