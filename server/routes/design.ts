import { Hono } from "hono";
import { readEditHooks, readFixCost, type FixCostOptions } from "../readers/design";

/**
 * The Design screen's own reads (#87), mounted at /api/design. Read only. "Ask before writing"
 * starts an agent through POST /api/agents (the agent host), never through here.
 *
 *   GET /api/design/cost?project=   files touched per fix, per component pair the guard holds
 *                                    rule breaks for, from git history at the measured commit
 *   GET /api/design/hooks           the PreToolUse hooks an edit passes through, from ~/.claude/settings.json
 */
export function designRoutes(deps: { cost?: FixCostOptions; settings?: string } = {}): Hono {
  const r = new Hono();
  r.get("/cost", async (c) => {
    const project = c.req.query("project");
    if (!project) return c.json({ error: "project is required (?project=<name>)" }, 400);
    return c.json(await readFixCost(project, deps.cost));
  });
  r.get("/hooks", (c) => c.json(readEditHooks(deps.settings)));
  return r;
}
