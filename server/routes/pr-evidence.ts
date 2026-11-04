import { Hono } from "hono";
import { runAsync } from "../readers/replay";
import { parsePrSections, PR_SECTIONS_INSTRUCTIONS, PR_SECTIONS_EXAMPLE } from "../../shared/pr-evidence";

/**
 * PR-body Evidence and Self-review sections (issue #83), mounted at /api/pr-evidence.
 *
 *   GET /format                       the instruction text agents are given, and its example
 *   GET /pr/:number?repo=owner/name   one PR's two sections, parsed
 *
 * Read only. "Could not read the PR" is a 502 with the reason, never a
 * "not recorded" answer, so a GitHub failure cannot pass for a PR without the sections.
 */
const prEvidence = new Hono();

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

prEvidence.get("/format", (c) => c.json({ instructions: PR_SECTIONS_INSTRUCTIONS, example: PR_SECTIONS_EXAMPLE }));

prEvidence.get("/pr/:number", async (c) => {
  const n = c.req.param("number");
  const repo = c.req.query("repo");
  if (!/^\d+$/.test(n)) return c.json({ error: "PR number must be a whole number" }, 400);
  if (!repo || !REPO_RE.test(repo)) return c.json({ error: "missing or invalid ?repo=<owner>/<name>" }, 400);
  const r = await runAsync(["gh", "pr", "view", n, "--repo", repo, "--json", "number,url,body"], 15000);
  if (!r.ok) return c.json({ error: `could not read PR ${repo}#${n} from GitHub: ${r.err || "gh failed"}` }, 502);
  let pr: { number: number; url: string; body: string };
  try {
    pr = JSON.parse(r.out);
  } catch {
    return c.json({ error: `could not read PR ${repo}#${n}: gh returned non-JSON output` }, 502);
  }
  return c.json({ repo, number: pr.number, url: pr.url, ...parsePrSections(pr.body) });
});

export default prEvidence;
