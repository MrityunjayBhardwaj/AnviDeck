import { existsSync, statSync } from "node:fs";
import { discoverProjects } from "../readers/projects";
import { HostError, type AgentHost, type AgentView } from "./host";
import { buildIssuePrompt } from "./issue-prompt";
import { moveToInProgress, type BoardResult } from "./board";
import {
  anviLinkCheck,
  branchExists,
  branchFor,
  defaultBranch,
  dirtyOnBase,
  git,
  githubRepoOf,
  linkKnowledge,
  mainCheckout,
  spawnRun,
  worktreePathFor,
  type AnviLinkCheck,
  type LinkResult,
  type Run,
} from "./worktree";

/**
 * Start an agent from an issue (#78): one worktree and branch per issue, the project's anvi
 * knowledge linked in, and an agent started there with the issue and the owner's workflow.
 *
 * plan() only reads (git, gh) and says what start() would do or why it refuses. start() runs
 * the same plan, then acts: worktree → links → agent → board. If the agent cannot start, the
 * worktree and branch it just made (empty, nothing committed) are removed again.
 *
 * Refusals, each with its reason (HostError, `refusal` names which):
 *   unknown-project  the project or repo is not one AnviDeck knows (from its project list)
 *   no-repo          the project's folder is not a git checkout with a GitHub remote
 *   no-issue         GitHub has no such issue in that repo (or could not be asked)
 *   closed           the issue is closed
 *   worktree-exists  the issue's worktree folder already exists
 *   branch-exists    the issue's branch already exists (locally or as origin's)
 *   dirty            the main checkout is on the base branch with uncommitted changes to tracked
 *                    files: the worktree would start without them
 *   cap / no-claude  the agent host could not start one now (checked before anything is made)
 */

export interface KnownProject {
  name: string;
  path: string;
}

export interface FromIssueDeps {
  run?: Run;
  /** The projects AnviDeck knows, as its project list resolves them. */
  projects?: () => KnownProject[];
  /** Ask anvi's own resolver about the new worktree (tests may pass a fake). */
  linkCheck?: (run: Run, worktree: string) => Promise<AnviLinkCheck>;
  board?: (run: Run, repo: string, issueUrl: string) => Promise<BoardResult>;
}

export interface IssueInfo {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  labels: string[];
}

export interface Plan {
  project: string;
  main: string;
  repo: string;
  issue: IssueInfo;
  branch: string;
  worktree: string;
  base: string;
  baseSha: string;
}

export interface Started extends Plan {
  agent: AgentView;
  links: LinkResult[];
  anviCheck: AnviLinkCheck;
  board: BoardResult;
  prompt: string;
}

const refuse = (status: 400 | 404 | 409, refusal: string, why: string, detail: Record<string, unknown> = {}) =>
  new HostError(status, why, { refusal, ...detail });

/** AnviDeck's project list (the same discovery GET /api/projects uses): name and resolved path. */
export function knownProjects(): KnownProject[] {
  const d = discoverProjects();
  return d.status === "ok" ? d.projects.filter((p) => p.decoded).map((p) => ({ name: p.name, path: p.decoded! })) : [];
}

export class FromIssue {
  private readonly run: Run;
  private readonly projects: () => KnownProject[];
  private readonly linkCheck: (run: Run, worktree: string) => Promise<AnviLinkCheck>;
  private readonly board: (run: Run, repo: string, issueUrl: string) => Promise<BoardResult>;
  /** Issues being started right now: a second request for the same one is refused, not raced. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly host: AgentHost, deps: FromIssueDeps = {}) {
    this.run = deps.run ?? spawnRun;
    this.projects = deps.projects ?? knownProjects;
    this.linkCheck = deps.linkCheck ?? anviLinkCheck;
    this.board = deps.board ?? moveToInProgress;
  }

  /** Main checkouts AnviDeck knows (worktrees of one repo fold into it), by project name. */
  private async checkoutsOf(name: string | null): Promise<{ name: string; main: string }[]> {
    const out = new Map<string, string>();
    for (const p of this.projects()) {
      if (name !== null && p.name !== name) continue;
      if (!existsSync(p.path) || !statSync(p.path).isDirectory()) continue;
      try {
        const main = await mainCheckout(this.run, p.path);
        if (!out.has(main)) out.set(main, p.name);
      } catch {
        /* not a git checkout: not a candidate */
      }
    }
    return [...out].map(([main, n]) => ({ name: n, main }));
  }

