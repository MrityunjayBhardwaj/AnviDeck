import { Hono } from "hono";
import { cors } from "hono/cors";
import { websocket } from "hono/bun";
import { join } from "node:path";
import api from "./routes/api";
import ws, { broadcast } from "./routes/ws";
import { watchGlobal } from "./watchers/file-watcher";
import { watchHookLogs } from "./watchers/hook-logger";

const app = new Hono();

// CORS for local development
app.use("/*", cors());

// Mount API routes
app.route("/api/structure", (await import("./routes/structure")).default);
app.route("/api/home", (await import("./routes/home")).default);
app.route("/api", api);
app.route("/api/replay", (await import("./routes/replay")).default);

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
  const content = Bun.file(path);
  return new Response(content, {
    headers: { "content-type": "text/html" },
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
  process.exit(0);
});

const port = parseInt(process.env.PORT ?? "4000", 10);
console.log(`AnviDeck server running at http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
  websocket,
};
