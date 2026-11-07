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
type ReadRefusals = (project: string, opts: ReadOptions) => Promise<{ response: RefusalsResponse }>;

/** The first day of the UTC month `iso` falls in: the start of a wide run, so stepping back a day at a time reuses it. */
export const monthStart = (iso: string) => `${iso.slice(0, 7)}-01T00:00:00.000Z`;

/**
 * Refusals for a window, without letting History start a pile of instrument runs (each reads every
 * transcript on the machine for minutes). A window inside the refusals reader's default (the last
 * 30 days) asks for that default, so it shares the run every other screen uses. An older window is
 * served by one wide run per project, from the first of the oldest month any window asked for; a
 * narrower window reads the same run and keeps only its own days. Only one wide run goes at a time
 * across the server: a window that needs another while one is going is told it is waiting, and the
 * page asks again (it polls while the lane is measuring).
 */
export function wideRefusals(refusals: ReadRefusals, now: () => Date = () => new Date()) {
  const widest = new Map<string, string>();
  let running: { project: string; since: string; started: string } | null = null;
  return async (project: string, windowSince: string): Promise<{ response: RefusalsResponse; waiting?: string }> => {
    if (windowSince >= defaultSince(now())) return refusals(project, { since: null });
    const want = monthStart(windowSince);
    const have = widest.get(project);
    const since = have && have <= want ? have : want;
    if (running && (running.project !== project || running.since !== since)) {
      const { response } = await refusals(project, { since: null });
      return {
        response,
        waiting: `waiting: anvi's instrument is already reading every transcript for ${running.project} from ${running.since} (since ${running.started}); this window's run (from ${since}) starts when that one ends, one at a time`,
      };
    }
    if (!running) {
      widest.set(project, since);
      const slot = { project, since, started: now().toISOString() };
      running = slot;
      // Resolves at once when the reader has a fresh answer; else when its run ends. The reader
      // shares one run per window, so this and the read below never start two.
      refusals(project, { since, wait: true })
        .catch(() => undefined)
        .finally(() => {
          if (running === slot) running = null;
        });
    }
    return refusals(project, { since });
  };
}

export function historyRoutes(deps: {
  projects?: () => KnownProject[];
  refusals?: ReadRefusals;
  sessions?: (project: string) => ReplaySessionsResponse;
  callsDir?: string;
  anviDir?: (p: KnownProject) => string | null | undefined;
  now?: () => Date;
} = {}): Hono {
  const projects = deps.projects ?? knownProjects;
  const refusalsFor = wideRefusals(deps.refusals ?? readRefusals, deps.now);
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
    const { response, waiting } = await refusalsFor(p.name, w.since);
    const out = await readHistory({
      project: p.name,
      path: p.path,
      window: w,
      refusals: response,
      ...(waiting ? { refusalsWaiting: waiting } : {}),
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
