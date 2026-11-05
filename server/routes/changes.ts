import { Hono } from "hono";
import { discoverProjects } from "../readers/projects";
import { ChangesError, listOpenPrs, readChanges } from "../readers/changes";

/**
 * The Changes screen (#84), mounted at /api/changes. Read only: both routes are GETs.
 *
 *   GET /prs?project=<name>          the project's open PRs, newest first
 *   GET /pr/:number?project=<name>   one PR: files, diff, commits' files, layers, boundaries,
 *                                    the agent sessions that made it and what anvi gave them
 *
 * A PR or project that cannot be read answers 4xx/5xx with the reason; parts of a PR that
 * cannot be read are marked inside the answer, never left out.
 */
const changes = new Hono();

function projectPath(name: string | undefined): { name: string; path: string } {
  if (!name) throw new ChangesError(400, "missing ?project=<name>");
  const d = discoverProjects();
  if (d.status === "unreadable") throw new ChangesError(502, `could not read the projects directory: ${d.error}`);
  const p = d.projects.find((x) => x.name === name && x.decoded) ?? d.projects.find((x) => x.name === name);
  if (!p) throw new ChangesError(404, `no project named ${name}`);
  if (!p.decoded) throw new ChangesError(404, `the path of project ${name} could not be determined`);
  return { name: p.name, path: p.decoded };
}

changes.onError((e, c) => {
  if (e instanceof ChangesError) return c.json({ error: e.message }, e.status);
  console.error("[changes]", e);
  return c.json({ error: (e as Error).message }, 500);
});

changes.get("/prs", async (c) => {
  const p = projectPath(c.req.query("project"));
  return c.json(await listOpenPrs(p.name, p.path));
});

changes.get("/pr/:number", async (c) => {
  const n = c.req.param("number");
  if (!/^\d+$/.test(n)) throw new ChangesError(400, "PR number must be a whole number");
  const p = projectPath(c.req.query("project"));
  return c.json(await readChanges(p.name, p.path, Number(n)));
});

export default changes;
