/**
 * The Changes screen's reader (#84). Read only: it reads files and asks git, gh and grep.
 *
 * For one PR it gathers: the PR (gh pr view), its diff (gh pr diff), the files each commit
 * touched (git show, or gh api when the commit is not in the local repository), the layers its
 * files sit in (the structure reader's layer map), the project's dharana boundaries, and the
 * agent sessions that made it, with what anvi's catalogue-context injector gave each of them for
 * the PR's files (/tmp/anvi-hook-<sid>.log).
 *
 * A session is tied to the PR by any of:
 *   - pr-link:     its transcript holds Claude Code's own "pr-link" record for this PR's URL;
 *   - branch:      its transcript ran on the PR's head branch;
 *   - agent-issue: AnviDeck started it (agent registry) on an issue this PR closes, in this project.
 * Transcripts are searched in the ~/.claude/projects folders of every checkout of the repository
 * (the project and each of its git worktrees, and folders inside them such as .claude/worktrees),
 * and in each registered agent's folder. A separate clone of the same repository is not searched.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { runAsync, githubRepoOf, encodeCwd } from "./replay";
import { readStructure } from "./structure";
import { readCataloguesReport } from "./catalogue";
import { candidates, resolveDir } from "../../shared/anvi-paths";
import { errText, isAbsent } from "./read-status";
import { dharanaBoundaries, layersFor, logFileMatches, sessionOfTranscript } from "../../shared/changes";
import type {
  ChangesPrList,
  ChangesResponse,
  CommitsRead,
  DharanaRead,
  DiffRead,
  HookLogRead,
  LayersRead,
  PrCommit,
  PrMeta,
  PrSession,
  SessionMatch,
  SessionsRead,
} from "../../shared/changes-types";
import type { HookLogEntry } from "../../shared/types";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
/**
 * The agent registry's folder. Same rule as server/agents/registry.ts (DEFAULT_AGENT_DIR), which a
 * reader may not import (tests/reader-actor-split.test.ts); read here, never written.
 */
const AGENT_DIR = () => process.env.ANVIDECK_AGENT_DIR ?? join(homedir(), ".anvideck", "anvideck");
const HOOK_DIR = "/tmp";
const MAX_COMMITS = 40;

