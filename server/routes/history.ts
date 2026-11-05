import { Hono } from "hono";
import { knownProjects, type KnownProject } from "../readers/repo";
import { defaultSince, readRefusals, type ReadOptions } from "../readers/refusals";
import { HistoryError, readCompare, readHistory, windowFrom } from "../readers/history";
import type { RefusalsResponse } from "../../shared/refusal-types";
import type { ReplaySessionsResponse } from "../../shared/replay-types";

/**
 * The History screen's reads (#90), mounted at /api/history. Read only.
 *
 *   GET /api/history?project=<name>[&since=<ISO>][&until=<ISO>][&tz=<minutes east of UTC>]
 *       every lane for the window (default: the last 14 days; at most 92 days). The refusals lane
 *       answers "measuring" while anvi's instrument runs (minutes); ask again.
 *   GET /api/history/compare?project=<name>&a=<ISO>&b=<ISO>
 *       code (the default branch at each time: commits between, git diff --shortstat / --numstat)
 *       and knowledge (the catalogue folder at each time: entries added, removed, changed).
 *       Design is measured by the page through GET /api/structure/:project?ref=<sha> at the two
 *       commits this returns, so the guard runs only when asked and its own cache is shared.
 */
export function historyRoutes(deps: {
  projects?: () => KnownProject[];
  refusals?: (project: string, opts: ReadOptions) => Promise<{ response: RefusalsResponse }>;
  sessions?: (project: string) => ReplaySessionsResponse;
  callsDir?: string;
  anviDir?: (p: KnownProject) => string | null | undefined;
} = {}): Hono {
  const projects = deps.projects ?? knownProjects;
  const refusals = deps.refusals ?? readRefusals;
  const r = new Hono();
  r.onError((e, c) => (e instanceof HistoryError ? c.json({ error: e.message }, e.status) : c.json({ error: (e as Error).message }, 500)));

  const find = (name: string): KnownProject => {
    if (!name) throw new HistoryError(400, "project is required (?project=<name>)");
    const p = projects().find((x) => x.name === name);
    if (!p) throw new HistoryError(404, `no project named "${name}" whose folder is known`);
    return p;
  };

  r.get("/", async (c) => {
    const p = find(c.req.query("project") ?? "");
    const w = windowFrom(c.req.query("since"), c.req.query("until"), c.req.query("tz"));
    // Within the refusals reader's default window, ask for that window, so this shares its cached
    // run with every other screen; an older window gets a run of its own from that day (UTC).
    const dflt = defaultSince();
    const since = w.since >= dflt ? null : `${w.since.slice(0, 10)}T00:00:00.000Z`;
    const { response } = await refusals(p.name, { since });
    const out = await readHistory({
      project: p.name,
      path: p.path,
      window: w,
      refusals: response,
      sessions: deps.sessions?.(p.name),
      callsDir: deps.callsDir,
      anviDir: deps.anviDir?.(p),
    });
    return c.json(out);
  });

  r.get("/compare", async (c) => {
    const p = find(c.req.query("project") ?? "");
    const parse = (v: string | undefined, name: string) => {
      const ms = v ? Date.parse(v) : NaN;
      if (!v || !/^\d{4}-\d{2}-\d{2}/.test(v) || Number.isNaN(ms)) throw new HistoryError(400, `${name} must be a time (ISO 8601): ${JSON.stringify(v ?? null)}`);
      return new Date(ms).toISOString();
    };
    let a = parse(c.req.query("a"), "a");
    let b = parse(c.req.query("b"), "b");
    if (a > b) [a, b] = [b, a];
    return c.json(await readCompare(p.name, p.path, a, b, deps.anviDir?.(p)));
  });

  return r;
}
