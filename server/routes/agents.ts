import { Hono } from "hono";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { AgentHost, HostError, type HostEvent, type QueryFn } from "../agents/host";
import { loginOnlyEnv, readLogin, resolveClaude, type LoginStatus } from "../agents/login";
import { sameOriginWrites } from "../guard";
import { replayFromEnv } from "../agents/replay";
import { FromIssue } from "../agents/from-issue";
import { PushPr } from "../agents/push-pr";
import { AgentTurns } from "../agents/turns";
import { CheckpointStore } from "../agents/checkpoints";
import { AgentRegistry } from "../agents/registry";
import { modesOffered } from "../../shared/agent-modes";
import { writeGithubAccess } from "../agents/github-access";
import { GITHUB_ACCESS, githubAccessInfo, isGithubAccess, unavailable } from "../../shared/github-access";

// The write guard (writes only from the desktop app's channel, #241) and the action log are installed
// on the whole app (installGuard in server/guard.ts), so every /api write route is covered.
// This router keeps the origin check so it is never open when mounted on its own.
export { sameOriginWrites };

/** The /api/agents routes over one host. Exported as a factory so tests drive a fake query(). */
export function agentRoutes(
  host: AgentHost,
  login: () => Promise<LoginStatus>,
  fromIssue: FromIssue = new FromIssue(host),
  pushPr: PushPr = new PushPr(host),
  turns: AgentTurns = new AgentTurns(host),
): Hono {
  const r = new Hono();
  r.use("/*", sameOriginWrites);

  r.onError((e, c) => {
    if (e instanceof HostError) return c.json({ ...e.detail, error: e.message }, e.status);
    console.error("[agents]", e);
    return c.json({ error: (e as Error).message }, 500);
  });

  r.get("/", async (c) => {
    const claude = resolveClaude();
    const snap = host.snapshot();
    return c.json({
      claude,
      login: await login(),
      cap: host.cap,
      // The permission modes a start may ask for on this machine, each saying if the cap allows it (#249).
      modes: { cap: host.modeCap.cap, from: host.modeCap.from, ...(host.modeCap.invalid ? { invalid: host.modeCap.invalid } : {}), offered: modesOffered(host.modeCap) },
      // Agent GitHub access (#147): the setting, and each choice with why it cannot be picked yet.
      githubAccess: { setting: host.githubAccess(), options: GITHUB_ACCESS.map((g) => ({ ...g, unavailable: unavailable(g.access) })) },
      running: host.running,
      registry: host.registry.dir,
      // This server, as its agents name it; an agent with runsElsewhere is another server's (#104).
      server: { pid: host.owner.pid, port: host.owner.port },
      ...(snap.unread ? { registryUnread: snap.unread } : {}),
      agents: snap.agents,
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

  // Change Agent GitHub access (#147): { access }. Applies from the next start or resume; agents
  // already running keep the environment they started with. A write: only from the desktop app.
  r.post("/settings/github-access", async (c) => {
    const b = await body(c);
    if (!isGithubAccess(b.access)) throw new HostError(400, "access must be one of your-login, none, bot");
    const why = unavailable(b.access);
    if (why) throw new HostError(409, `${githubAccessInfo(b.access).label} is ${why}`);
    try {
      writeGithubAccess(host.registry.dir, b.access);
    } catch (e) {
      throw new HostError(503, (e as Error).message);
    }
    return c.json({ setting: host.githubAccess(), running: host.running });
  });

  r.post("/", async (c) => {
    const b = await body(c);
    return c.json(host.start({ cwd: b.cwd, prompt: b.prompt, issue: b.issue, mode: b.mode, confirm: b.confirm, githubAccess: b.githubAccess }), 201);
  });
  // Start an agent from an issue, in its own worktree (#78). The GET says what it would do, or
  // why it would refuse, without making anything; the POST does it.
  r.get("/from-issue/plan", async (c) => c.json(await fromIssue.plan(c.req.query())));
  // Push and open the PR for an agent (#268): what pressing would do (a read), then the write,
  // which pushes only the branch and commit the card showed.
  r.get("/:id/push-pr", async (c) => c.json(await pushPr.plan(c.req.param("id"))));
  r.post("/:id/push-pr", async (c) => c.json(await pushPr.push(c.req.param("id"), await body(c)), 201));
  r.post("/from-issue", async (c) => c.json(await fromIssue.start(await body(c)), 201));
  r.post("/:id/stop", (c) => c.json(host.stop(c.req.param("id"))));
  r.post("/:id/resume", async (c) => {
    const b = await body(c);
    return c.json(host.resume(c.req.param("id"), b.prompt));
  });
  // Talk to a running agent (#79): { text } or { comment: { file, line, lineText, text } }.
  // 202: queued, its delivery follows in the transcript. 409 { resumable }: not running.
  r.post("/:id/message", async (c) => {
    const b = await body(c);
    return c.json(host.message(c.req.param("id"), b), 202);
  });
  // Answer a parked permission request (#77): { decision: "allow" } or { decision: "deny", message? }.
  // 200 with the agent; 409 when the request is no longer waiting (answered, or withdrawn).
  r.post("/:id/permissions/:requestId", async (c) => {
    const b = await body(c);
    return c.json(host.answer(c.req.param("id"), c.req.param("requestId"), b));
  });
  // Checkpoints per turn (#248): what each turn changed; Undo's preview (GET) and press (POST,
  // { current }); Clear. The GETs write nothing to the agent's folder or the record.
  r.get("/:id/checkpoints", (c) => c.json(turns.list(c.req.param("id"))));
  r.get("/:id/checkpoints/:n/undo", async (c) => c.json(await turns.plan(c.req.param("id"), c.req.param("n"))));
  r.post("/:id/checkpoints/:n/undo", async (c) => c.json(await turns.undo(c.req.param("id"), c.req.param("n"), await body(c))));
  r.post("/:id/checkpoints/clear", async (c) => c.json(await turns.clear(c.req.param("id"))));

  return r;
}

/** The single host this server runs, its routes, and a minimal page to watch it (until #82). */
export function createAgentHost(
  broadcast: (msg: string) => void,
  makeHost: () => AgentHost = () => {
    // The desktop checks (#242) play recorded runs instead of Claude Code; said loudly.
    const replay = replayFromEnv();
    if (replay) console.error(`[agents] REPLAY MODE: agents play recordings (${replay.names.join(", ")}), not Claude Code`);
    const registry = new AgentRegistry();
    return new AgentHost({
      registry,
      query: replay?.query ?? (query as unknown as QueryFn),
      emit: (e: HostEvent) => broadcast(JSON.stringify(e)),
      // Checkpoints per turn (#248), in AnviDeck's own folder beside the registry.
      checkpoints: new CheckpointStore(registry.dir),
    });
  },
) {
  let host: AgentHost;
  try {
    host = makeHost();
  } catch (e) {
    // A registry that cannot be read turns the agent host off, not the whole server: every
    // other screen stays up. Nothing is written, so the damaged file is left as it was.
    const reason = `the agent host is off: its registry could not be read (${(e as Error).message}). AnviDeck has not changed it; fix or move the file and restart.`;
    console.error("[agents]", reason);
    const api = new Hono();
    api.all("/*", (c) => c.json({ error: reason }, 503));
    // The page router is mounted at "/": answer only the agent-host paths, never the rest.
    const page = new Hono();
    page.get("/agent-host", (c) => c.text(reason, 503));
    page.get("/agent-host.js", (c) => c.text(reason, 503));
    return { host: null, api, page, stopAll: (_why: string) => {}, listeningOn: (_port: number) => {} };
  }
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
  // It carries no token (#241): writes come only through the desktop app's channel.
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

  return { host, api: agentRoutes(host, login), page, stopAll: (why: string) => host.stopAll(why), listeningOn: (port: number) => host.listeningOn(port) };
}
