/**
 * Push and open the PR for an agent (#268): what the card shows before you press, and what came of
 * it. Shared by the server (server/agents/push-pr.ts) and the Agents screen.
 */

export interface PushCommit {
  sha: string;
  subject: string;
}

/** What pressing would do, read just now. `refusal` set means the button is not offered, and why. */
export interface PushPlan {
  agentId: string;
  cwd: string;
  /** owner/name on GitHub, from the worktree's origin. */
  repo: string;
  /** The branch checked out in the agent's worktree, pushed to the same name on origin. */
  branch: string;
  /** The exact commit that would be pushed (full sha). The push names it, so nothing newer goes. */
  head: string;
  /** The branch the PR would merge into: origin's default branch. */
  base: string;
  /** Commits on the branch that are not on origin's base, as of the last fetch, newest first. At most COMMITS_SHOWN. */
  commits: PushCommit[];
  commitCount: number;
  /** What origin has for the branch now: nothing yet, or the commit it is at. */
  remote: { state: "new" } | { state: "at"; sha: string } | { state: "unread"; reason: string };
  /** An open PR from this branch already exists: pressing pushes to it and opens no new one. */
  openPr: { number: number; url: string } | null;
  /** Files changed in the worktree but not committed: they are not pushed. */
  uncommitted: number;
  /** Proposed; you can change both before pressing. */
  title: string;
  body: string;
  /** Where the proposed body came from. */
  bodyFrom: "agent's last summary" | "the issue" | "the prompt";
}

export type PushPlanAnswer = { ok: true; plan: PushPlan } | { ok: false; refusal: string; why: string };

export interface PushAnswer {
  pushed: true;
  repo: string;
  branch: string;
  head: string;
  /** The PR the branch now has: made just now, or the one that was already open. */
  pr: { state: "created"; number: number | null; url: string } | { state: "existing"; number: number; url: string };
}

export const COMMITS_SHOWN = 30;