  private async repoOf(main: string): Promise<string | null> {
    const r = await this.run("git", ["-C", main, "remote", "get-url", "origin"]);
    return r.code === 0 ? githubRepoOf(r.stdout) : null;
  }

  /** Which project and repo the request names: `project` (a name AnviDeck lists) or `repo` ("owner/name"). */
  private async resolveProject(body: Record<string, unknown>): Promise<{ project: string; main: string; repo: string }> {
    const project = typeof body.project === "string" ? body.project.trim() : "";
    const repoIn = typeof body.repo === "string" ? body.repo.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "") : "";
    if (!project && !repoIn) throw new HostError(400, "name the project (project) or the GitHub repository (repo: owner/name)");
    if (project) {
      const known = this.projects().filter((p) => p.name === project);
      if (!known.length) throw refuse(404, "unknown-project", `AnviDeck knows no project named "${project}"`);
      const mains = await this.checkoutsOf(project);
      if (!mains.length) throw refuse(409, "no-repo", `project "${project}" (${known.map((k) => k.path).join(", ")}) is not a git checkout`);
      if (mains.length > 1) throw refuse(409, "unknown-project", `"${project}" names ${mains.length} different repositories (${mains.map((m) => m.main).join(", ")}); not guessing which`);
      const repo = await this.repoOf(mains[0]!.main);
      if (!repo) throw refuse(409, "no-repo", `${mains[0]!.main} has no GitHub remote named origin, so its issues cannot be read`);
      if (repoIn && repoIn.toLowerCase() !== repo.toLowerCase()) {
        throw refuse(409, "unknown-project", `project "${project}" is ${repo}, not ${repoIn}`);
      }
      return { project, main: mains[0]!.main, repo };
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoIn)) throw new HostError(400, `repo must be owner/name, not "${repoIn}"`);
    const hits: { name: string; main: string }[] = [];
    for (const c of await this.checkoutsOf(null)) {
      const r = await this.repoOf(c.main);
      if (r && r.toLowerCase() === repoIn.toLowerCase()) hits.push(c);
    }
    if (!hits.length) throw refuse(404, "unknown-project", `${repoIn} is not the repository of any project AnviDeck knows`);
    if (hits.length > 1) throw refuse(409, "unknown-project", `${repoIn} is checked out in ${hits.length} places AnviDeck knows (${hits.map((h) => h.main).join(", ")}); name the project instead`);
    return { project: hits[0]!.name, main: hits[0]!.main, repo: repoIn };
  }

  private async readIssue(repo: string, n: number): Promise<IssueInfo> {
    const r = await this.run("gh", ["issue", "view", String(n), "--repo", repo, "--json", "number,title,body,state,url,labels"]);
    if (r.code !== 0) {
      throw refuse(404, "no-issue", `could not read issue #${n} of ${repo}: ${(r.stderr || r.stdout).trim().slice(0, 300) || `gh exited ${r.code}`}`);
    }
    try {
      const j = JSON.parse(r.stdout) as { number: number; title: string; body: string | null; state: string; url: string; labels?: { name: string }[] };
      return { number: j.number, title: j.title, body: j.body ?? "", state: j.state, url: j.url, labels: (j.labels ?? []).map((l) => l.name) };
    } catch {
      throw refuse(404, "no-issue", `GitHub's answer for issue #${n} of ${repo} could not be read`);
    }
  }

  /** Everything start() would do, or the reason it would refuse. Reads only. */
  async plan(body: Record<string, unknown>): Promise<Plan> {
    const n = Number(body.issue);
    if (!Number.isInteger(n) || n <= 0) throw new HostError(400, "issue must be a positive whole number");
    const { project, main, repo } = await this.resolveProject(body);
    const issue = await this.readIssue(repo, n);
    if (issue.state.toUpperCase() !== "OPEN") throw refuse(409, "closed", `issue #${n} of ${repo} is closed ("${issue.title}"); an agent is started only on an open issue`);
    const branch = branchFor(issue);
    const worktree = worktreePathFor(main, n);
    if (existsSync(worktree)) {
      throw refuse(409, "worktree-exists", `${worktree} already exists: an agent may already be working on #${n}. Finish or remove that worktree first`, { worktree });
    }
    const existing = await branchExists(this.run, main, branch);
    if (existing) throw refuse(409, "branch-exists", `the branch ${branch} already exists (${existing}); work on #${n} may already have started`, { branch });
    const base = await defaultBranch(this.run, main);
    let baseSha: string;
    try {
      baseSha = await git(this.run, main, ["rev-parse", "--verify", `refs/heads/${base}^{commit}`]);
    } catch {
      throw refuse(409, "no-repo", `${main} has no local branch ${base} to start the worktree from`);
    }
    const dirty = await dirtyOnBase(this.run, main, base);
    if (dirty.changed.length) {
      const shown = dirty.changed.slice(0, 5).join(", ") + (dirty.changed.length > 5 ? `, and ${dirty.changed.length - 5} more` : "");
      throw refuse(409, "dirty", `${main} is on ${base} with ${dirty.changed.length} uncommitted change${dirty.changed.length === 1 ? "" : "s"} to tracked files (${shown}); the worktree starts from ${base}'s last commit and would not have them. Commit or stash them first`, { changed: dirty.changed });
    }
    return { project, main, repo, issue, branch, worktree, base, baseSha };
  }

  /** Plan, then make the worktree and links, start the agent there, and move the issue on the board. */
  async start(body: Record<string, unknown>): Promise<Started> {
    const note = typeof body.note === "string" ? body.note : undefined;
    // The host would refuse anyway; asking first means nothing is made for an agent that cannot run.
    if (this.host.running >= this.host.cap) {
      throw new HostError(429, `${this.host.running} agents are running, the most allowed at once is ${this.host.cap}; stop one first`);
    }
    const p = await this.plan(body);
    const key = `${p.main}#${p.issue.number}`;
    if (this.inFlight.has(key)) throw refuse(409, "worktree-exists", `issue #${p.issue.number} is being started right now`);
    this.inFlight.add(key);
    try {
      return await this.make(p, note);
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async make(p: Plan, note: string | undefined): Promise<Started> {
    const add = await this.run("git", ["-C", p.main, "worktree", "add", "-b", p.branch, p.worktree, p.baseSha]);
    if (add.code !== 0) {
      throw refuse(409, "worktree-exists", `git could not make the worktree: ${(add.stderr || add.stdout).trim().slice(0, 300)}`);
    }
    let links: LinkResult[];
    let agent: AgentView;
    let prompt: string;
    try {
      links = await linkKnowledge(this.run, p.main, p.worktree);
      prompt = buildIssuePrompt({
        repo: p.repo,
        number: p.issue.number,
        title: p.issue.title,
        body: p.issue.body,
        url: p.issue.url,
        branch: p.branch,
        base: p.base,
        baseSha: p.baseSha,
        worktree: p.worktree,
        links: links.map(describeLink),
        note,
      });
      agent = this.host.start({ cwd: p.worktree, prompt, issue: p.issue.number });
    } catch (e) {
      // Nothing was committed in it yet: take the worktree and its branch away again.
      await this.run("git", ["-C", p.main, "worktree", "remove", "--force", p.worktree]);
      await this.run("git", ["-C", p.main, "branch", "-D", p.branch]);
      throw e;
    }
    const anviCheck = await this.linkCheck(this.run, p.worktree);
    const board = await this.board(this.run, p.repo, p.issue.url);
    return { ...p, agent, links, anviCheck, board, prompt };
  }
}

/** One line per link for the prompt and the page. */
export function describeLink(l: LinkResult): string {
  if (l.state === "linked") return `${l.kind}: ${l.path} → ${l.target}${l.resolves ? "" : " (DOES NOT RESOLVE)"}`;
  if (l.state === "tracked") return `${l.kind}: tracked in the repository; this worktree has the branch's own copy`;
  if (l.state === "none") return `${l.kind}: the project has none`;
  return `${l.kind}: ${l.note}`;
}
