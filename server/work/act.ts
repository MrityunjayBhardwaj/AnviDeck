import type { Run } from "../agents/worktree";
import type { MergeAnswer, NewIssueAnswer } from "../../shared/work-types";
import { WorkError } from "./github";

/**
 * The Work screen's two actions (#85). Each is reached only through the write guard (this
 * server's Origin and token) and is recorded in the action log by it; see server/guard.ts.
 *
 *   mergePr      merges exactly the head the page showed you, or refuses
 *   createIssue  files an issue in the project's own repository
 */

const said = (r: { stderr: string; stdout: string; code: number }) => (r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.code}`;

export const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Merge PR `number` of `repo` (squash), only if its head is still `head`, the commit the page
 * showed and you reviewed. The head is read first and compared (a moved head answers 409
 * "head-moved" with the current head); then `gh pr merge --match-head-commit <head>` makes
 * GitHub refuse too if the head moves between the read and the merge.
 * After GitHub merged it, the read-back can only add facts: a failed read-back never turns the
 * merge into a failure.
 */
export async function mergePr(run: Run, repo: string, number: number, head: string): Promise<MergeAnswer> {
  if (!Number.isInteger(number) || number <= 0) throw new WorkError(400, "PR number must be a positive whole number");
  if (!FULL_SHA.test(head)) throw new WorkError(400, "head must be the full 40-character commit the page showed you (the commit you reviewed)");
  const v = await run("gh", ["pr", "view", String(number), "--repo", repo, "--json", "number,state,isDraft,headRefOid"]);
  if (v.code !== 0) {
    const why = said(v);
    if (/Could not resolve to a PullRequest/i.test(why)) throw new WorkError(404, `${repo} has no PR #${number}`, { refusal: "no-pr" });
    throw new WorkError(502, `could not ask GitHub for PR #${number} of ${repo}, so nothing was merged: ${why}`, { refusal: "github-unread" });
  }
  let now: { state: string; isDraft: boolean; headRefOid: string };
  try {
    now = JSON.parse(v.stdout);
  } catch {
    throw new WorkError(502, `GitHub's answer for PR #${number} of ${repo} could not be read, so nothing was merged`, { refusal: "github-unread" });
  }
  if (now.state !== "OPEN") throw new WorkError(409, `PR #${number} is ${String(now.state).toLowerCase()}, not open; nothing was merged`, { refusal: "not-open", state: now.state });
  if (now.isDraft) throw new WorkError(409, `PR #${number} is a draft; mark it ready on GitHub first. Nothing was merged`, { refusal: "draft" });
  if (now.headRefOid !== head) {
    throw new WorkError(409, `PR #${number}'s head moved since the page showed it: you reviewed ${head.slice(0, 7)}, its head is now ${String(now.headRefOid).slice(0, 7)}. Nothing was merged; review the new commits first`, {
      refusal: "head-moved",
      reviewedHead: head,
      currentHead: now.headRefOid,
    });
  }
  const m = await run("gh", ["pr", "merge", String(number), "--repo", repo, "--squash", "--match-head-commit", head]);
  if (m.code !== 0) {
    const why = said(m);
    if (/head (branch )?was modified|match-head-commit|expected head/i.test(why)) {
      throw new WorkError(409, `GitHub refused: PR #${number}'s head moved just before the merge (${why}). Nothing was merged; review the new commits first`, {
        refusal: "head-moved",
        reviewedHead: head,
        currentHead: null,
      });
    }
    throw new WorkError(502, `GitHub did not merge PR #${number}: ${why}`, { refusal: "merge-failed" });
  }
  const back = await run("gh", ["pr", "view", String(number), "--repo", repo, "--json", "state,mergeCommit,mergedAt"]);
  let readBack: MergeAnswer["readBack"];
  try {
    if (back.code !== 0) throw new Error(said(back));
    const j = JSON.parse(back.stdout) as { state: string; mergeCommit: { oid: string } | null; mergedAt: string | null };
    readBack = j.state === "MERGED" ? { state: "read", mergeCommit: j.mergeCommit?.oid ?? null, mergedAt: j.mergedAt } : { state: "unreadable", reason: `gh merged it, but GitHub still says ${j.state}` };
  } catch (e) {
    readBack = { state: "unreadable", reason: `merged, but the read-back failed: ${(e as Error).message}` };
  }
  return { merged: true, repo, number, head, method: "squash", readBack };
}

export const TITLE_MAX = 256;
export const BODY_MAX = 65_536;

/** File an issue in `repo` with gh, and read its number from the URL gh printed (checked to be this repo's). */
export async function createIssue(run: Run, repo: string, title: unknown, body: unknown): Promise<NewIssueAnswer> {
  const t = typeof title === "string" ? title.trim() : "";
  if (!t) throw new WorkError(400, "an issue needs a title");
  if (t.length > TITLE_MAX) throw new WorkError(400, `the title is ${t.length} characters; at most ${TITLE_MAX}`);
  if (body !== undefined && typeof body !== "string") throw new WorkError(400, "body must be text");
  const b = (body as string | undefined) ?? "";
  if (b.length > BODY_MAX) throw new WorkError(400, `the body is ${b.length} characters; at most ${BODY_MAX}`);
  const r = await run("gh", ["issue", "create", "--repo", repo, "--title", t, "--body", b]);
  if (r.code !== 0) throw new WorkError(502, `GitHub did not create the issue: ${said(r)}`, { refusal: "create-failed" });
  const url = r.stdout.trim().split("\n").pop() ?? "";
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/?$/.exec(url);
  // gh said it worked: the issue exists even if its answer is odd, so this is never an error.
  if (!m || m[1]!.toLowerCase() !== repo.toLowerCase()) return { id: `${repo}#?`, repo, number: null, url };
  return { id: `${repo}#${m[2]}`, repo, number: Number(m[2]), url };
}
