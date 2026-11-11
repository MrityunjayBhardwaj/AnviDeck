/**
 * Push and open the PR for an agent (#268). An agent under Agent GitHub access "None" (#147)
 * commits in its worktree but cannot push; this does that step for it, on your login, when you
 * press the button on its card. It is a write, so it reaches AnviDeck only through the desktop
 * app's channel and goes in the action log (server/guard.ts), like Merge.
 *
 *   plan()  reads (git, gh) what pressing would do: the branch, the exact commit, the commits
 *           not on origin's base, what origin has for the branch, an open PR from it, and a
 *           proposed title and body. Or why it is not offered.
 *   push()  checks again that the branch and commit are the ones the card showed, pushes exactly
 *           that commit to that branch's own name on origin (never with force: git refuses a
 *           push that would drop commits), then opens the PR with gh, or names the open one.
 *
 * Refused while the agent runs (here or on another server), so its branch cannot move between
 * showing and pushing; the push names the commit anyway, so nothing newer than it is sent.
 */
import { COMMITS_SHOWN, type PushAnswer, type PushCommit, type PushPlan, type PushPlanAnswer } from "../../shared/push-pr-types";
import { LIVE_STATUSES, type TranscriptLine } from "./registry";
import { HostError, type AgentHost, type AgentView } from "./host";
import { githubRepoOf, type Run } from "./worktree";
import { timedRun } from "../readers/work";

const FULL_SHA = /^[0-9a-f]{40}$/;
/** A branch name as git allows it, kept narrow: no spaces, control characters or ref syntax. */
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._\/-]{1,200}(?<![./])$/;
export const TITLE_MAX = 256;
export const BODY_MAX = 65_536;
/** Branches never pushed to from here, whatever origin's default is. */
const NEVER = new Set(["main", "master", "HEAD"]);

const said = (r: { stderr: string; stdout: string; code: number }) => (r.stderr || r.stdout).trim().slice(0, 400) || `exit ${r.code}`;

class Refused extends Error {
  constructor(
    readonly refusal: string,
    why: string,
    readonly status: 409 | 502 = 409,
  ) {
    super(why);
  }
}

/** The agent's last summary: the text of the last result message Claude Code sent, if any. */
export function lastSummary(lines: TranscriptLine[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.message as { type?: unknown; result?: unknown } | null;
    if (lines[i]!.from === "sdk" && m && m.type === "result" && typeof m.result === "string" && m.result.trim()) return m.result.trim();
  }
  return null;
}

export interface PushPrDeps {
  run?: Run;
}

export class PushPr {
  private readonly run: Run;
  /** Agents being pushed right now: a second press waits for the first to answer. */
  private readonly busy = new Set<string>();

  constructor(
    private readonly host: AgentHost,
    deps: PushPrDeps = {},
  ) {
    // A time limit on every git and gh call: a stalled network or SSH must not leave the card waiting forever.
    this.run = deps.run ?? timedRun(60_000);
  }

  private async git(cwd: string, args: string[]) {
    return this.run("git", ["-C", cwd, ...args]);
  }

  private async gitOut(cwd: string, args: string[], what: string): Promise<string> {
    const r = await this.git(cwd, args);
    if (r.code !== 0) throw new Refused("git-unread", `could not read ${what}: ${said(r)}`, 502);
    return r.stdout.trim();
  }

  /** Refuse an agent that runs, here or elsewhere. */
  private notRunning(a: AgentView): void {
    if (a.running || a.runsElsewhere || LIVE_STATUSES.has(a.status)) {
      throw new Refused("running", `the agent is ${a.runsElsewhere ? "running on another AnviDeck server" : a.status}; stop it or let it finish first, so its branch cannot move while it is pushed`);
    }
  }

