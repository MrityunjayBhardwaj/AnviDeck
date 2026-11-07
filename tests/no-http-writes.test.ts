import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionLog } from "../server/action-log";
import { HTTP_WRITE_REFUSAL } from "../server/guard";
import { AgentHost, type QueryFn } from "../server/agents/host";
import { AgentRegistry } from "../server/agents/registry";
import { loginOnlyEnv } from "../server/agents/login";

/**
 * #241: nothing served over HTTP can make AnviDeck act. This builds the real app, with every
 * route the server mounts, serves it on a real port, and sends every non-GET route it has over
 * HTTP. A write route added anywhere later is in app.routes, so it is checked without this test
 * being told about it. Writes run only through the desktop app's channel (server/desktop.ts).
 */

const dir = mkdtempSync(join(tmpdir(), "no-http-writes-"));
const prevAgentDir = process.env.ANVIDECK_AGENT_DIR;
let server: ReturnType<typeof Bun.serve>;
let writeRoutes: { method: string; path: string }[] = [];

beforeAll(async () => {
  // The agent registry, action log and calls are AnviDeck's own files: keep them in a scratch folder.
  process.env.ANVIDECK_AGENT_DIR = dir;
  const { buildApp } = await import("../server/app");
  // A fake agent runner: if a write ever got through, it must not start a real Claude Code agent.
  const neverRun: QueryFn = () => { throw new Error("a write reached the agent runner over HTTP"); };
  const makeAgentHost = () => new AgentHost({
    registry: new AgentRegistry(dir),
    query: neverRun,
    resolveClaude: () => ({ path: "/fake/claude", realPath: "/fake/claude-2", fileId: "1:1:1" }),
    env: () => loginOnlyEnv({ PATH: "/usr/bin" }),
    emit: () => {},
  });
  const { app } = await buildApp({ bind: "127.0.0.1", desktop: false, log: new ActionLog(dir), makeAgentHost });
  const seen = new Set<string>();
  for (const r of app.routes) {
    const key = `${r.method} ${r.path}`;
    if (["GET", "HEAD", "ALL"].includes(r.method) || seen.has(key)) continue;
    seen.add(key);
    writeRoutes.push({ method: r.method, path: r.path });
  }
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
});

afterAll(() => {
  server?.stop(true);
  if (prevAgentDir === undefined) delete process.env.ANVIDECK_AGENT_DIR;
  else process.env.ANVIDECK_AGENT_DIR = prevAgentDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("no write is served over HTTP (#241)", () => {
  test("the app has write routes to check (else this test would pass on nothing)", () => {
    // Today: agents (start, stop, resume, permissions, messages), Work (issue, merge), calls, Code's edit.
    expect(writeRoutes.length).toBeGreaterThanOrEqual(8);
    expect(writeRoutes.map((r) => `${r.method} ${r.path}`)).toContain("POST /api/prs/:n/merge");
    expect(writeRoutes.map((r) => `${r.method} ${r.path}`)).toContain("POST /api/code/:project/edit");
  });

  test("every non-GET route the app has is refused over a real port, from its own Origin too", async () => {
    const origin = `http://127.0.0.1:${server.port}`;
    const answers: string[] = [];
    for (const r of writeRoutes) {
      const path = r.path.replace(/:[A-Za-z]+/g, "x1").replace(/\*$/, "x1");
      const res = await fetch(`${origin}${path}`, {
        method: r.method,
        headers: { origin, "content-type": "application/json", "x-anvideck-token": "anything" },
        body: JSON.stringify({ cwd: dir, prompt: "x", decision: "allow", head: "abc", title: "t" }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      answers.push(`${r.method} ${r.path} → ${res.status}${body.error === HTTP_WRITE_REFUSAL ? "" : ` (${body.error})`}`);
    }
    expect(answers).toEqual(writeRoutes.map((r) => `${r.method} ${r.path} → 403`));
  });

  test("any other method on any path is refused too", async () => {
    const origin = `http://127.0.0.1:${server.port}`;
    for (const [method, path] of [["POST", "/"], ["PUT", "/agent-host"], ["DELETE", "/api/actions"], ["OPTIONS", "/api/agents"], ["PATCH", "/api/nothing-here"]]) {
      expect(`${method} ${path} ${(await fetch(`${origin}${path}`, { method })).status}`).toBe(`${method} ${path} 403`);
    }
  });

  test("the server serves exactly this app: index.ts builds it with buildApp and hands its fetch to Bun", () => {
    const src = readFileSync(join(import.meta.dir, "..", "server", "index.ts"), "utf8");
    expect(src).toContain("await buildApp(");
    expect(src).toContain("fetch: app.fetch");
    expect(src).not.toContain("new Hono(");
  });
});
