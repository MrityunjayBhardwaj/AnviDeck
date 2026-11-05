import { Hono } from "hono";
import type { Context } from "hono";
import { sameOriginWrites } from "../guard";
import { projectTop, readCodeFile, readCodeTree } from "../readers/code";
import { agentFacts, agentsRead, type HostLike } from "../code-touch";
import { applyEdit, CodeEditError, readWorking, type EditDeps } from "../code-edit";

/**
 * Project · Code (#88), mounted at /api/code:
 *
 *   GET  /api/code/:project[?ref=][&path=][&package=]   the package's files at the commit the design
 *        reader measured, the design reader's answer itself, the catalogues' file:line citations
 *        placed on files, and what AnviDeck's agents edited there (from the agent host)
 *   GET  /api/code/:project/file?path=<repo path>&sha=<commit>   one file at that commit, with git blame
 *   GET  /api/code/:project/working?path=<repo path>   the working copy an edit would replace, its
 *        sha256, and whether a running agent keeps it read-only now
 *   POST /api/code/:project/edit   { path, baseHash, content }   writes it (server/code-edit.ts), or
 *        refuses: 409 when an agent touches it or it changed since it was opened, 400 for a path
 *        outside the project, a symlink or .git, 503 when the agent host cannot be asked.
 *        A write: the guard installed on the whole app admits it only from AnviDeck's own pages
 *        with this server's token, and the action log records it either way.
 *
 * Refusals are not here: the page reads GET /api/refusals, the same answer every screen reads.
 */
export function codeRoutes(deps: { host: () => HostLike | null; hostOff?: () => string | null; edit?: Partial<EditDeps>; registry?: { locked?: string; user?: string } }): Hono {
  const r = new Hono();
  r.use("/*", sameOriginWrites);
  r.onError((e, c) => {
    if (e instanceof CodeEditError) return c.json({ ...e.detail, error: e.message }, e.status);
    return c.json({ error: (e as Error).message }, 500);
  });

  const editDeps = (): EditDeps => ({
    agents: () => {
      const h = deps.host();
      if (!h) return { off: deps.hostOff?.() ?? "the agent host is not running" };
      return agentFacts(h);
    },
    top: (p: string) => projectTop(p, { registry: deps.registry }),
    ...deps.edit,
  });

  r.get("/:project", async (c) => {
    const { response, notFound } = await readCodeTree(c.req.param("project"), {
      ref: c.req.query("ref") ?? null,
      path: c.req.query("path") ?? null,
      package: c.req.query("package") ?? null,
      signal: c.req.raw.signal,
      registry: deps.registry,
      agents: (ctx) => agentsRead(deps.host(), deps.hostOff?.() ?? null, ctx),
    });
    return c.json(response, notFound ? 404 : 200);
  });

  r.get("/:project/file", (c) => {
    const { response, status } = readCodeFile(c.req.param("project"), c.req.query("path"), c.req.query("sha"), { path: c.req.query("dir") ?? null, registry: deps.registry });
    return c.json(response, status as 200);
  });

  r.get("/:project/working", (c) => c.json(readWorking(c.req.param("project"), c.req.query("path"), editDeps())));

  r.post("/:project/edit", async (c: Context) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new CodeEditError(400, "body must be JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new CodeEditError(400, "body must be a JSON object");
    return c.json(applyEdit(c.req.param("project") ?? "", body as Record<string, unknown>, editDeps()), 200);
  });

  return r;
}