/** A failure the route turns into an HTTP answer: the status and the reason. */
export class ChangesError extends Error {
  constructor(readonly status: 400 | 404 | 502, message: string) {
    super(message);
  }
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** "owner/name" of the project's GitHub origin. */
export async function projectRepo(projectPath: string): Promise<string> {
  const r = await runAsync(["git", "-C", projectPath, "remote", "get-url", "origin"], 5000);
  if (!r.ok) throw new ChangesError(502, `could not read ${projectPath}'s origin remote: ${r.err || "git failed"}`);
  const repo = githubRepoOf(r.out);
  if (!repo) throw new ChangesError(404, `${projectPath}'s origin (${r.out.trim()}) is not a GitHub repository`);
  return repo;
}

export async function listOpenPrs(project: string, projectPath: string): Promise<ChangesPrList> {
  const repo = await projectRepo(projectPath);
  const r = await runAsync(
    ["gh", "pr", "list", "--repo", repo, "--state", "open", "--limit", "50", "--json", "number,title,headRefName,createdAt,updatedAt,isDraft,author"],
    20000,
  );
  if (!r.ok) throw new ChangesError(502, `could not list ${repo}'s open PRs from GitHub: ${r.err || "gh failed"}`);
  let rows: any[];
  try {
    rows = JSON.parse(r.out);
  } catch {
    throw new ChangesError(502, `could not list ${repo}'s open PRs: gh returned non-JSON output`);
  }
  const prs = rows
    .map((p) => ({
      number: p.number,
      title: p.title,
      headRefName: p.headRefName,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      isDraft: !!p.isDraft,
      author: p.author?.login ?? null,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.number - a.number);
  return { project, repo, readAt: new Date().toISOString(), prs };
}

async function readPr(repo: string, n: number): Promise<{ meta: PrMeta; commits: { oid: string; headline: string; authoredDate: string }[] }> {
  const fields =
    "number,title,url,state,isDraft,headRefName,baseRefName,headRefOid,body,additions,deletions,changedFiles,files,closingIssuesReferences,createdAt,mergedAt,closedAt,commits";
  const r = await runAsync(["gh", "pr", "view", String(n), "--repo", repo, "--json", fields], 30000);
  if (!r.ok) {
    const missing = /could not resolve to a PullRequest|no pull requests found/i.test(r.err);
    throw new ChangesError(missing ? 404 : 502, `could not read PR ${repo}#${n} from GitHub: ${r.err || "gh failed"}`);
  }
  let p: any;
  try {
    p = JSON.parse(r.out);
  } catch {
    throw new ChangesError(502, `could not read PR ${repo}#${n}: gh returned non-JSON output`);
  }
  const meta: PrMeta = {
    number: p.number,
    title: p.title,
    url: p.url,
    state: p.state,
    isDraft: !!p.isDraft,
    headRefName: p.headRefName,
    baseRefName: p.baseRefName,
    headRefOid: p.headRefOid,
    body: p.body ?? "",
    additions: p.additions,
    deletions: p.deletions,
    changedFiles: p.changedFiles,
    files: (p.files ?? []).map((f: any) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
    closingIssues: (p.closingIssuesReferences ?? []).map((i: any) => i.number).filter((x: unknown) => typeof x === "number"),
    createdAt: p.createdAt,
    mergedAt: p.mergedAt || null,
    closedAt: p.closedAt || null,
  };
  const commits = (p.commits ?? []).map((c: any) => ({ oid: c.oid, headline: c.messageHeadline ?? "", authoredDate: c.authoredDate ?? "" }));
  return { meta, commits };
}

async function readDiff(repo: string, n: number): Promise<DiffRead> {
  const r = await runAsync(["gh", "pr", "diff", String(n), "--repo", repo], 60000);
  if (!r.ok) return { status: "unreadable", reason: `gh pr diff ${n} --repo ${repo}: ${r.err || "gh failed"}` };
  return { status: "ok", text: r.out };
}

async function commitFiles(projectPath: string, repo: string, oid: string): Promise<Pick<PrCommit, "files" | "filesError" | "filesFrom">> {
  if (!/^[0-9a-f]{7,40}$/.test(oid)) return { files: null, filesError: `not a commit id: ${oid}` };
  const local = await runAsync(["git", "-C", projectPath, "show", "--name-only", "--format=", "--no-renames", oid], 10000);
  if (local.ok) return { files: local.out.split("\n").filter(Boolean), filesFrom: "git" };
  const gh = await runAsync(["gh", "api", `repos/${repo}/commits/${oid}`, "--jq", "[.files[].filename]"], 20000);
  if (!gh.ok) return { files: null, filesError: `not in the local repository, and gh api could not read it: ${gh.err || "failed"}` };
  try {
    return { files: JSON.parse(gh.out), filesFrom: "gh" };
  } catch {
    return { files: null, filesError: "gh api returned non-JSON output" };
  }
}

async function readCommits(projectPath: string, repo: string, list: { oid: string; headline: string; authoredDate: string }[]): Promise<CommitsRead> {
  if (list.length === 0) return { status: "unreadable", reason: "gh listed no commits for this PR" };
  const taken = list.slice(0, MAX_COMMITS);
  const commits: PrCommit[] = [];
  for (let i = 0; i < taken.length; i += 6) {
    const batch = await Promise.all(taken.slice(i, i + 6).map(async (c) => ({ ...c, ...(await commitFiles(projectPath, repo, c.oid)) })));
    commits.push(...batch);
  }
  const failed = commits.filter((c) => c.files === null).length;
  const reasons: string[] = [];
  if (failed) reasons.push(`${failed} of ${commits.length} commits' files could not be read`);
  if (list.length > taken.length) reasons.push(`only the first ${taken.length} of ${list.length} commits were read`);
  return reasons.length ? { status: "partial", commits, reason: reasons.join("; ") } : { status: "ok", commits };
}

async function readLayers(project: string, projectPath: string, files: PrMeta["files"]): Promise<LayersRead> {
  try {
    const s = await readStructure(project, { path: projectPath });
    let prefix: string | null = null;
    if (s.status === "measured") {
      const rel = relative(real(projectPath), real(s.package.dir));
      prefix = rel.startsWith("..") || isAbsolute(rel) ? null : rel;
    }
    return layersFor(files, s, prefix);
  } catch (e) {
    return { status: "unknown", reason: `the structure reader failed: ${(e as Error).message}` };
  }
}

function readDharana(projectPath: string): DharanaRead {
  const dir = resolveDir(projectPath, ".anvi");
  if (!dir) return { status: "none", searched: candidates(projectPath, ".anvi").map((c) => join(c, "dharana.md")) };
  const path = join(dir, "dharana.md");
  try {
    return { status: "read", path, boundaries: dharanaBoundaries(readFileSync(path, "utf8")) };
  } catch (e) {
    if (isAbsent(e)) return { status: "none", searched: [path] };
    return { status: "unreadable", path, reason: errText(path, e) };
  }
}

interface RegistryAgent {
  id: string;
  sessionId?: string;
  cwd: string;
  issue?: number;
}

function readRegistry(): { path: string; status: "read" | "absent" | "unreadable"; reason?: string; agents: RegistryAgent[] } {
  const path = join(AGENT_DIR(), "agents.json");
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const agents = Array.isArray(raw?.agents) ? (raw.agents as RegistryAgent[]) : [];
    return { path, status: "read", agents };
  } catch (e) {
    if (isAbsent(e)) return { path, status: "absent", agents: [] };
    return { path, status: "unreadable", reason: errText(path, e), agents: [] };
  }
}

const within = (dir: string, root: string) => {
  const a = real(dir);
  const b = real(root);
  return a === b || a.startsWith(b + "/");
};

/** grep -l for a fixed string across transcript folders: the files that hold it. */
async function transcriptsHolding(dirs: string[], needle: string): Promise<{ files: string[]; error: string | null }> {
  if (dirs.length === 0) return { files: [], error: null };
  const r = await runAsync(["grep", "-r", "-l", "-F", "--include=*.jsonl", "-e", needle, ...dirs], 60000);
  const files = r.out.split("\n").filter(Boolean);
  // grep: 0 found, 1 none found, 2 an error (some files may still have been listed).
  if (r.ok || (r.err === "" && files.length === 0)) return { files, error: null };
  return { files, error: `grep for ${needle}: ${r.err || "failed"}` };
}

export function readHookLog(sid: string, files: string[], until: string | null): HookLogRead {
  const path = join(HOOK_DIR, `anvi-hook-${sid}.log`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (isAbsent(e)) return { status: "absent", path };
    return { status: "unreadable", path, reason: errText(path, e) };
  }
  const entries: HookLogEntry[] = [];
  let total = 0;
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: HookLogEntry;
    try {
      e = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    total++;
    if (typeof e?.file !== "string") continue;
    // A firing after the PR was merged or closed was for later work, not this PR.
    if (until && typeof e.ts === "string" && e.ts > until) continue;
    if (files.some((f) => logFileMatches(e.file, f))) entries.push(e);
  }
  return { status: "read", path, entries, totalEntries: total, malformedLines: malformed };
}

export async function findPrSessions(projectPath: string, repo: string, pr: PrMeta, projectsDir = PROJECTS_DIR): Promise<SessionsRead> {
  let names: string[];
  try {
    names = readdirSync(projectsDir);
  } catch (e) {
    return { status: "unreadable", reason: errText(projectsDir, e) };
  }
  const registry = readRegistry();
  const errors: string[] = [];
  if (registry.status === "unreadable") errors.push(`agent registry: ${registry.reason}`);
  // Every checkout of this repository: the project itself and its git worktrees, wherever they are
  // (a sibling folder like basher-ai, or a scratch worktree). An agent may have worked in any of them.
  const roots = [projectPath];
  const wt = await runAsync(["git", "-C", projectPath, "worktree", "list", "--porcelain"], 10000);
  if (wt.ok) for (const l of wt.out.split("\n")) if (l.startsWith("worktree ")) roots.push(l.slice("worktree ".length));
  if (!wt.ok) errors.push(`could not list ${projectPath}'s worktrees: ${wt.err || "git failed"}`);
  const encs = [...new Set(roots.map(encodeCwd))];
  const dirSet = new Set(names.filter((d) => encs.some((e) => d === e || d.startsWith(e + "--"))).map((d) => join(projectsDir, d)));
  const ownAgents = registry.agents.filter((a) => typeof a.cwd === "string" && roots.some((r) => within(a.cwd, r)));
  for (const a of ownAgents) {
    const d = join(projectsDir, encodeCwd(a.cwd));
    if (existsSync(d)) dirSet.add(d);
  }
  const dirs = [...dirSet];

  const sessions = new Map<string, PrSession>();
  const add = (sid: string | null, how: SessionMatch, transcript?: string, agentId?: string) => {
    const key = sid ?? `agent:${agentId}`;
    let s = sessions.get(key);
    if (!s) sessions.set(key, (s = { sessionId: sid, how: [], transcripts: [], log: null }));
    if (!s.how.includes(how)) s.how.push(how);
    if (transcript && !s.transcripts.includes(transcript)) s.transcripts.push(transcript);
    if (agentId) s.agentId = agentId;
  };
  const sidOf = (file: string) => {
    const dir = dirs.find((d) => file.startsWith(d + "/"));
    return dir ? sessionOfTranscript(file.slice(dir.length + 1)) : null;
  };

  const [byLink, byBranch] = await Promise.all([
    transcriptsHolding(dirs, `"prUrl":"https://github.com/${repo}/pull/${pr.number}"`),
    transcriptsHolding(dirs, `"gitBranch":"${pr.headRefName}"`),
  ]);
  for (const [found, how] of [[byLink, "pr-link"], [byBranch, "branch"]] as const) {
    if (found.error) errors.push(found.error);
    for (const f of found.files) {
      const sid = sidOf(f);
      if (sid) add(sid, how, f);
    }
  }
  for (const a of ownAgents) {
    if (a.issue && pr.closingIssues.includes(a.issue)) add(a.sessionId ?? null, "agent-issue", undefined, a.id);
  }
  // Name the AnviDeck agent behind any session found by its transcript.
  for (const s of sessions.values()) {
    if (s.agentId || !s.sessionId) continue;
    const a = ownAgents.find((x) => x.sessionId === s.sessionId);
    if (a) s.agentId = a.id;
  }

  const files = pr.files.map((f) => f.path);
  const until = pr.mergedAt ?? pr.closedAt;
  for (const s of sessions.values()) if (s.sessionId) s.log = readHookLog(s.sessionId, files, until);

  return {
    status: errors.length ? "partial" : "ok",
    searched: dirs,
    errors,
    sessions: [...sessions.values()],
    registry: { path: registry.path, status: registry.status, reason: registry.reason },
  };
}

async function readTitles(projectPath: string, sessions: SessionsRead): Promise<Pick<ChangesResponse, "titles" | "titlesStatus">> {
  const ids = new Set<string>();
  if (sessions.status !== "unreadable")
    for (const s of sessions.sessions)
      if (s.log?.status === "read") for (const e of s.log.entries) for (const id of [...(e.patterns ?? []), ...(e.invariants ?? [])]) ids.add(id);
  if (ids.size === 0) return { titles: {}, titlesStatus: { status: "read", errors: [] } };
  try {
    const { catalogues, report } = await readCataloguesReport(projectPath);
    const titles: Record<string, string> = {};
    for (const c of catalogues) for (const e of c.entries) if (ids.has(e.id) && !(e.id in titles)) titles[e.id] = e.title.replace(/^[\s—–:-]+/, "");
    const status = report.status === "ok" ? "read" : report.status === "none" ? "none" : report.status === "partial" ? "partial" : "unreadable";
    return { titles, titlesStatus: { status, errors: report.errors ?? [] } };
  } catch (e) {
    return { titles: {}, titlesStatus: { status: "unreadable", errors: [(e as Error).message] } };
  }
}

export async function readChanges(project: string, projectPath: string, n: number): Promise<ChangesResponse> {
  const repo = await projectRepo(projectPath);
  const { meta, commits: commitList } = await readPr(repo, n);
  const [diff, commits, layers, sessions] = await Promise.all([
    readDiff(repo, n),
    readCommits(projectPath, repo, commitList),
    readLayers(project, projectPath, meta.files),
    findPrSessions(projectPath, repo, meta),
  ]);
  const t = await readTitles(projectPath, sessions);
  return {
    project,
    projectPath,
    repo,
    readAt: new Date().toISOString(),
    pr: meta,
    diff,
    commits,
    layers,
    sessions,
    dharana: readDharana(projectPath),
    ...t,
  };
}
