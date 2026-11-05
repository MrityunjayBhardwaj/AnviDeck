/**
 * The Work screen's rules (#85), with no DOM: tests import this file directly.
 *
 *   boardColumns    the board's items by Status column, in the board's own order
 *   prSteps         your workflow, Friction → … → Merge (you), each step from real data
 *   mergeChecks     CI, the closing reference, conflicts with the base and other open PRs
 *   mergeLabel      the Merge button names the commit it will merge
 *   refusalText     what the page says when a write is refused
 *
 * A fact that could not be read is never shown as a pass: "no CI configured" is not green,
 * an unchecked conflict is not "no conflict", a missing Evidence section is not a done step.
 */
import type { BoardItem, CiRead, PrConflicts, PrFacts } from "../../shared/work-types";

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

export const NO_STATUS = "No Status";

export interface Column {
  name: string;
  items: BoardItem[];
}

/**
 * Columns in the board's option order (Todo, In Progress, Done, …). Items whose Status is not one
 * of the options, or empty, go in a "No Status" column at the end, so every item on the board is
 * in exactly one column and the columns' counts sum to the items read.
 */
export function boardColumns(options: string[], items: BoardItem[]): Column[] {
  const cols = new Map<string, BoardItem[]>(options.map((o) => [o, []]));
  const loose: BoardItem[] = [];
  for (const it of items) {
    const c = it.status !== null ? cols.get(it.status) : undefined;
    if (c) c.push(it);
    else loose.push(it);
  }
  const out = [...cols].map(([name, list]) => ({ name, items: list }));
  if (loose.length) out.push({ name: NO_STATUS, items: loose });
  return out;
}

/**
 * "Start agent" is offered on an issue of this repository that nobody has started: not Done, and
 * not In Progress (work there has begun; starting would make a second branch for it).
 */
export function canStartAgent(it: BoardItem, repo: string, column: string): boolean {
  const c = column.toLowerCase();
  return it.type === "Issue" && it.number !== null && (it.repo ?? "").toLowerCase() === repo.toLowerCase() && c !== "done" && c !== "in progress";
}

/** "#681" for this repo's items, "stave #2262" for another repo's, "draft" for a draft. */
export function itemRef(it: BoardItem, repo: string): string {
  if (it.number === null) return "draft";
  if (it.repo && it.repo.toLowerCase() !== repo.toLowerCase()) return `${it.repo.split("/")[1]} #${it.number}`;
  return `#${it.number}`;
}

/** The board read is partial when GitHub counts more items than were read. */
export function boardCoverage(read: number, total: number): string {
  return read >= total ? `${total} items` : `${read} of ${total} items read (the rest are not shown)`;
}

// ---------------------------------------------------------------------------
// Your workflow
// ---------------------------------------------------------------------------

export type StepState = "done" | "missing" | "failed" | "todo";

export interface Step {
  key: "friction" | "issue" | "branch" | "fix" | "test" | "observe" | "pr" | "self-review" | "merge";
  label: string;
  state: StepState;
  /** The first step not done: the one the work is at. */
  now: boolean;
  /** One line: what the state was derived from. */
  detail: string;
}

