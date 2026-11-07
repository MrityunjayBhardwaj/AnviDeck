import { watchGlobal } from "./watchers/file-watcher";
import { watchHookLogs } from "./watchers/hook-logger";
import { broadcast } from "./routes/ws";
import { websocket } from "hono/bun";
import { bindHost, isLoopback } from "./access";
import { DESKTOP, emit, serveWritePipe } from "./desktop";
import { buildApp } from "./app";

const hostname = bindHost();
// Every route, behind the guard: reads on loopback, writes only through the desktop app (#241).
const { app, agents } = await buildApp({ bind: hostname, desktop: DESKTOP });

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

const port = parseInt(process.env.PORT ?? (DESKTOP ? "0" : "4000"), 10);
const shown = hostname.includes(":") ? `[${hostname}]` : hostname;
if (!DESKTOP) console.log(isLoopback(hostname)
  ? `AnviDeck server running at http://${shown}:${port} (this machine only; set HOST to listen elsewhere). Read-only: actions are taken only in the desktop app (bun run desktop:dev).`
  : `AnviDeck server running at http://${shown}:${port} (HOST=${hostname}: other machines on the network can reach it). Read-only: actions are taken only in the desktop app.`);

const serveOptions = {
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

if (DESKTOP) {
  // Desktop app (#239): started by the app as a sidecar. Pick a free port, tell the app which,
  // and take writes only from the app's pipe on stdin. When the app closes stdin, stop.
  const server = Bun.serve(serveOptions);
  const bound = server.port ?? 0;
  agents.listeningOn(bound);
  emit("READY", { port: bound });
  void serveWritePipe(app, {
    port: bound,
    onClose: () => {
      stopWatching();
      stopHookLogs();
      agents.stopAll("AnviDeck app closed");
      process.exit(0);
    },
  });
}

// In the browser build Bun serves the default export; the port it binds is the one asked for.
if (!DESKTOP) agents.listeningOn(port);

export default DESKTOP ? undefined : serveOptions;
