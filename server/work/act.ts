import type { Run } from "../readers/repo";
import type { MergeAnswer, NewIssueAnswer } from "../../shared/work-types";
import { WorkError } from "../readers/work";

/**
 * The Work screen's two actions (#85). Each is reached only through the write guard (this
 * server's Origin and token) and is recorded in the action log by it; see server/guard.ts.
 *
 *   mergePr      merges exactly the head the page showed you, into the base it showed, or refuses
 *   createIssue  files an issue in the project's own repository
 */

const said = (r: { stderr: string; stdout: string; code: number }) => (r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.code}`;

export const FULL_SHA = /^[0-9a-f]{40}$/;

/** A branch name as GitHub shows it: not empty, no spaces or control characters. */
const BRANCH = /^[^\s\x00-\x1f~^:?*[\\]{1,255}$/;

type Back = { state: string; mergeCommit: { oid: string } | null; mergedAt: string | null };

/** The PR as GitHub has it after a merge was asked for: its state, or why it could not be read. */
async function readBack(run: Run, repo: string, number: number): Promise<{ ok: true; j: Back } | { ok: false; why: string }> {
  const r = await run("gh", ["pr", "view", String(number), "--repo", repo, "--json", "state,mergeCommit,mergedAt"]);
  if (r.code !== 0) return { ok: false, why: said(r) };
  try {
    const j = JSON.parse(r.stdout) as Back;
    if (!j || typeof j.state !== "string") throw new Error("no state");
    return { ok: true, j };
  } catch {
    return { ok: false, why: "GitHub's answer could not be read" };
  }
}

/**
 * Merge PR `number` of `repo` (squash), only if its head is still `head`, the commit the page
 * showed and you reviewed, and its base is still `base`, the branch the confirmation named.
 * Both are read first and compared: a moved head answers 409 "head-moved" with the current head,
 * a retargeted PR 409 "base-moved" with the current base. Then
 * `gh pr merge --match-head-commit <head>` makes GitHub refuse too if the head moves between the
 * read and the merge. gh has no such guard for the base, so a retarget inside that window (the
 * time of one gh call) is not caught.
 *
 * When gh reports a failure that is not a moved head, the PR is read back before answering,
 * because gh can fail after GitHub merged (a timeout, a dropped connection):
 *   MERGED                  merged (200), with gh's words in ghFailed
 *   open or closed          GitHub did not merge (502 "merge-failed")
 *   read-back failed too    not known (502 "merge-unknown"): check on GitHub before retrying
 * After a merge gh reported, the read-back can only add facts: a failed read-back never turns
 * the merge into a failure.
 */
export async function mergePr(run: Run, repo: string, number: number, head: string, base: string): Promise<MergeAnswer> {
  if (!Number.isInteger(number) || number <= 0) throw new WorkError(400, "PR number must be a positive whole number");
  if (!FULL_SHA.test(head)) throw new WorkError(400, "head must be the full 40-character commit the page showed you (the commit you reviewed)");
  if (!BRANCH.test(base)) throw new WorkError(400, "base must be the branch the page showed the PR merging into");
  const v = await run("gh", ["pr", "view", String(number), "--repo", repo, "--json", "number,state,isDraft,headRefOid,baseRefName"]);
  if (v.code !== 0) {
    const why = said(v);
    if (/Could not resolve to a PullRequest/i.test(why)) throw new WorkError(404, `${repo} has no PR #${number}`, { refusal: "no-pr" });
    throw new WorkError(502, `could not ask GitHub for PR #${number} of ${repo}, so nothing was merged: ${why}`, { refusal: "github-unread" });
  }
  let now: { state: string; isDraft: boolean; headRefOid: string; baseRefName: string };
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
  if (now.baseRefName !== base) {
    throw new WorkError(409, `PR #${number} now merges into ${String(now.baseRefName)}, not ${base} as the page showed it. Nothing was merged; reload and check where it goes`, {
      refusal: "base-moved",
      shownBase: base,
      currentBase: now.baseRefName ?? null,
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
    // gh can fail after GitHub merged (a timeout, a dropped connection): ask GitHub what happened.
    const b = await readBack(run, repo, number);
    if (!b.ok) {
      throw new WorkError(502, `not known whether PR #${number} merged: gh pr merge failed (${why}) and reading the PR back failed too (${b.why}). Check it on GitHub before trying again`, {
        refusal: "merge-unknown",
      });
    }
    if (b.j.state !== "MERGED") {
      throw new WorkError(502, `GitHub did not merge PR #${number}: ${why} (read back: it is ${b.j.state.toLowerCase()})`, { refusal: "merge-failed", state: b.j.state });
    }
    return { merged: true, repo, number, head, base, method: "squash", ghFailed: why, readBack: { state: "read", mergeCommit: b.j.mergeCommit?.oid ?? null, mergedAt: b.j.mergedAt } };
  }
  const b = await readBack(run, repo, number);
  const back: MergeAnswer["readBack"] = !b.ok
    ? { state: "unreadable", reason: `merged, but the read-back failed: ${b.why}` }
    : b.j.state === "MERGED"
      ? { state: "read", mergeCommit: b.j.mergeCommit?.oid ?? null, mergedAt: b.j.mergedAt }
      : { state: "unreadable", reason: `gh merged it, but GitHub still says ${b.j.state}` };
  return { merged: true, repo, number, head, base, method: "squash", readBack: back };
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
