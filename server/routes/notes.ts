import { Hono } from "hono";
import { knownProjects } from "../readers/repo";
import type { KnownProject } from "../readers/repo";
import { readCurrency, readGtCheck, readSnapshotSeries, readUsage, snapshotKey, type SpawnFn } from "../readers/notes";
import { resolveDir } from "../../shared/anvi-paths";

/**
 * The Notes screen's reads (#89), mounted at /api/notes. Read only: Re-check and Promote start
 * an agent through POST /api/agents (the agent host), never through here.
 *
 *   GET /api/notes/currency?project=[&refresh=1]  anvi's currency report (runs in the background:
 *                                                  "measuring" until it finishes) and the fleet
 *                                                  snapshot series for the project
 *   GET /api/notes/usage?project=                 injector deliveries per entry, last 30 days
 *   GET /api/notes/grounding?project=             anvi's Ground Truth citation check of the ref folder
 */
export function notesRoutes(deps: { projects?: () => KnownProject[]; spawnFn?: SpawnFn; script?: string; gtScript?: string; healthDir?: string } = {}): Hono {
  const projects = deps.projects ?? knownProjects;
  const r = new Hono();

  const find = (name: string) => projects().find((p) => p.name === name);
  const unknown = (name: string) => ({ error: `no project named "${name}" whose folder is known` });

  r.get("/currency", (c) => {
    const name = c.req.query("project") ?? "";
    const p = find(name);
    if (!p) return c.json(unknown(name), 404);
    const currency = readCurrency(p.name, p.path, { refresh: c.req.query("refresh") === "1", spawnFn: deps.spawnFn, script: deps.script });
    const series = readSnapshotSeries(snapshotKey(p.name, p.path), deps.healthDir);
    return c.json({ currency, series });
  });

  r.get("/usage", (c) => {
    const name = c.req.query("project") ?? "";
    const all = projects();
    const p = all.find((x) => x.name === name);
    if (!p) return c.json(unknown(name), 404);
    return c.json(readUsage(p.name, p.path, all.map((x) => x.path)));
  });

  r.get("/grounding", async (c) => {
    const name = c.req.query("project") ?? "";
    const p = find(name);
    if (!p) return c.json(unknown(name), 404);
    return c.json(await readGtCheck(resolveDir(p.path, "ref"), { spawnFn: deps.spawnFn, script: deps.gtScript }));
  });

  return r;
}
