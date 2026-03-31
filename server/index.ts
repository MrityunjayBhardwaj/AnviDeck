import { Hono } from "hono";
import { cors } from "hono/cors";
import api from "./routes/api";
import { watchGlobal } from "./watchers/file-watcher";

const app = new Hono();

// CORS for local development
app.use("/*", cors());

// Mount API routes
app.route("/api", api);

// Health check
app.get("/", (c) => {
  return c.json({
    name: "AnviDeck",
    version: "0.1.0",
    status: "running",
    endpoints: [
      "GET /api/projects",
      "GET /api/project/:name",
      "GET /api/project/:name/catalogues",
      "GET /api/project/:name/memory",
      "GET /api/memory",
      "GET /api/timeline",
      "GET /api/state-at/:hash?file=path",
      "GET /api/diff/:from/:to",
    ],
  });
});

// Start global file watcher
const stopWatching = watchGlobal((event) => {
  console.log(`[watch] ${event.type}: ${event.path}`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  stopWatching();
  process.exit(0);
});

const port = parseInt(process.env.PORT ?? "3000", 10);
console.log(`AnviDeck server running at http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
