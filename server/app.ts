import { Hono } from "hono";
import { join } from "node:path";
import api from "./routes/api";
import ws, { broadcast } from "./routes/ws";
import { installGuard } from "./guard";
import { ActionLog, actionRoutes } from "./action-log";
import { DESKTOP_ORIGINS, isFromApp } from "./desktop";
import type { AgentHost } from "./agents/host";

/**
 * The whole app, every route mounted, nothing served or watched yet (#241). server/index.ts
 * serves it; tests build the same app to check every route it really has, so a write route
 * added anywhere is covered without the test being told about it.
 */
export async function buildApp(opts: {
  bind: string;
  desktop: boolean;
  log?: ActionLog;
  /** Tests pass a host with a fake agent runner, so no check can ever start a real agent. */
  makeAgentHost?: () => AgentHost;
}) {
  const app = new Hono();
  const actionLog = opts.log ?? new ActionLog();

  // Only this machine may read AnviDeck, and nothing that reaches it over HTTP can make it act:
  // writes come only through the desktop app's private channel. Every write, accepted or
  // refused, is recorded in the action log (#76, #241). Installed before any route.
  installGuard(app, { bind: opts.bind, log: actionLog, isFromApp, origins: opts.desktop ? DESKTOP_ORIGINS : [] });
  app.route("/api/actions", actionRoutes(actionLog));

  app.route("/api/structure", (await import("./routes/structure")).default);
  app.route("/api/home", (await import("./routes/home")).default);
  app.route("/api", (await import("./routes/work")).workRoutes()); // Work screen (#85)
  app.route("/api", (await import("./routes/work-actions")).workActionRoutes()); // Work screen actions: New issue, Merge (#85)
  app.route("/api/changes", (await import("./routes/changes")).default);
  app.route("/api/notes", (await import("./routes/notes")).notesRoutes()); // Notes screen (#89)
  app.route("/api/design", (await import("./routes/design")).designRoutes()); // Design screen (#87)
  app.route("/api/history", (await import("./routes/history")).historyRoutes()); // History screen (#90)
  app.route("/api", api);
  app.route("/api/replay", (await import("./routes/replay")).default);
  app.route("/api/agents-screen", (await import("./routes/agents-screen")).default);
  app.route("/api", (await import("./routes/refusals")).refusalRoutes()); // refusals and your calls on them (#86)

  // Agent host (#75): the only code that runs agents.
  const { createAgentHost } = await import("./routes/agents");
  const agents = opts.makeAgentHost ? createAgentHost(broadcast, opts.makeAgentHost) : createAgentHost(broadcast);
  app.route("/api/agents", agents.api);
  app.route("/", agents.page);
  // Project · Code (#88): its edits ask the agent host which files a running agent is touching.
  app.route("/api/code", (await import("./routes/code")).codeRoutes({ host: () => agents.host, hostOff: () => "the agent host is off: its registry could not be read (GET /api/agents says why)" }));

  app.route("/", ws);

  // The UI's static files (the browser build; the desktop app carries its own copy).
  const UI_DIR = join(import.meta.dir, "..", "ui");
  const DIST_DIR = join(import.meta.dir, "..", "dist");

  app.get("/styles/:file", async (c) => {
    const content = Bun.file(join(UI_DIR, "styles", c.req.param("file")));
    if (!(await content.exists())) return c.text("Not found", 404);
    return new Response(content, { headers: { "content-type": "text/css" } });
  });

  app.get("/app.js", async (c) => {
    const content = Bun.file(join(DIST_DIR, "app.js"));
    if (!(await content.exists())) return c.text("Not found — run: bun run build", 404);
    return new Response(content, { headers: { "content-type": "application/javascript" } });
  });

  // SPA: serve index.html for all non-API, non-static routes
  app.get("/*", async (c) => {
    if (c.req.path.startsWith("/api")) return c.text("Not found", 404);
    return new Response(Bun.file(join(UI_DIR, "index.html")), { headers: { "content-type": "text/html" } });
  });

  return { app, agents, actionLog };
}
