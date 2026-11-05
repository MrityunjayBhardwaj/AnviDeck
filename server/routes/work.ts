import { Hono } from "hono";
import type { Context } from "hono";
import { sameOriginWrites } from "../guard";
import type { KnownProject } from "../agents/from-issue";
import type { Run } from "../agents/worktree";
import { knownProjects, readBoard, readOpenPrs, resolveProject, timedRun, WorkError } from "../work/github";
import { conflictsOf, WORK_TMP } from "../work/conflicts";
import { createIssue, mergePr } from "../work/act";
import type { BoardResponse, PrsResponse } from "../../shared/work-types";

/**
 * The Work screen (#85), mounted at /api:
 *
 *   GET  /api/work/board?project=   the board by Status column, or the open issues when there is no board
 *   GET  /api/work/prs?project=     open PRs: workflow facts, CI, closing refs, conflicts (git merge-tree)
 *   POST /api/issues                { project, title, body? }  files an issue (gh issue create)
 *   POST /api/prs/:n/merge          { project, head }          merges only that head (squash), or 409
 *
 * The POSTs are writes: the guard installed on the whole app (server/guard.ts) lets them through
 * only with this server's Origin and token, and appends each one, accepted or refused, to the
 * action log. Only AnviDeck's own pages carry the token, and Merge is a button you press there.
 */

export interface WorkDeps {
  run?: Run;
  projects?: () => KnownProject[];
  tmpRoot?: string;
  now?: () => Date;
}

export function workRoutes(deps: WorkDeps = {}): Hono {
  // gh and git reads can stall on the network: each command gets at most a minute.
  const run = deps.run ?? timedRun(60_000);
  const projects = deps.projects ?? knownProjects;
  const now = deps.now ?? (() => new Date());
  const r = new Hono();

  r.onError((e, c) => {
    if (e instanceof WorkError) return c.json({ ...e.detail, error: e.message }, e.status);
    console.error("[work]", e);
    return c.json({ error: (e as Error).message }, 500);
  });

  const body = async (c: Context): Promise<Record<string, unknown>> => {
    try {
      const b = await c.req.json();
      return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
    } catch {
      throw new WorkError(400, "body must be JSON");
    }
  };

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

  r.post("/issues", sameOriginWrites, async (c) => {
    const b = await body(c);
    const p = await resolveProject(run, projects, typeof b.project === "string" ? b.project : "");
    return c.json(await createIssue(run, p.repo, b.title, b.body), 201);
  });

  r.post("/prs/:n/merge", sameOriginWrites, async (c) => {
    const n = c.req.param("n");
    if (!/^\d+$/.test(n)) throw new WorkError(400, "PR number must be a whole number");
    const b = await body(c);
    const p = await resolveProject(run, projects, typeof b.project === "string" ? b.project : "");
    return c.json(await mergePr(run, p.repo, Number(n), typeof b.head === "string" ? b.head : ""));
  });

  return r;
}