/** An issue body that states a problem: a "Problem" heading or bold label, or any text at all. */
function statesProblem(body: string): "problem" | "text" | "empty" {
  if (/^\s{0,3}(#{1,6}\s*Problem\b|\*\*Problem\b)/im.test(body)) return "problem";
  return body.trim() ? "text" : "empty";
}

export function prSteps(pr: PrFacts): Step[] {
  const steps: Omit<Step, "now">[] = [];
  const issue = pr.closing[0];
  const ref = (i: { number: number; repo: string }) => (i.repo.toLowerCase() === repoOf(pr.url).toLowerCase() ? `#${i.number}` : `${i.repo}#${i.number}`);

  // Friction: the problem the work came from, as the linked issue records it.
  if (!issue) steps.push({ key: "friction", label: "Friction", state: "missing", detail: "no linked issue, so no recorded friction" });
  else {
    const s = statesProblem(issue.body);
    steps.push(
      s === "empty"
        ? { key: "friction", label: "Friction", state: "missing", detail: `issue ${ref(issue)} has an empty body: the friction is not written down` }
        : { key: "friction", label: "Friction", state: "done", detail: s === "problem" ? `stated under "Problem" in ${ref(issue)}` : `described in ${ref(issue)}` },
    );
  }

  steps.push(
    issue
      ? { key: "issue", label: `Issue ${ref(issue)}`, state: "done", detail: `closing reference GitHub parsed: ${pr.closing.map(ref).join(", ")}` }
      : { key: "issue", label: "Issue", state: "missing", detail: "GitHub parsed no closing reference (Closes #N) in the PR" },
  );

  steps.push(
    pr.headRefName && pr.headRefName !== pr.baseRefName
      ? { key: "branch", label: "Branch", state: "done", detail: `${pr.headRefName} → ${pr.baseRefName}` }
      : { key: "branch", label: "Branch", state: "missing", detail: `the PR's head is the base branch ${pr.baseRefName}` },
  );

  steps.push(
    pr.commits > 0
      ? { key: "fix", label: "Fix", state: "done", detail: `${pr.commits} commit${pr.commits === 1 ? "" : "s"} on ${pr.headRefName}` }
      : { key: "fix", label: "Fix", state: "missing", detail: "no commits" },
  );

  const ev = pr.sections.evidence;
  if (ev.status === "recorded") {
    const tests = ev.value.tests;
    const bad = tests.filter((t) => t.exitCode !== 0);
    steps.push(
      tests.length === 0
        ? { key: "test", label: "Test", state: "missing", detail: "Evidence lists no test run" }
        : bad.length
          ? { key: "test", label: "Test", state: "failed", detail: `${bad.map((t) => `${t.command} exit ${t.exitCode}`).join("; ")} (runner's own exit status)` }
          : { key: "test", label: "Test", state: "done", detail: `${tests.length} run${tests.length === 1 ? "" : "s"}, each exit 0: ${tests.map((t) => `${t.command}: ${t.result}`).join("; ")}` },
    );
    steps.push(
      ev.value.observed.length
        ? { key: "observe", label: "Observe", state: "done", detail: `${ev.value.observed.length} observation${ev.value.observed.length === 1 ? "" : "s"} in Evidence` }
        : { key: "observe", label: "Observe", state: "missing", detail: "Evidence records nothing observed" },
    );
  } else {
    const why = ev.status === "malformed" ? `Evidence is malformed: ${ev.reason}` : "Evidence not recorded in the PR body";
    const state: StepState = ev.status === "malformed" ? "failed" : "missing";
    steps.push({ key: "test", label: "Test", state, detail: why });
    steps.push({ key: "observe", label: "Observe", state, detail: why });
  }

  steps.push(
    pr.isDraft
      ? { key: "pr", label: "PR", state: "missing", detail: "open as a draft" }
      : { key: "pr", label: "PR", state: "done", detail: "open, ready for review" },
  );

  const sr = pr.sections.selfReview;
  steps.push(
    sr.status === "recorded"
      ? { key: "self-review", label: "Self-review", state: "done", detail: sr.value.gaps.length ? `${sr.value.gaps.length} gap${sr.value.gaps.length === 1 ? "" : "s"} recorded, ${sr.value.gaps.filter((g) => g.issue).length} with an issue` : "none found" }
      : sr.status === "malformed"
        ? { key: "self-review", label: "Self-review", state: "failed", detail: `Self-review is malformed: ${sr.reason}` }
        : { key: "self-review", label: "Self-review", state: "missing", detail: "Self-review not recorded in the PR body" },
  );

  steps.push({ key: "merge", label: "Merge (you)", state: "todo", detail: "only you merge, with the button below; agents never do" });

  const at = steps.findIndex((s) => s.state !== "done");
  return steps.map((s, i) => ({ ...s, now: i === at }));
}

/** "owner/name" from a PR URL. */
export function repoOf(url: string): string {
  const m = /github\.com\/([^/]+\/[^/]+)\//.exec(url);
  return m ? m[1]! : "";
}

// ---------------------------------------------------------------------------
// Merge checks
// ---------------------------------------------------------------------------

export type CheckState = "ok" | "bad" | "pending" | "none" | "unknown";

export interface Check {
  key: "ci" | "closing" | "base" | "others";
  state: CheckState;
  text: string;
  /** What it was read from, shown on hover. */
  detail: string;
}

const CI_OK = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const CI_PENDING = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", ""]);

export function ciCheck(ci: CiRead): Check {
  const from = "the head commit's statusCheckRollup on GitHub";
  // No checks at all is "no CI configured": never green.
  if (ci.rollup === null || ci.total === 0) return { key: "ci", state: "none", text: "no CI configured", detail: `${from}: no checks on the head commit` };
  const failing = ci.contexts.filter((c) => !CI_OK.has(c.state) && !CI_PENDING.has(c.state));
  const pending = ci.contexts.filter((c) => CI_PENDING.has(c.state));
  const cut = ci.total > ci.contexts.length ? ` (${ci.contexts.length} of ${ci.total} read)` : "";
  if (ci.rollup === "SUCCESS" && !failing.length && !pending.length) return { key: "ci", state: "ok", text: `CI green (${ci.total} check${ci.total === 1 ? "" : "s"})`, detail: `${from}${cut}` };
  if (ci.rollup === "PENDING" || ci.rollup === "EXPECTED") {
    return { key: "ci", state: "pending", text: `CI running (${pending.length} of ${ci.total} pending)`, detail: `${from}: ${pending.map((c) => c.name).join(", ")}${cut}` };
  }
  return {
    key: "ci",
    state: "bad",
    text: failing.length ? `CI failing: ${failing.map((c) => c.name).join(", ")}` : `CI ${ci.rollup.toLowerCase()}`,
    detail: `${from}: rollup ${ci.rollup}${cut}`,
  };
}

export function closingCheck(pr: PrFacts): Check {
  const from = "GitHub's closingIssuesReferences for the PR";
  if (!pr.closing.length) return { key: "closing", state: "bad", text: "no closing reference parsed", detail: `${from}: none. A PR body says "Closes #N" when it finishes the issue` };
  return { key: "closing", state: "ok", text: `closes ${pr.closing.map((i) => `#${i.number}`).join(", ")} parsed`, detail: from };
}

/** Conflicts with the base branch: GitHub's own answer and git merge-tree must both be clean. */
export function baseCheck(pr: PrFacts, c: PrConflicts, base: string): Check {
  const from = `git merge-tree of the head against ${base}'s tip ${pr.baseRefOid.slice(0, 7)}; GitHub says ${pr.mergeable}`;
  if (pr.mergeable === "CONFLICTING") return { key: "base", state: "bad", text: `conflicts with ${base}`, detail: from };
  if (c.state !== "checked") return { key: "base", state: "unknown", text: `conflicts with ${base} not checked`, detail: c.reason };
  if (c.base.state === "conflict") return { key: "base", state: "bad", text: `conflicts with ${base}: ${c.base.files.join(", ")}`, detail: from };
  if (c.base.state === "unchecked") return { key: "base", state: "unknown", text: `conflicts with ${base} not checked`, detail: c.base.reason };
  return { key: "base", state: "ok", text: `no conflict with ${base}`, detail: from };
}

export function othersCheck(c: PrConflicts): Check {
  const from = "git merge-tree of the head against each other open PR's head";
  if (c.state !== "checked") return { key: "others", state: "unknown", text: "conflicts with open PRs not checked", detail: c.reason };
  if (!c.others.length) return { key: "others", state: "ok", text: "no other open PRs", detail: from };
  const bad = c.others.filter((o) => o.result.state === "conflict");
  const unk = c.others.filter((o) => o.result.state === "unchecked");
  if (bad.length) {
    return {
      key: "others",
      state: "bad",
      text: `conflicts with ${bad.map((o) => `#${o.number}`).join(", ")}`,
      detail: `${from}: ${bad.map((o) => `#${o.number} (${o.result.state === "conflict" ? o.result.files.join(", ") : ""})`).join("; ")}`,
    };
  }
  if (unk.length) return { key: "others", state: "unknown", text: `${unk.length} of ${c.others.length} open PRs not checked`, detail: unk.map((o) => `#${o.number}: ${o.result.state === "unchecked" ? o.result.reason : ""}`).join("; ") };
  return { key: "others", state: "ok", text: `no conflict with ${c.others.length} open PR${c.others.length === 1 ? "" : "s"}`, detail: from };
}

/** The checks beside Merge. Conflicts are with the PR's own base: a stacked PR's base is another PR's branch. */
export function mergeChecks(pr: PrFacts & { conflicts: PrConflicts }): Check[] {
  return [ciCheck(pr.ci), closingCheck(pr), baseCheck(pr, pr.conflicts, pr.baseRefName), othersCheck(pr.conflicts)];
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export const shortSha = (sha: string) => sha.slice(0, 7);

/** The button names the commit it merges: what it shows is exactly what it approves. */
export function mergeLabel(head: string): string {
  return `Merge ${shortSha(head)}`;
}

/** The second click's words: the PR, the commit, the method and the base. */
export function confirmLabel(pr: { number: number; headRefOid: string; baseRefName: string }): string {
  return `Squash-merge #${pr.number} at ${shortSha(pr.headRefOid)} into ${pr.baseRefName}`;
}

/** Why Merge is not offered, or null when it is. Checks that are not green are shown beside it, not hidden by it. */
export function mergeBlocked(pr: PrFacts): string | null {
  if (pr.isDraft) return "a draft cannot be merged; mark it ready on GitHub";
  if (!/^[0-9a-f]{40}$/.test(pr.headRefOid)) return "the PR's head commit could not be read";
  return null;
}

/** What the page says about a refused or failed write, from the server's answer. */
export function refusalText(status: number, body: Record<string, unknown>): string {
  const error = typeof body.error === "string" ? body.error : `request failed (${status})`;
  if (body.refusal === "head-moved") {
    const was = typeof body.reviewedHead === "string" ? shortSha(body.reviewedHead) : "?";
    const now = typeof body.currentHead === "string" ? shortSha(body.currentHead) : "unknown";
    return `Refused, nothing merged: the PR's head moved since this page showed it (you reviewed ${was}, it is now ${now}). Reload and review the new commits.`;
  }
  if (status === 403) return `Refused by the write guard: ${error}`;
  return `Not done: ${error}`;
}

/** "#work?pr=12" focuses one PR; anything else shows them all. */
export function focusedPr(params: URLSearchParams): number | null {
  const v = params.get("pr");
  return v && /^\d+$/.test(v) ? Number(v) : null;
}
