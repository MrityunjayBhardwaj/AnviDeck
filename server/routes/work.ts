import { Hono, type ErrorHandler } from "hono";
import { knownProjects, readBoard, readOpenPrs, resolveProject, timedRun, WorkError } from "../readers/work";
import { conflictsOf, WORK_TMP } from "../readers/work-conflicts";
import type { KnownProject, Run } from "../readers/repo";
import type { BoardResponse, PrsResponse } from "../../shared/work-types";

/**
 * The Work screen's reads (#85), mounted at /api. Reads only: the actions (New issue, Merge)
 * are in work-actions.ts, so this file never imports the write guard or an actor.
 *
 *   GET  /api/work/board?project=   the board by Status column, or the open issues when there is no board
 *   GET  /api/work/prs?project=     open PRs: workflow facts, CI, closing refs, conflicts (git merge-tree)
 *
 * GET /api/work/prs writes only in its scratch folder (ANVIDECK_WORK_TMP): see
 * server/readers/work-conflicts.ts.
 */

export interface WorkDeps {
  run?: Run;
  projects?: () => KnownProject[];
  tmpRoot?: string;
  now?: () => Date;
}

/** A WorkError answers its own status and detail; anything else is a 500. */
export const onWorkError: ErrorHandler = (e, c) => {
  if (e instanceof WorkError) return c.json({ ...e.detail, error: e.message }, e.status);
  console.error("[work]", e);
  return c.json({ error: (e as Error).message }, 500);
};

export function workRoutes(deps: WorkDeps = {}): Hono {
  // gh and git reads can stall on the network: each command gets at most a minute.
  const run = deps.run ?? timedRun(60_000);
  const projects = deps.projects ?? knownProjects;
  const now = deps.now ?? (() => new Date());
  const r = new Hono();
  r.onError(onWorkError);

  r.get("/work/board", async (c) => {
    const p = await resolveProject(run, projects, c.req.query("project") ?? "");
    const read = await readBoard(run, p.repo);
    const out: BoardResponse = { project: p.project, repo: p.repo, readAt: now().toISOString(), ...read };
    return c.json(out);
  });

  r.get("/work/prs", async (c) => {
    const p = await resolveProject(run, projects, c.req.query("project") ?? "");
    const read = await readOpenPrs(run, p.repo);
    // GitHub could not be read: a 502 with the reason, never "no open PRs".
    if (read.state === "unreadable") throw new WorkError(502, read.reason, { refusal: "github-unread" });
    const conflicts = await conflictsOf(run, {
      repo: p.repo,
      main: p.main,
      heads: read.prs.map((x) => ({ number: x.number, oid: x.headRefOid, base: { name: x.baseRefName, oid: x.baseRefOid } })),
      tmpRoot: deps.tmpRoot ?? WORK_TMP,
    });
    const out: PrsResponse = {
      project: p.project,
      repo: p.repo,
      readAt: now().toISOString(),
      base: read.base,
      total: read.total,
      prs: read.prs.map((x) => ({ ...x, conflicts: conflicts.get(x.number) ?? { state: "unchecked", reason: "not checked" } })),
    };
    return c.json(out);
  });

  return r;
}
