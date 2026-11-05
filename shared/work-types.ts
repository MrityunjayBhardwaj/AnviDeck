/**
 * The Work screen's answers (#85): the project's board (or its open issues), its open PRs with
 * the facts each workflow step is derived from, and the merge checks. Shared by the server
 * (server/work/*, server/routes/work.ts) and the page (ui/components/WorkScreen.ts, work-model.ts).
 *
 * A read that failed is its own state with the reason ("unreadable"), never an empty list.
 */
import type { PrSections } from "./pr-evidence";

/** One card on the board: an issue, a PR or a draft, with the Status column it sits in. */
export interface BoardItem {
  id: string;
  type: "Issue" | "PullRequest" | "DraftIssue" | string;
  /** Absent for a draft issue. */
  number: number | null;
  title: string;
  url: string | null;
  /** "owner/name" of the item's repository (a board can hold several repos' issues). */
  repo: string | null;
  /** The Status field's value; null when the item has none. */
  status: string | null;
  labels: string[];
  /** PR numbers GitHub lists as linked to the item. */
  linkedPrs: number[];
}

export type BoardRead =
  | {
      state: "board";
      number: number;
      title: string;
      url: string;
      owner: string;
      /** The Status field's options, in the board's own order. */
      columns: string[];
      items: BoardItem[];
      /** Items on the board in total, as GitHub counts them; items.length < total means a partial read. */
      total: number;
    }
  | { state: "no board"; reason: string }
  | { state: "several boards"; reason: string; boards: { number: number; title: string }[] }
  | { state: "unreadable"; reason: string };

export interface IssueRow {
  number: number;
  title: string;
  url: string;
  labels: string[];
  updatedAt: string;
}

export type IssuesRead =
  | { state: "read"; issues: IssueRow[]; /** the most asked for; issues.length === limit means there may be more */ limit: number }
  | { state: "unreadable"; reason: string };

export interface BoardResponse {
  project: string;
  repo: string;
  /** When GitHub was read (ISO). */
  readAt: string;
  board: BoardRead;
  /** Read when the repo has no board (or several): the open issues, as a list. */
  issues: IssuesRead | null;
}

/** One CI context of a PR's head commit. */
export interface CiContext {
  name: string;
  /** CheckRun conclusion (or status while it runs) / StatusContext state, as GitHub spells it. */
  state: string;
}

export interface CiRead {
  /** The head commit's rollup state (SUCCESS, FAILURE, PENDING, ERROR, EXPECTED), null when the commit has no checks at all. */
  rollup: string | null;
  contexts: CiContext[];
  /** Contexts in total; more than contexts.length means GitHub's list was cut. */
  total: number;
}

export interface ClosingIssue {
  number: number;
  title: string;
  url: string;
  repo: string;
  /** The issue's body: the friction it records. */
  body: string;
}

export interface PrFacts {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  author: string | null;
  updatedAt: string;
  headRefName: string;
  headRefOid: string;
  /** The PR's own base (a stacked PR's base is another PR's branch, not the default branch). */
  baseRefName: string;
  /** The base branch's tip as GitHub reports it for this PR. */
  baseRefOid: string;
  /** GitHub's own answer about conflicts with the base: MERGEABLE, CONFLICTING or UNKNOWN. */
  mergeable: string;
  commits: number;
  /** GitHub's parsed closing references (closingIssuesReferences). */
  closing: ClosingIssue[];
  /** Issues of this repo the body links without closing them ("Part of #N"); GitHub does not parse these. */
  partOf: number[];
  ci: CiRead;
  /** The PR body's Evidence and Self-review sections, parsed with shared/pr-evidence.ts. */
  sections: PrSections;
  /** Latest reviews (state, who, on which commit). */
  reviews: { state: string; author: string | null; commit: string | null; at: string | null }[];
}

/** git merge-tree of two commits. */
export type PairResult =
  | { state: "clean" }
  | { state: "conflict"; files: string[] }
  | { state: "unchecked"; reason: string };

export type PrConflicts =
  | {
      state: "checked";
      /** The PR's head against the base branch's tip. */
      base: PairResult;
      /** The PR's head against each other open PR's head. */
      others: { number: number; result: PairResult }[];
    }
  | { state: "unchecked"; reason: string };

export interface PrsResponse {
  project: string;
  repo: string;
  readAt: string;
  base: { name: string; oid: string } | null;
  /** Open PRs in total (GitHub's count); prs.length < total means only the newest were read. */
  total: number;
  prs: (PrFacts & { conflicts: PrConflicts })[];
}

/** POST /api/prs/:n/merge refused because the PR's head is not the one the page showed. */
export interface HeadMovedRefusal {
  error: string;
  refusal: "head-moved";
  reviewedHead: string;
  currentHead: string;
}

export interface MergeAnswer {
  merged: true;
  repo: string;
  number: number;
  head: string;
  /** The branch it was merged into: the one the page showed. */
  base: string;
  method: "squash";
  /** gh reported a failure, yet GitHub read the PR back as merged (a timeout, a dropped connection): gh's words. */
  ghFailed?: string;
  /** Read back after the merge; "unreadable" never turns the merge into a failure. */
  readBack: { state: "read"; mergeCommit: string | null; mergedAt: string | null } | { state: "unreadable"; reason: string };
}

export interface NewIssueAnswer {
  /** "owner/name#N": the action log names the issue by this. */
  id: string;
  repo: string;
  /** null when gh created it but its answer named no issue URL of this repo (the issue may still exist: see url). */
  number: number | null;
  /** What gh printed: the new issue's URL. */
  url: string;
}
