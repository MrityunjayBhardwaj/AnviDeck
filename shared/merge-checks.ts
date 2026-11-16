/**
 * The merge checks both sides of Merge use (#85, #148): the Work page shows them beside the
 * button and names every red one in the confirmation; the server reads the cheap ones again just
 * before merging and refuses a red check the confirmation did not name. One copy of each rule,
 * so the page and the server cannot disagree about what "red" means.
 *
 * A fact that could not be read is never a pass: "no CI configured" is not green.
 */
import type { CiRead } from "./work-types";

export type CheckState = "ok" | "bad" | "pending" | "none" | "unknown";

export type CheckKey = "ci" | "closing" | "base" | "others";
export const CHECK_KEYS: readonly CheckKey[] = ["ci", "closing", "base", "others"];

export interface Check {
  key: CheckKey;
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

export function closingCheck(pr: { closing: { number: number }[] }): Check {
  const from = "GitHub's closingIssuesReferences for the PR";
  if (!pr.closing.length) return { key: "closing", state: "bad", text: "no closing reference parsed", detail: `${from}: none. A PR body says "Closes #N" when it finishes the issue` };
  return { key: "closing", state: "ok", text: `closes ${pr.closing.map((i) => `#${i.number}`).join(", ")} parsed`, detail: from };
}

/**
 * The head commit's CI from `gh pr view --json statusCheckRollup`, which lists the contexts but
 * not GitHub's rollup state. The rollup is derived the way GitHub derives it: any failing context
 * fails it, else any pending one keeps it pending, else it is green.
 */
export function ciFromContexts(list: unknown): CiRead {
  const nodes = Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
  const contexts = nodes.map((n) =>
    n?.__typename === "StatusContext"
      ? { name: String(n.context ?? "status"), state: String(n.state ?? "") }
      : { name: String(n?.name ?? "check"), state: String(n?.conclusion ?? n?.status ?? "") },
  );
  if (!contexts.length) return { rollup: null, contexts: [], total: 0 };
  const rollup = contexts.some((c) => !CI_OK.has(c.state) && !CI_PENDING.has(c.state))
    ? "FAILURE"
    : contexts.some((c) => CI_PENDING.has(c.state))
      ? "PENDING"
      : "SUCCESS";
  return { rollup, contexts, total: contexts.length };
}

/**
 * The checks the server can read again in the same gh call that reads the head, and that are red
 * now: CI, the closing reference, and GitHub's own answer on conflicts with the base. Conflicts
 * with other open PRs need git merge-tree runs and are not read again here.
 */
export function redAtMerge(now: { ci: CiRead; closing: { number: number }[]; mergeable: string }): Check[] {
  const base: Check | null = now.mergeable === "CONFLICTING" ? { key: "base", state: "bad", text: "conflicts with its base (GitHub says CONFLICTING)", detail: "GitHub's mergeable for the PR" } : null;
  return [ciCheck(now.ci), closingCheck(now), base].filter((c): c is Check => c !== null && c.state === "bad");
}
