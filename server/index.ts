import { Hono } from "hono";
import { websocket } from "hono/bun";
import { join } from "node:path";
import api from "./routes/api";
import ws, { broadcast } from "./routes/ws";
import { watchGlobal } from "./watchers/file-watcher";
import { watchHookLogs } from "./watchers/hook-logger";
import { bindHost, isLoopback } from "./access";
import { installGuard, serverWriteToken, withWriteToken } from "./guard";
import { ActionLog, actionRoutes } from "./action-log";

const app = new Hono();

// Only this machine's own browser may read AnviDeck: no other host, no other web page.
// A write also needs this server's token (placed in the pages it serves), and every write,
// accepted or refused, is recorded in the action log (#76). Installed before any route.
const hostname = bindHost();
const actionLog = new ActionLog();
installGuard(app, { bind: hostname, token: serverWriteToken(), log: actionLog });
app.route("/api/actions", actionRoutes(actionLog));

// Mount API routes
app.route("/api/structure", (await import("./routes/structure")).default);
app.route("/api/home", (await import("./routes/home")).default);
app.route("/api", api);
app.route("/api/replay", (await import("./routes/replay")).default);
app.route("/api/agents-screen", (await import("./routes/agents-screen")).default);

// Agent host (#75): the only code that runs agents.
const agents = (await import("./routes/agents")).createAgentHost(broadcast);
app.route("/api/agents", agents.api);
app.route("/", agents.page);

// Mount WebSocket route
app.route("/", ws);

// Serve UI static files
const UI_DIR = join(import.meta.dir, "..", "ui");
const DIST_DIR = join(import.meta.dir, "..", "dist");

app.get("/styles/:file", async (c) => {
  const file = c.req.param("file");
  const path = join(UI_DIR, "styles", file);
  const content = Bun.file(path);
  if (!(await content.exists())) return c.text("Not found", 404);
  return new Response(content, {
    headers: { "content-type": "text/css" },
  });
});

app.get("/app.js", async (c) => {
  const path = join(DIST_DIR, "app.js");
  const content = Bun.file(path);
  if (!(await content.exists())) return c.text("Not found — run: bun run build", 404);
  return new Response(content, {
    headers: { "content-type": "application/javascript" },
  });
});

// SPA: serve index.html for all non-API, non-static routes
app.get("/*", async (c) => {
  if (c.req.path.startsWith("/api")) return c.text("Not found", 404);
  const path = join(UI_DIR, "index.html");
  const html = withWriteToken(await Bun.file(path).text());
  // The token changes at every server start: a cached page would carry a stale one.
  return new Response(html, {
    headers: { "content-type": "text/html", "cache-control": "no-store" },
  });
});

// Start global file watcher
const stopWatching = watchGlobal((event) => {
  console.log(`[watch] ${event.type}: ${event.path}`);
});

// Start hook log watcher → broadcast to WebSocket clients
const stopHookLogs = watchHookLogs((type, entry) => {
  const msg = JSON.stringify({ type, data: entry });
  broadcast(msg);
  console.log(`[hook-log] ${type}: ${JSON.stringify(entry).slice(0, 100)}`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  stopWatching();
  stopHookLogs();
  agents.stopAll("AnviDeck shut down");
  process.exit(0);
});

const port = parseInt(process.env.PORT ?? "4000", 10);
const shown = hostname.includes(":") ? `[${hostname}]` : hostname;
console.log(isLoopback(hostname)
  ? `AnviDeck server running at http://${shown}:${port} (this machine only; set HOST to listen elsewhere)`
  : `AnviDeck server running at http://${shown}:${port} (HOST=${hostname}: other machines on the network can reach it)`);

export default {
  port,
  hostname,
  // Bun.serve closes a request that sends nothing for 10 s by default, and the
  // browser then gets an empty body, not an error it can show (#34). Some reads
  // (the GitHub trace, git history on a busy machine) take longer than that.
  // 255 s is the most Bun allows.
  idleTimeout: 255,
  fetch: app.fetch,
  websocket,
};
