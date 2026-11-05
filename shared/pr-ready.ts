/**
 * Is a PR ready to merge? (Home, #81.) Pure: the reader asks GitHub, this decides.
 *
 * The prototype's words for a ready PR: "Tests pass, the change was seen working, self-review is
 * done." Here that is read from two places, and every condition must hold:
 *   - GitHub: open, not a draft, mergeable (no conflicts), no review asking for changes or
 *     still required, and every check finished and passed (a PR with no checks says so);
 *   - the PR body's Evidence and Self-review sections (shared/pr-evidence.ts): at least one
 *     test run, every run exited 0, at least one thing observed, and a recorded self-review
 *     with no high-severity gap and no medium gap left without an issue.
 *
 * The body is the PR author's own account (often an agent's), not something GitHub ran. So a
 * verdict says which parts are claims: `claims` carries what the body says, and Home words the
 * row as "the PR body says…", and says so plainly when GitHub ran no checks at all.
 *
 * Anything not met is a reason, in plain words, so a "Review" row can say why it is not a
 * "Merge" row. Merge itself is never done from Home: the row links to the PR on Work.
 */
import { parsePrSections } from "./pr-evidence";

/** `gh pr view --json number,url,title,state,isDraft,mergeable,reviewDecision,statusCheckRollup,headRefOid,body` */
export interface PrReadyView {
  number: number;
  url?: string;
  title?: string;
  state: string;
  isDraft: boolean;
  mergeable: string;
  reviewDecision: string | null;
  statusCheckRollup: unknown[] | null;
  headRefOid: string;
  body: string | null;
}

export interface ReadyVerdict {
  ready: boolean;
  /** Why it is not ready; empty exactly when ready. */
  reasons: string[];
  /** One line on the checks, e.g. "5 checks passed" or "no checks". */
  checks: string;
  /** The head the verdict is about: Merge on Work must merge this head and no other. */
  headRefOid: string;
  /** No check ran on GitHub: tests and observation rest only on what the body claims. */
  noChecks: boolean;
  /** What the PR body claims (not verified by AnviDeck); null when a section could not be read. */
  claims: {
    testRuns: number;
    observed: number;
    /** Self-review gaps by severity; medium ones listed with their issue, since they do not block. */
    gaps: { high: number; medium: number; low: number };
    mediumGaps: string[];
  } | null;
}

export type ReadyAnswer =
  | ({ status: "ok"; key: string; number: number; repo: string; checkedAt: string } & ReadyVerdict)
  | { status: "could-not-read"; key: string; reason: string };

const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/** One check's outcome: a CheckRun has status + conclusion, a StatusContext has state. */
function checkOutcome(c: unknown): "passed" | "failed" | "pending" {
  const o = (c ?? {}) as Record<string, unknown>;
  if (typeof o.state === "string" && o.status === undefined) {
    const s = o.state.toUpperCase();
    return s === "SUCCESS" ? "passed" : s === "PENDING" || s === "EXPECTED" ? "pending" : "failed";
  }
  if (String(o.status ?? "").toUpperCase() !== "COMPLETED") return "pending";
  return PASSED.has(String(o.conclusion ?? "").toUpperCase()) ? "passed" : "failed";
}

export function judgeReady(v: PrReadyView): ReadyVerdict {
  const reasons: string[] = [];
  if (v.state !== "OPEN") reasons.push(`it is ${v.state.toLowerCase() || "not open"}`);
  if (v.isDraft) reasons.push("it is a draft");
  if (v.mergeable === "CONFLICTING") reasons.push("it has merge conflicts");
  else if (v.mergeable !== "MERGEABLE" && v.state === "OPEN") reasons.push("GitHub has not worked out yet whether it merges cleanly");
  if (v.reviewDecision === "CHANGES_REQUESTED") reasons.push("a review asks for changes");
  else if (v.reviewDecision === "REVIEW_REQUIRED") reasons.push("a required review is missing");

  const rollup = Array.isArray(v.statusCheckRollup) ? v.statusCheckRollup : [];
  const outcomes = rollup.map(checkOutcome);
  const failed = outcomes.filter((o) => o === "failed").length;
  const pending = outcomes.filter((o) => o === "pending").length;
  if (failed) reasons.push(`${failed} of ${outcomes.length} checks failed`);
  if (pending) reasons.push(`${pending} of ${outcomes.length} checks have not finished`);
  const checks = outcomes.length === 0 ? "no checks" : failed || pending ? `${outcomes.length - failed - pending} of ${outcomes.length} checks passed` : `${outcomes.length} checks passed`;

  const s = parsePrSections(v.body);
  if (s.evidence.status === "not recorded") reasons.push("the PR body has no Evidence section");
  else if (s.evidence.status === "malformed") reasons.push(`its Evidence section is written wrong (${s.evidence.reason})`);
  else {
    const e = s.evidence.value;
    if (e.tests.length === 0) reasons.push("its Evidence lists no test run");
    const bad = e.tests.filter((t) => t.exitCode !== 0);
    if (bad.length) reasons.push(`${bad.length} test run${bad.length === 1 ? "" : "s"} in its Evidence exited non-zero`);
    if (e.observed.length === 0) reasons.push("its Evidence records nothing seen working");
  }
  if (s.selfReview.status === "not recorded") reasons.push("the PR body has no Self-review section");
  else if (s.selfReview.status === "malformed") reasons.push(`its Self-review section is written wrong (${s.selfReview.reason})`);
  else {
    // A self-review is a list of what is still wrong. A high gap blocks; a medium one blocks
    // until it has an issue, and is then shown on the row; a low one only counts.
    const g = s.selfReview.value.gaps;
    const high = g.filter((x) => x.severity === "high");
    const untracked = g.filter((x) => x.severity === "medium" && !x.issue);
    if (high.length) {
      const said = high.map((x) => x.gap).join(" / ");
      const short = said.length > 160 ? `${said.slice(0, 160).replace(/\s+\S*$/, "")}…` : said;
      reasons.push(`its self-review lists ${high.length} high-severity gap${high.length === 1 ? "" : "s"}: ${short}`);
    }
    if (untracked.length) reasons.push(`its self-review lists ${untracked.length} medium gap${untracked.length === 1 ? "" : "s"} with no issue filed`);
  }

  const claims =
    s.evidence.status === "recorded" && s.selfReview.status === "recorded"
      ? {
          testRuns: s.evidence.value.tests.length,
          observed: s.evidence.value.observed.length,
          gaps: {
            high: s.selfReview.value.gaps.filter((x) => x.severity === "high").length,
            medium: s.selfReview.value.gaps.filter((x) => x.severity === "medium").length,
            low: s.selfReview.value.gaps.filter((x) => x.severity === "low").length,
          },
          mediumGaps: s.selfReview.value.gaps
            .filter((x) => x.severity === "medium")
            .map((x) => `${x.gap}${x.issue ? ` (${x.issue.repo ?? ""}#${x.issue.number})` : ""}`),
        }
      : null;
  return { ready: reasons.length === 0, reasons, checks, headRefOid: v.headRefOid, noChecks: outcomes.length === 0, claims };
}

const KEY_RE = /^([\w.-]+\/[\w.-]+)#(\d+)$/;

/** "owner/name#12" → { repo, number }, or null when it is not one. */
export function parsePrKey(key: string): { repo: string; number: number } | null {
  const m = KEY_RE.exec(key);
  return m ? { repo: m[1]!, number: Number(m[2]) } : null;
}
