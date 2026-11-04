import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentHost, type QueryFn } from "../server/agents/host";
import { AgentRegistry } from "../server/agents/registry";
import { loginOnlyEnv } from "../server/agents/login";
import { agentRoutes, createAgentHost } from "../server/routes/agents";
import { installGuard, previewBody, serverWriteToken, tokenMatches, withWriteToken, TOKEN_HEADER, TOKEN_META } from "../server/guard";
import { ActionLog, actionRoutes, type ActionRecord } from "../server/action-log";

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "write-guard-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const TOKEN = "test-token-0123456789abcdef";
const HOST = "localhost:4475";
const ORIGIN = `http://${HOST}`;

/** The whole server's guard over the real agent routes, plus a router "added later" with a write of its own. */
function server() {
  const logDir = scratch();
  const log = new ActionLog(logDir);
  const fakeQuery: QueryFn = () =>
    (async function* () {
      yield { type: "system", subtype: "init", apiKeySource: "none", session_id: "s1", claude_code_version: "2", model: "m", cwd: "/x", tools: [], mcp_servers: [], permissionMode: "default", slash_commands: [], output_style: "default", uuid: "u" } as unknown as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, num_turns: 1, duration_ms: 1, duration_api_ms: 1, stop_reason: null, usage: {}, modelUsage: {}, session_id: "s1", uuid: "u3" } as unknown as SDKMessage;
    })() as unknown as ReturnType<QueryFn>;
  const host = new AgentHost({
    registry: new AgentRegistry(scratch()),
    query: fakeQuery,
    resolveClaude: () => ({ path: "/fake/claude", realPath: "/fake/claude-2", fileId: "1:1:1" }),
    env: () => loginOnlyEnv({ PATH: "/usr/bin" }),
    emit: () => {},
  });
  const app = new Hono();
  installGuard(app, { bind: "127.0.0.1", token: TOKEN, log });
  app.route("/api/actions", actionRoutes(log));
  app.route("/api/agents", agentRoutes(host, async () => ({ ok: true })));
  // A write route nobody guarded by hand: it must still be guarded and logged.
  const later = new Hono();
  later.post("/:id/merge", (c) => c.json({ merged: c.req.param("id") }));
  app.route("/api/later", later);
  const send = (path: string, headers: Record<string, string>, body?: unknown, method = "POST") =>
    app.request(`http://${HOST}${path}`, {
      method,
      headers: { host: HOST, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const lines = (): ActionRecord[] => {
    try {
      return readFileSync(log.file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return { app, host, log, send, lines };
}

describe("write guard", () => {
  test("a write without the token, with a wrong token, or without Origin is refused with a reason; nothing starts", async () => {
    const s = server();
    const cwd = scratch();
    const noToken = await s.send("/api/agents", { origin: ORIGIN }, { cwd, prompt: "x" });
    expect(noToken.status).toBe(403);
    expect((await noToken.json()).error).toContain("no AnviDeck token");
    const wrong = await s.send("/api/agents", { origin: ORIGIN, [TOKEN_HEADER]: "nope" }, { cwd, prompt: "x" });
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).error).toContain("not this server's");
    const noOrigin = await s.send("/api/agents", { [TOKEN_HEADER]: TOKEN }, { cwd, prompt: "x" });
    expect(noOrigin.status).toBe(403);
    expect((await noOrigin.json()).error).toContain("Origin missing");
    const otherPort = await s.send("/api/agents", { origin: "http://localhost:9999", [TOKEN_HEADER]: TOKEN }, { cwd, prompt: "x" });
    expect(otherPort.status).toBe(403);
    expect(s.host.list().length).toBe(0);
  });

  test("a write from another web page is refused even with the token", async () => {
    const s = server();
    const r = await s.send("/api/agents", { origin: "https://evil.example", [TOKEN_HEADER]: TOKEN }, { cwd: scratch(), prompt: "x" });
    expect(r.status).toBe(403);
    expect(s.host.list().length).toBe(0);
  });

  test("same origin and the right token: the write is accepted", async () => {
    const s = server();
    const r = await s.send("/api/agents", { origin: ORIGIN, [TOKEN_HEADER]: TOKEN }, { cwd: scratch(), prompt: "x" });
    expect(r.status).toBe(201);
    expect(s.host.list().length).toBe(1);
  });

  test("reads need neither Origin nor token", async () => {
    const s = server();
    expect((await s.app.request(`http://${HOST}/api/agents`, { headers: { host: HOST } })).status).toBe(200);
    expect((await s.app.request(`http://${HOST}/api/actions`, { headers: { host: HOST } })).status).toBe(200);
  });

  test("a write route added later, with no guard code of its own, is guarded and logged", async () => {
    const s = server();
    expect((await s.send("/api/later/x1/merge", { origin: ORIGIN })).status).toBe(403);
    // The token alone is not enough: the Origin must be present too (this router has no origin check of its own).
    const tokenOnly = await s.send("/api/later/x1/merge", { [TOKEN_HEADER]: TOKEN });
    expect(tokenOnly.status).toBe(403);
    expect((await tokenOnly.json()).error).toContain("Origin missing");
    expect((await s.send("/api/later/x1/merge", { origin: ORIGIN, [TOKEN_HEADER]: TOKEN })).status).toBe(200);
    for (const m of ["PUT", "PATCH", "DELETE"]) expect((await s.send("/api/later/x1/merge", { origin: ORIGIN }, undefined, m)).status).toBe(403);
    expect(s.lines().map((l) => `${l.method} ${l.result}`)).toEqual(["POST refused", "POST refused", "POST accepted", "PUT refused", "PATCH refused", "DELETE refused"]);
  });
});

describe("action log", () => {
  test("every write appears with its result, target and reason; the token is never in it", async () => {
    const s = server();
    const cwd = scratch();
    await s.send("/api/agents", { origin: ORIGIN }, { cwd, prompt: "no token" });
    await s.send("/api/agents", { origin: ORIGIN, [TOKEN_HEADER]: "wrong" }, { cwd, prompt: "wrong token" });
    await s.send("/api/agents", { origin: "https://evil.example", [TOKEN_HEADER]: TOKEN }, { cwd, prompt: "foreign" });
    const ok = await s.send("/api/agents", { origin: ORIGIN, [TOKEN_HEADER]: TOKEN }, { cwd, prompt: "p".repeat(500), issue: 7 });
    const id = ((await ok.json()) as { id: string }).id;
    await s.send("/api/agents", { origin: ORIGIN, [TOKEN_HEADER]: TOKEN }, { cwd: "relative", prompt: "x" });
    await s.send(`/api/agents/${id}/stop`, { origin: ORIGIN, [TOKEN_HEADER]: TOKEN });

    const l = s.lines();
    expect(l.map((x) => [x.result, x.status])).toEqual([
      ["refused", 403], ["refused", 403], ["refused", 403], ["accepted", 201], ["failed", 400], [expect.any(String), expect.any(Number)],
    ]);
    expect(l[0].reason).toContain("no AnviDeck token");
    expect(l[1].reason).toContain("not this server's");
    expect(l[2].reason).toContain("evil.example");
    expect(l[3].target).toBe(id);
    expect(l[3].area).toBe("agents");
    expect(l[4].reason).toContain("absolute");
    expect(l[5].path).toBe(`/api/agents/${id}/stop`);
    expect(l[5].target).toBe(id);
    for (const x of l) expect(typeof x.at).toBe("string");
    // A long prompt is kept only as a preview.
    expect((l[3].body as Record<string, unknown>).prompt).toBe(`${"p".repeat(80)}… (500 chars)`);
    expect((l[3].body as Record<string, unknown>).issue).toBe(7);
    const raw = readFileSync(s.log.file, "utf8");
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain("p".repeat(81));
  });

  test("reads are not logged", async () => {
    const s = server();
    await s.app.request(`http://${HOST}/api/agents`, { headers: { host: HOST } });
    expect(s.lines()).toEqual([]);
  });

  test("GET /api/actions answers newest first, honours the limit, counts damaged lines, and says when there is no log yet", async () => {
    const s = server();
    const read = async (q = "") => (await s.app.request(`http://${HOST}/api/actions${q}`, { headers: { host: HOST } })).json();
    const empty = await read();
    expect(empty.exists).toBe(false);
    expect(empty.actions).toEqual([]);
    for (const n of [1, 2, 3]) await s.send(`/api/later/n${n}/merge`, { origin: ORIGIN, [TOKEN_HEADER]: TOKEN });
    writeFileSync(s.log.file, readFileSync(s.log.file, "utf8") + "{ not json\n");
    const two = await read("?limit=2");
    expect(two.actions.map((a: ActionRecord) => a.target)).toEqual(["n3", "n2"]);
    expect(two.total).toBe(4);
    expect(two.unreadableLines).toBe(1);
    expect((await s.app.request(`http://${HOST}/api/actions?limit=0`, { headers: { host: HOST } })).status).toBe(400);
    expect((await s.app.request(`http://${HOST}/api/actions?limit=abc`, { headers: { host: HOST } })).status).toBe(400);
  });

  test("a log that cannot be written does not undo the action; the failure is counted", async () => {
    const parent = scratch();
    const dir = join(parent, "ro");
    mkdirSync(dir);
    chmodSync(dir, 0o500);
    const log = new ActionLog(dir);
    const app = new Hono();
    installGuard(app, { bind: "127.0.0.1", token: TOKEN, log });
    app.post("/api/x", (c) => c.json({ ok: true }));
    const r = await app.request(`http://${HOST}/api/x`, { method: "POST", headers: { host: HOST, origin: ORIGIN, [TOKEN_HEADER]: TOKEN } });
    chmodSync(dir, 0o700);
    expect(r.status).toBe(200);
    expect(log.read(5).writeFailures.count).toBe(1);
  });
});

describe("the token", () => {
  test("is compared exactly", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN + "x", TOKEN)).toBe(false);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
    expect(tokenMatches("", "")).toBe(false);
  });

  test("is made once per process, long and random", () => {
    const t = serverWriteToken();
    expect(t).toBe(serverWriteToken());
    expect(t.length).toBeGreaterThanOrEqual(40);
  });

  test("reaches the agent-host page as a meta tag, and the page is not cached", async () => {
    const agents = createAgentHost(() => {}, () => new AgentHost({ query: (() => { throw new Error("unused"); }) as unknown as QueryFn, registry: new AgentRegistry(scratch()) }));
    const r = await agents.page.request("/agent-host");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.text()).toContain(`<meta name="${TOKEN_META}" content="${serverWriteToken()}">`);
  });

  test("withWriteToken places the meta inside <head> and refuses a page without one", () => {
    const html = withWriteToken("<html><head><title>x</title></head><body></body></html>", "abc");
    expect(html).toMatch(/<head>.*<meta name="anvideck-write-token" content="abc">\s*<\/head>/s);
    expect(() => withWriteToken("<body></body>", "abc")).toThrow();
  });
});

describe("body preview", () => {
  test("strings are cut to a preview, nested values are not kept", () => {
    expect(previewBody("")).toBeUndefined();
    expect(previewBody("nope")).toBe("not JSON (4 chars)");
    expect(previewBody("[1,2]")).toBe("JSON array");
    expect(previewBody(JSON.stringify({ a: "x".repeat(81), b: 1, c: { d: 1 }, e: [1, 2] }))).toEqual({
      a: `${"x".repeat(80)}… (81 chars)`, b: 1, c: "[object]", e: "[array of 2]",
    });
  });
});
