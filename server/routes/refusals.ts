import { Hono } from "hono";
import type { Context } from "hono";
import { sameOriginWrites } from "../guard";
import { measuredAll, readRefusals, RefusalsError, type ReadOptions } from "../readers/refusals";
import { readCalls } from "../readers/calls";
import { CallError, CallStore, callFrom } from "../calls";
import { checkKey, knownFromRegistry, locateProject, type Known } from "../call-project";
import type { RefusalsMeasured } from "../../shared/refusal-types";

/**
 * Refusals by the design guard and your calls on them (#86), mounted at /api:
 *
 *   GET  /api/refusals?project=<name>[&since=<ISO>][&until=<ISO>][&package=<dir>][&path=<dir>][&refresh=1]
 *        what anvi's structure-refusals.js counted for the project's registered package, with
 *        your call on each refusal. The first request starts the run and answers "measuring";
 *        ask again. Answers are cached (their age is in `cache`).
 *   GET  /api/calls[?project=<name>][&key=<refusal key>]
 *        your calls, read from calls.jsonl (latest per refusal, earlier ones kept).
 *   POST /api/refusals/:key/call   { project? , cwd?, call: "right" | "wrong", note?, refusal?: { …, path? } }
 *        records your call. Without `project`, it is the project of the measured answer listing the
 *        key, else of the registered package holding `refusal.path`, else of the agent's folder `cwd`
 *        (#179; server/call-project.ts). A key that a measured answer of the edited file's package
 *        should list and does not is refused (400); with no answer to check it against, the call is
 *        recorded marked `unverified` (#178). A write: the guard installed on the whole app admits it
 *        only from AnviDeck's own pages with this server's token, and the action log records it either way.
 */
export function refusalRoutes(deps: {
  store?: CallStore;
  read?: Partial<ReadOptions>;
  /** Every measured answer held, of any project (default: the refusals reader's cache). */
  measured?: () => RefusalsMeasured[];
  /** The registry's packages and known projects (default: read from the structure registry). */
  known?: Known;
} = {}): Hono {
  const store = deps.store ?? new CallStore();
  const r = new Hono();
  r.onError((e, c) => {
    if (e instanceof CallError || e instanceof RefusalsError) return c.json({ error: e.message }, e.status);
    return c.json({ error: (e as Error).message }, 500);
  });

  r.get("/refusals", async (c) => {
    const project = c.req.query("project");
    if (!project) return c.json({ error: "project is required (?project=<name>)" }, 400);
    const { response, notFound } = await readRefusals(project, {
      ...deps.read,
      since: c.req.query("since") ?? null,
      until: c.req.query("until") ?? null,
      package: c.req.query("package") ?? null,
      path: c.req.query("path") ?? null,
      refresh: c.req.query("refresh") === "1",
      callsDir: deps.read?.callsDir ?? store.dir,
    });
    // 200 for every answer the reader could give (the status field says which); 404 for a project nobody knows.
    return c.json(response, notFound ? 404 : 200);
  });

  r.get("/calls", (c) => c.json(readCalls({ dir: store.dir, project: c.req.query("project") ?? null, key: c.req.query("key") ?? null })));

  r.post("/refusals/:key/call", sameOriginWrites, async (c: Context) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new CallError(400, "body must be JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new CallError(400, "body must be a JSON object");
    // Every project's answers: a tool_use id names one blocked edit, so the answer listing it settles
    // both the project (when the page names none) and the check, whichever project the agent ran in.
    const answers = (deps.measured ?? measuredAll)();
    const known = deps.known ?? knownFromRegistry();
    const rec = callFrom(c.req.param("key") ?? "", body as Record<string, unknown>, undefined, (ctx) => locateProject(ctx, answers, known));
    // The key must name a refusal the instrument counted (#178): refused when a measured answer of the
    // edited file's package that could have seen it does not list it; recorded but marked unverified
    // when none could.
    const check = checkKey(rec.key, rec.refusal, answers);
    if (check.state === "not-listed") throw new CallError(400, `not recorded: ${check.reason}`);
    if (check.state === "unverified") rec.unverified = check.reason;
    store.append(rec);
    return c.json({ recorded: rec, file: store.file }, 201);
  });

  return r;
}