  /** What is true of the worktree now: branch, commit, repo, base. Shared by plan and push. */
  private async state(a: AgentView) {
    const cwd = a.cwd;
    const sym = await this.git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (sym.code !== 0) throw new Refused("detached", `${cwd} has no branch checked out (detached HEAD), so there is no branch to push`);
    const branch = sym.stdout.trim();
    if (!BRANCH.test(branch)) throw new Refused("branch-name", `the branch ${JSON.stringify(branch)} is not a name this pushes`);
    const head = await this.gitOut(cwd, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], `the commit ${branch} is at`);
    const url = await this.gitOut(cwd, ["remote", "get-url", "origin"], "the worktree's origin");
    const repo = githubRepoOf(url);
    if (!repo) throw new Refused("not-github", `origin is ${url}, not a GitHub repository, so there is no PR to open`);
    const def = await this.git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    if (def.code !== 0) throw new Refused("no-base", `could not tell origin's default branch (refs/remotes/origin/HEAD is not set; \`git remote set-head origin --auto\` sets it), so there is no base for the PR`);
    const base = def.stdout.trim().replace(/^origin\//, "");
    if (NEVER.has(branch) || branch === base) throw new Refused("base-branch", `the worktree is on ${branch}, origin's base branch; this pushes only an agent's own branch, never ${branch}`);
    return { cwd, branch, head, repo, base };
  }

  private async openPr(repo: string, branch: string): Promise<{ number: number; url: string } | null> {
    const r = await this.run("gh", ["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,url"]);
    if (r.code !== 0) throw new Refused("github-unread", `could not ask GitHub for an open PR from ${branch}: ${said(r)}`, 502);
    try {
      const j = JSON.parse(r.stdout) as { number: number; url: string }[];
      return j[0] ? { number: j[0].number, url: j[0].url } : null;
    } catch {
      throw new Refused("github-unread", `GitHub's answer about PRs from ${branch} could not be read`, 502);
    }
  }

  private async proposal(a: AgentView, repo: string): Promise<Pick<PushPlan, "title" | "body" | "bodyFrom">> {
    const summary = lastSummary(this.host.transcript(a.id).lines);
    const closes = a.issue ? `\n\nCloses #${a.issue}` : "";
    let title = a.prompt.split("\n")[0]!.trim().slice(0, 120);
    let issueBody: string | null = null;
    if (a.issue) {
      const r = await this.run("gh", ["issue", "view", String(a.issue), "--repo", repo, "--json", "title,body"]);
      if (r.code === 0) {
        try {
          const j = JSON.parse(r.stdout) as { title?: string; body?: string };
          if (j.title) title = j.title;
          if (j.body?.trim()) issueBody = j.body.trim();
        } catch {
          // The prompt's first line stays the title; the card shows what is proposed either way.
        }
      }
    }
    if (summary) return { title, body: summary + closes, bodyFrom: "agent's last summary" };
    if (issueBody) return { title, body: issueBody + closes, bodyFrom: "the issue" };
    return { title, body: a.prompt + closes, bodyFrom: "the prompt" };
  }

  async plan(id: string): Promise<PushPlanAnswer> {
    const a = this.host.get(id);
    try {
      this.notRunning(a);
      const s = await this.state(a);
      const range = `refs/remotes/origin/${s.base}..${s.head}`;
      const count = Number(await this.gitOut(s.cwd, ["rev-list", "--count", range], `the commits not on origin/${s.base}`));
      if (!count) throw new Refused("nothing", `${s.branch} has no commits that are not on origin/${s.base} (as of the last fetch), so there is nothing to push`);
      const log = await this.gitOut(s.cwd, ["log", `--max-count=${COMMITS_SHOWN}`, "--format=%H%x09%s", range], "the commits");
      const commits: PushCommit[] = log.split("\n").filter(Boolean).map((l) => {
        const [sha, ...rest] = l.split("\t");
        return { sha: sha!, subject: rest.join("\t") };
      });
      const ls = await this.git(s.cwd, ["ls-remote", "--heads", "origin", `refs/heads/${s.branch}`]);
      const remote: PushPlan["remote"] = ls.code !== 0
        ? { state: "unread", reason: said(ls) }
        : ls.stdout.trim()
          ? { state: "at", sha: ls.stdout.trim().split(/\s+/)[0]! }
          : { state: "new" };
      const status = await this.gitOut(s.cwd, ["status", "--porcelain"], "the worktree's status");
      const openPr = await this.openPr(s.repo, s.branch);
      return {
        ok: true,
        plan: { agentId: a.id, ...s, commits, commitCount: count, remote, openPr, uncommitted: status ? status.split("\n").length : 0, ...(await this.proposal(a, s.repo)) },
      };
    } catch (e) {
      if (e instanceof Refused) return { ok: false, refusal: e.refusal, why: e.message };
      throw e;
    }
  }

