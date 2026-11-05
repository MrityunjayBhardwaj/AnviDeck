import { Hono } from "hono";
import type { Context } from "hono";
import { sameOriginWrites } from "../guard";
import { knownProjects, resolveProject, timedRun, WorkError } from "../readers/work";
import { createIssue, mergePr } from "../work/act";
import { onWorkError, type WorkDeps } from "./work";

/**
 * The Work screen's two actions (#85), mounted at /api:
 *
 *   POST /api/issues                { project, title, body? }      files an issue (gh issue create)
 *   POST /api/prs/:n/merge          { project, head, base }        merges only that head into that base (squash), or 409
 *
 * Both are writes: the guard installed on the whole app (server/guard.ts) lets them through only
 * with this server's Origin and token, and appends each one, accepted or refused, to the action
 * log. The token is placed in AnviDeck's pages; a process on this machine that fetches a page can
 * read it too, so "only you press Merge" is not yet enforced against local processes (#147).
 */
export function workActionRoutes(deps: WorkDeps = {}): Hono {
  const run = deps.run ?? timedRun(60_000);
  const projects = deps.projects ?? knownProjects;
  const r = new Hono();
  r.onError(onWorkError);

  const body = async (c: Context): Promise<Record<string, unknown>> => {
    try {
      const b = await c.req.json();
      return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
    } catch {
      throw new WorkError(400, "body must be JSON");
    }
  };

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
    return c.json(await mergePr(run, p.repo, Number(n), typeof b.head === "string" ? b.head : "", typeof b.base === "string" ? b.base : ""));
  });

  return r;
}
