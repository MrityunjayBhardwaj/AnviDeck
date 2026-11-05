import { Hono } from "hono";
import { readEditHooks, readFixCost, settingsFiles, type FixCostOptions, type SettingsFileRef } from "../readers/design";
import { discoverProjects } from "../readers/projects";

/**
 * The Design screen's own reads (#87), mounted at /api/design. Read only. "Ask before writing"
 * starts an agent through POST /api/agents (the agent host), never through here.
 *
 *   GET /api/design/cost?project=   files touched per fix, per component pair the guard holds
 *                                    rule breaks for, from git history at the measured commit
 *   GET /api/design/hooks?project=  the PreToolUse hooks registered for an edit, from your
 *                                    settings, the project's two settings files and the managed
 *                                    settings; what is not read is named in the answer
 */
export function designRoutes(deps: { cost?: FixCostOptions; hookFiles?: (project: string | null) => SettingsFileRef[] } = {}): Hono {
  const r = new Hono();
  r.get("/cost", async (c) => {
    const project = c.req.query("project");
    if (!project) return c.json({ error: "project is required (?project=<name>)" }, 400);
    return c.json(await readFixCost(project, deps.cost));
  });
  r.get("/hooks", (c) => {
    const project = c.req.query("project") ?? null;
    return c.json(readEditHooks((deps.hookFiles ?? projectSettingsFiles)(project)));
  });
  return r;
}

/** The settings files for a project by name; a project whose folder is not known says why. */
function projectSettingsFiles(project: string | null): SettingsFileRef[] {
  if (!project) return settingsFiles(null, "no project was named (?project=<name>)");
  const d = discoverProjects();
  if (d.status === "unreadable") return settingsFiles(null, `the projects directory could not be read: ${d.error}`);
  const p = d.projects.find((x) => x.name === project && x.decoded) ?? d.projects.find((x) => x.name === project);
  if (!p) return settingsFiles(null, `no project named ${project}`);
  if (!p.decoded) return settingsFiles(null, `the folder of project ${project} could not be determined`);
  return settingsFiles(p.decoded);
}
