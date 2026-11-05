import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { knownProjects, type KnownProject } from "../agents/from-issue";
import { githubRepoOf, mainCheckout, type Run, type RunResult } from "../agents/worktree";
import { linkedBoards } from "../agents/board";
import { parsePrSections } from "../../shared/pr-evidence";
import type { BoardItem, BoardRead, CiRead, IssuesRead, PrFacts } from "../../shared/work-types";

/**
 * What the Work screen reads from GitHub and git (#85): which repo a project is, its board (or
 * its open issues), and its open PRs with the facts each workflow step is derived from.
 * Reads only. Every failed read is a state with the reason, never an empty list.
 */

/** A refusal or failed read, with the HTTP status the route answers and why. */
export class WorkError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 502, message: string, readonly detail: Record<string, unknown> = {}) {
    super(message);
  }
}

/** Runs a command with a time limit; never throws (a missing binary is code 127, a timeout 124). */
export function timedRun(ms: number): Run {
  return async (cmd, args, opts) => {
    try {
      // Run outside any checkout unless told otherwise: gh must not act on the server's own repo.
      const p = Bun.spawn([cmd, ...args], { cwd: opts?.cwd ?? tmpdir(), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        p.kill();
      }, ms);
      const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      clearTimeout(timer);
      return timedOut ? { code: 124, stdout, stderr: `${cmd} ${args[0] ?? ""} took longer than ${ms / 1000}s and was stopped` } : { code, stdout, stderr };
    } catch (e) {
      return { code: 127, stdout: "", stderr: (e as Error).message };
    }
  };
}

const said = (r: RunResult) => (r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.code}`;

/** The project AnviDeck lists under `name`: its main checkout and its GitHub repo. */
export async function resolveProject(run: Run, projects: () => KnownProject[], name: string): Promise<{ project: string; main: string; repo: string }> {
  if (!name) throw new WorkError(400, "name the project (?project=<name>)");
  const known = projects().filter((p) => p.name === name);
  if (!known.length) throw new WorkError(404, `AnviDeck knows no project named "${name}"`, { refusal: "unknown-project" });
  const mains = new Set<string>();
  for (const p of known) {
    if (!existsSync(p.path) || !statSync(p.path).isDirectory()) continue;
    try {
      mains.add(await mainCheckout(run, p.path));
    } catch {
      /* not a git checkout */
    }
  }
  if (!mains.size) throw new WorkError(409, `project "${name}" (${known.map((k) => k.path).join(", ")}) is not a git checkout`, { refusal: "no-repo" });
  if (mains.size > 1) throw new WorkError(409, `"${name}" names ${mains.size} repositories (${[...mains].join(", ")}); not guessing which`, { refusal: "unknown-project" });
  const main = [...mains][0]!;
  const origin = await run("git", ["-C", main, "remote", "get-url", "origin"]);
  const repo = origin.code === 0 ? githubRepoOf(origin.stdout) : null;
  if (!repo) throw new WorkError(409, `${main} has no GitHub remote named origin, so it has no issues or PRs to show`, { refusal: "no-repo" });
  return { project: name, main, repo };
}

export { knownProjects };

/** The most items read from one board, and the most open issues listed when there is no board. */
export const BOARD_ITEM_LIMIT = 5000;
export const ISSUE_LIMIT = 500;

interface RawItem {
  id?: unknown;
  content?: { type?: unknown; number?: unknown; title?: unknown; url?: unknown; repository?: unknown };
  status?: unknown;
  title?: unknown;
  labels?: unknown;
  "linked pull requests"?: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function prNumbers(urls: unknown): number[] {
  if (!Array.isArray(urls)) return [];
  return urls.flatMap((u) => {
    const m = typeof u === "string" ? /\/pull\/(\d+)\/?$/.exec(u) : null;
    return m ? [Number(m[1])] : [];
  });
}

/** One `gh project item-list` item as a BoardItem. */
export function boardItem(raw: RawItem): BoardItem {
  const c = raw.content ?? {};
  const n = typeof c.number === "number" ? c.number : null;
  return {
    id: str(raw.id) ?? "",
    type: str(c.type) ?? "unknown",
    number: n,
    title: str(c.title) ?? str(raw.title) ?? "",
    url: str(c.url),
    repo: str(c.repository),
    status: str(raw.status),
    labels: Array.isArray(raw.labels) ? raw.labels.filter((l): l is string => typeof l === "string") : [],
    linkedPrs: prNumbers(raw["linked pull requests"]),
  };
}

export async function readOpenIssues(run: Run, repo: string, limit = ISSUE_LIMIT): Promise<IssuesRead> {
  const r = await run("gh", ["issue", "list", "--repo", repo, "--state", "open", "--limit", String(limit), "--json", "number,title,url,labels,updatedAt"]);
  if (r.code !== 0) return { state: "unreadable", reason: `could not list ${repo}'s open issues: ${said(r)}` };
  try {
    const rows = JSON.parse(r.stdout) as { number: number; title: string; url: string; labels?: { name: string }[]; updatedAt: string }[];
    if (!Array.isArray(rows)) throw new Error("not a list");
    return {
      state: "read",
      limit,
      issues: rows.map((i) => ({ number: i.number, title: i.title, url: i.url, labels: (i.labels ?? []).map((l) => l.name), updatedAt: i.updatedAt })),
    };
  } catch {
    return { state: "unreadable", reason: `gh's list of ${repo}'s open issues could not be read` };
  }
}

