import { Hono } from "hono";
import { readHome } from "../readers/home";
import { READY_MAX, readReady } from "../readers/pr-ready";
import { parsePrKey } from "../../shared/pr-ready";

// Mounted at /api/home. GET / → the decision queue, the four status metrics and the agents (#18).
// Read only. Every row and metric carries its source; "could not read" is reported, not hidden.
const home = new Hono();

home.get("/", async (c) => c.json(await readHome()));

// GET /ready?pr=owner/name%23N&pr=… → for each PR, ready to merge or why not (#81).
// Read only: one `gh pr view` per PR (cached). A PR GitHub could not answer for is
// `could-not-read`, never "not ready".
home.get("/ready", async (c) => {
  const keys = [...new Set(c.req.queries("pr") ?? [])];
  if (keys.length === 0) return c.json({ error: "name at least one PR: ?pr=owner/name%23N" }, 400);
  if (keys.length > READY_MAX) return c.json({ error: `at most ${READY_MAX} PRs per request, got ${keys.length}` }, 400);
  const bad = keys.filter((k) => !parsePrKey(k));
  if (bad.length) return c.json({ error: `not a PR key (owner/name#N): ${bad.slice(0, 3).join(", ")}` }, 400);
  return c.json({ answers: await readReady(keys) });
});

export default home;