  /** Push exactly `head` to `branch` and open its PR, only if both are what the card showed. */
  async push(id: string, body: Record<string, unknown>): Promise<PushAnswer> {
    const a = this.host.get(id);
    const shownBranch = typeof body.branch === "string" ? body.branch : "";
    const shownHead = typeof body.head === "string" ? body.head : "";
    if (!BRANCH.test(shownBranch)) throw new HostError(400, "branch must be the branch the card showed");
    if (!FULL_SHA.test(shownHead)) throw new HostError(400, "head must be the full commit the card showed");
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > TITLE_MAX) throw new HostError(400, `the PR needs a title of 1 to ${TITLE_MAX} characters`);
    if (body.body !== undefined && typeof body.body !== "string") throw new HostError(400, "body must be text");
    const prBody = (body.body as string | undefined) ?? "";
    if (prBody.length > BODY_MAX) throw new HostError(400, `the body is ${prBody.length} characters; at most ${BODY_MAX}`);
    if (this.busy.has(id)) throw new HostError(409, "this agent's branch is being pushed right now", { refusal: "busy" });
    this.busy.add(id);
    try {
      this.notRunning(a);
      const s = await this.state(a);
      if (s.branch !== shownBranch) throw new Refused("branch-moved", `the worktree is on ${s.branch} now, not ${shownBranch} as the card showed; nothing was pushed. Look again`);
      if (s.head !== shownHead) throw new Refused("head-moved", `${s.branch} is at ${s.head.slice(0, 7)} now, not ${shownHead.slice(0, 7)} as the card showed; nothing was pushed. Look again`);
      // The commit by name, to the branch's own name: no "+", so git refuses to drop commits on origin.
      const p = await this.git(s.cwd, ["push", "--porcelain", "origin", `${s.head}:refs/heads/${s.branch}`]);
      if (p.code === 124) {
        // Stopped by the time limit: origin may or may not have taken it.
        throw new Refused("push-unknown", `not known whether ${s.branch} was pushed: ${said(p)}. Check origin (git ls-remote origin ${s.branch}) before pressing again`, 502);
      }
      if (p.code !== 0) {
        const why = said(p);
        if (/non-fast-forward|fetch first|rejected/i.test(why)) throw new Refused("not-fast-forward", `origin's ${s.branch} has commits this one does not; nothing was pushed, and AnviDeck never force-pushes. ${why}`);
        throw new Refused("push-failed", `git did not push ${s.branch}: ${why}`, 502);
      }
      const open = await this.openPr(s.repo, s.branch).catch((e: unknown) => {
        throw new Refused("pushed-pr-unknown", `pushed ${s.branch} at ${s.head.slice(0, 7)}, but ${(e as Error).message}; check GitHub before opening a PR`, 502);
      });
      if (open) return { pushed: true, repo: s.repo, branch: s.branch, head: s.head, pr: { state: "existing", ...open } };
      const c = await this.run("gh", ["pr", "create", "--repo", s.repo, "--base", s.base, "--head", s.branch, "--title", title, "--body", prBody]);
      if (c.code !== 0) throw new Refused("pushed-pr-failed", `pushed ${s.branch} at ${s.head.slice(0, 7)}, but GitHub did not open the PR: ${said(c)}`, 502);
      const url = c.stdout.trim().split("\n").pop() ?? "";
      const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/.exec(url);
      const number = m && m[1]!.toLowerCase() === s.repo.toLowerCase() ? Number(m[2]) : null;
      return { pushed: true, repo: s.repo, branch: s.branch, head: s.head, pr: { state: "created", number, url } };
    } catch (e) {
      if (e instanceof Refused) throw new HostError(e.status, e.message, { refusal: e.refusal });
      throw e;
    } finally {
      this.busy.delete(id);
    }
  }
}