/**
 * The repo's board, with every item and its Status. One linked board is read; none, or several,
 * is said in those words and the open issues are listed instead (several are never guessed between).
 */
export async function readBoard(run: Run, repo: string): Promise<{ board: BoardRead; issues: IssuesRead | null }> {
  const linked = await linkedBoards(run, repo);
  if (linked.state === "unreadable") return { board: { state: "unreadable", reason: linked.reason }, issues: await readOpenIssues(run, repo) };
  if (!linked.boards.length) return { board: { state: "no board", reason: `no project board is linked to ${repo}` }, issues: await readOpenIssues(run, repo) };
  if (linked.boards.length > 1) {
    const boards = linked.boards.map((b) => ({ number: b.number, title: b.title }));
    return {
      board: { state: "several boards", boards, reason: `${boards.length} boards are linked to ${repo} (${boards.map((b) => `#${b.number} ${b.title}`).join(", ")}); not guessing which one` },
      issues: await readOpenIssues(run, repo),
    };
  }
  const b = linked.boards[0]!;
  const label = `#${b.number} ${b.title}`;
  if (!b.field || !Array.isArray(b.field.options)) return { board: { state: "unreadable", reason: `board ${label} has no single-select Status field` }, issues: null };
  const r = await run("gh", ["project", "item-list", String(b.number), "--owner", b.owner.login, "--format", "json", "--limit", String(BOARD_ITEM_LIMIT)]);
  if (r.code !== 0) return { board: { state: "unreadable", reason: `could not read the items of board ${label}: ${said(r)}` }, issues: null };
  let items: BoardItem[];
  let total: number;
  try {
    const j = JSON.parse(r.stdout) as { items?: RawItem[]; totalCount?: unknown };
    if (!Array.isArray(j.items)) throw new Error("no items");
    items = j.items.map(boardItem);
    total = typeof j.totalCount === "number" ? j.totalCount : items.length;
  } catch {
    return { board: { state: "unreadable", reason: `gh's answer for the items of board ${label} could not be read` }, issues: null };
  }
  return {
    board: {
      state: "board",
      number: b.number,
      title: b.title,
      url: b.url ?? `https://github.com/users/${b.owner.login}/projects/${b.number}`,
      owner: b.owner.login,
      columns: b.field.options.map((o) => o.name),
      items,
      total,
    },
    issues: null,
  };
}

/** The most open PRs read at once (newest updated first). */
export const PR_LIMIT = 50;

const PRS_QUERY = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){defaultBranchRef{name target{oid}} pullRequests(states:OPEN,first:$n,orderBy:{field:UPDATED_AT,direction:DESC}){totalCount nodes{number title url isDraft headRefName headRefOid baseRefName baseRefOid mergeable updatedAt author{login} body commits{totalCount} closingIssuesReferences(first:10){nodes{number title url body repository{nameWithOwner}}} reviews(last:20){nodes{state author{login} submittedAt commit{oid}}} last:commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){totalCount nodes{__typename ... on CheckRun{name conclusion status} ... on StatusContext{context state}}}}}}}}}}}`;

interface RawPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  baseRefOid: string;
  mergeable: string;
  updatedAt: string;
  author: { login: string } | null;
  body: string | null;
  commits: { totalCount: number };
  closingIssuesReferences: { nodes: { number: number; title: string; url: string; body: string | null; repository: { nameWithOwner: string } }[] };
  reviews: { nodes: { state: string; author: { login: string } | null; submittedAt: string | null; commit: { oid: string } | null }[] };
  last: { nodes: { commit: { statusCheckRollup: { state: string; contexts: { totalCount: number; nodes: Record<string, unknown>[] } } | null } }[] };
}

/** The head commit's CI as one rollup plus each context. A commit with no checks has rollup null. */
export function ciOf(raw: RawPr["last"]): CiRead {
  const roll = raw?.nodes?.[0]?.commit?.statusCheckRollup ?? null;
  if (!roll) return { rollup: null, contexts: [], total: 0 };
  const contexts = (roll.contexts?.nodes ?? []).map((n) =>
    n.__typename === "StatusContext"
      ? { name: String(n.context ?? "status"), state: String(n.state ?? "") }
      : { name: String(n.name ?? "check"), state: String(n.conclusion ?? n.status ?? "") },
  );
  return { rollup: roll.state ?? null, contexts, total: roll.contexts?.totalCount ?? contexts.length };
}

export function prFacts(p: RawPr): PrFacts {
  return {
    number: p.number,
    title: p.title,
    url: p.url,
    isDraft: p.isDraft,
    author: p.author?.login ?? null,
    updatedAt: p.updatedAt,
    headRefName: p.headRefName,
    headRefOid: p.headRefOid,
    baseRefName: p.baseRefName,
    baseRefOid: p.baseRefOid,
    mergeable: p.mergeable,
    commits: p.commits?.totalCount ?? 0,
    closing: (p.closingIssuesReferences?.nodes ?? []).map((i) => ({ number: i.number, title: i.title, url: i.url, repo: i.repository.nameWithOwner, body: i.body ?? "" })),
    ci: ciOf(p.last),
    sections: parsePrSections(p.body),
    reviews: (p.reviews?.nodes ?? []).map((r) => ({ state: r.state, author: r.author?.login ?? null, commit: r.commit?.oid ?? null, at: r.submittedAt })),
  };
}

export type PrsRead =
  | { state: "read"; base: { name: string; oid: string } | null; total: number; prs: PrFacts[] }
  | { state: "unreadable"; reason: string };

/** The repo's open PRs (newest updated first, at most PR_LIMIT), and its default branch's tip. */
export async function readOpenPrs(run: Run, repo: string, limit = PR_LIMIT): Promise<PrsRead> {
  const [owner, name] = repo.split("/");
  const r = await run("gh", ["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `n=${limit}`, "-f", `query=${PRS_QUERY}`]);
  if (r.code !== 0) return { state: "unreadable", reason: `could not ask GitHub for ${repo}'s open PRs: ${said(r)}` };
  try {
    const repoNode = (JSON.parse(r.stdout) as { data: { repository: { defaultBranchRef: { name: string; target: { oid: string } } | null; pullRequests: { totalCount: number; nodes: RawPr[] } } } }).data.repository;
    const d = repoNode.defaultBranchRef;
    return {
      state: "read",
      base: d ? { name: d.name, oid: d.target.oid } : null,
      total: repoNode.pullRequests.totalCount,
      prs: repoNode.pullRequests.nodes.map(prFacts),
    };
  } catch (e) {
    return { state: "unreadable", reason: `GitHub's answer about ${repo}'s open PRs could not be read (${(e as Error).message})` };
  }
}
