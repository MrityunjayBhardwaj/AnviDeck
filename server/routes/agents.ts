import { Hono, type MiddlewareHandler } from "hono";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { AgentHost, HostError, type HostEvent, type QueryFn } from "../agents/host";
import { loginOnlyEnv, readLogin, resolveClaude, type LoginStatus } from "../agents/login";

/**
 * Write requests must come from one of AnviDeck's own pages: the Origin header must be present
 * and name this server. localOnly already refuses a foreign Origin; this also refuses a write
 * that carries none (a bare curl, or a client that strips it), so starting an agent always
 * means a page on this server asked. The per-session token and the action log are #76.
 */
export const sameOriginWrites: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") return next();
  const origin = c.req.header("origin");
  const host = c.req.header("host") ?? "";
  let ok = false;
  try {
    ok = origin !== undefined && new URL(origin).host === host;
  } catch {
    ok = false;
  }
  if (!ok) return c.json({ error: `agent actions are taken only from AnviDeck's own pages (Origin ${origin === undefined ? "missing" : `"${origin}"`} refused)` }, 403);
  return next();
};

/** The /api/agents routes over one host. Exported as a factory so tests drive a fake query(). */
export function agentRoutes(host: AgentHost, login: () => Promise<LoginStatus>): Hono {
  const r = new Hono();
  r.use("/*", sameOriginWrites);

  r.onError((e, c) => {
    if (e instanceof HostError) return c.json({ error: e.message }, e.status);
    console.error("[agents]", e);
    return c.json({ error: (e as Error).message }, 500);
  });

  r.get("/", async (c) => {
    const claude = resolveClaude();
    return c.json({
      claude,
      login: await login(),
      cap: host.cap,
      running: host.running,
      registry: host.registry.dir,
      agents: host.list(),
    });
  });

  r.get("/:id", (c) => {
    const id = c.req.param("id");
    const agent = host.get(id);
    const { lines, unreadable } = host.transcript(id);
    return c.json({ agent, transcript: lines, unreadableLines: unreadable });
  });

  const body = async (c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> => {
    try {
      const b = await c.req.json();
      return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
    } catch {
      throw new HostError(400, "body must be JSON");
    }
  };

  r.post("/", async (c) => {
    const b = await body(c);
    return c.json(host.start({ cwd: b.cwd, prompt: b.prompt, issue: b.issue }), 201);
  });
  r.post("/:id/stop", (c) => c.json(host.stop(c.req.param("id"))));
  r.post("/:id/resume", async (c) => {
    const b = await body(c);
    return c.json(host.resume(c.req.param("id"), b.prompt));
  });

  return r;
}

/** The single host this server runs, its routes, and a minimal page to watch it (until #82). */
export function createAgentHost(broadcast: (msg: string) => void) {
  const host = new AgentHost({
    query: query as unknown as QueryFn,
    emit: (e: HostEvent) => broadcast(JSON.stringify(e)),
  });
  // `claude auth status` takes ~1s; read it once a minute at most.
  let cached: { at: number; value: Promise<LoginStatus> } | null = null;
  const login = () => {
    if (!cached || Date.now() - cached.at > 60_000) {
      cached = { at: Date.now(), value: readLogin(resolveClaude(), loginOnlyEnv().env) };
    }
    return cached.value;
  };

  const page = new Hono();
  // Temporary page for #75 only; the Agents screen (#82) replaces it.
  page.get("/agent-host", (c) =>
    c.html(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>AnviDeck: agent host</title>
<link rel="stylesheet" href="/styles/deck.css"></head><body><div id="agent-host"></div>
<script type="module" src="/agent-host.js"></script></body></html>`),
  );
  page.get("/agent-host.js", async () => {
    const f = Bun.file(join(import.meta.dir, "..", "..", "dist", "agent-host.js"));
    if (!(await f.exists())) return new Response("Not found — run: bun run build", { status: 404 });
    return new Response(f, { headers: { "content-type": "application/javascript" } });
  });

  return { host, api: agentRoutes(host, login), page };
}
