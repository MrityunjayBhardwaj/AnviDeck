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
import { installGuard, previewBody, HTTP_WRITE_REFUSAL } from "../server/guard";
import { dispatch, isFromApp } from "../server/desktop";
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
  installGuard(app, { bind: "127.0.0.1", log, isFromApp });
  app.route("/api/actions", actionRoutes(log));
  app.route("/api/agents", agentRoutes(host, async () => ({ ok: true })));
  // A write route nobody guarded by hand: it must still be guarded and logged.
  const later = new Hono();
  later.post("/:id/merge", (c) => c.json({ merged: c.req.param("id") }));
  app.route("/api/later", later);
  /** A request over HTTP, as any process on the machine can send one. */
  const send = (path: string, headers: Record<string, string>, body?: unknown, method = "POST") =>
    app.request(`http://${HOST}${path}`, {
      method,
      headers: { host: HOST, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  /** A write through the desktop app's private channel. */
  const viaApp = (path: string, body?: unknown, method = "POST") => dispatch(app, { method, path, body }, HOST);
  const lines = (): ActionRecord[] => {
    try {
      return readFileSync(log.file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return { app, host, log, send, viaApp, lines };
}

describe("writes only through the app (#241)", () => {
  test("a write over HTTP is refused whatever it carries, with the reason; nothing starts", async () => {
    const s = server();
    const cwd = scratch();
    for (const headers of [{}, { origin: ORIGIN }, { origin: ORIGIN, "x-anvideck-token": "anything" }, { origin: "tauri://localhost" }]) {
      const r = await s.send("/api/agents", headers, { cwd, prompt: "x" });
      expect(r.status).toBe(403);
      expect((await r.json()).error).toBe(HTTP_WRITE_REFUSAL);
    }
    expect(s.host.list().length).toBe(0);
  });

  test("the same write through the app's channel is accepted", async () => {
    const s = server();
    const r = await s.viaApp("/api/agents", { cwd: scratch(), prompt: "x" });
    expect(r.status).toBe(201);
    expect(s.host.list().length).toBe(1);
  });

  test("the channel carries only writes under /api", async () => {
    const s = server();
    expect((await s.viaApp("/api/agents", undefined, "GET")).status).toBe(400);
    expect(((await s.viaApp("/etc/passwd", {})).body as { error: string }).error).toContain("must start with /api/");
    expect(s.lines()).toEqual([]);
  });

  test("reads over HTTP stay open to this machine", async () => {
    const s = server();
    expect((await s.app.request(`http://${HOST}/api/agents`, { headers: { host: HOST } })).status).toBe(200);
    expect((await s.app.request(`http://${HOST}/api/actions`, { headers: { host: HOST } })).status).toBe(200);
  });

  test("a write route added later, with no guard code of its own, is refused over HTTP for every method and logged", async () => {
    const s = server();
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect((await s.send("/api/later/x1/merge", { origin: ORIGIN }, undefined, m)).status).toBe(403);
    expect((await s.viaApp("/api/later/x1/merge")).status).toBe(200);
    expect(s.lines().map((l) => `${l.method} ${l.result}`)).toEqual(["POST refused", "PUT refused", "PATCH refused", "DELETE refused", "POST accepted"]);
  });

  test("the agent host page carries no token", async () => {
    const agents = createAgentHost(() => {}, () => new AgentHost({ query: (() => { throw new Error("unused"); }) as unknown as QueryFn, registry: new AgentRegistry(scratch()) }));
    const html = await (await agents.page.request("/agent-host")).text();
    expect(html).toContain('<div id="agent-host">');
    expect(html).not.toContain("anvideck-write-token");
  });
});

describe("action log", () => {
  test("every write appears with its result, target and reason; a long prompt only as a preview", async () => {
    const s = server();
    const cwd = scratch();
    await s.send("/api/agents", { origin: ORIGIN }, { cwd, prompt: "over http" });
    const ok = await s.viaApp("/api/agents", { cwd, prompt: "p".repeat(500), issue: 7 });
    const id = (ok.body as { id: string }).id;
    await s.viaApp("/api/agents", { cwd: "relative", prompt: "x" });
    await s.viaApp(`/api/agents/${id}/stop`);

    const l = s.lines();
    expect(l.map((x) => [x.result, x.status])).toEqual([
      ["refused", 403], ["accepted", 201], ["failed", 400], [expect.any(String), expect.any(Number)],
    ]);
    expect(l[0].reason).toContain("read-only");
    expect(l[1].target).toBe(id);
    expect(l[1].area).toBe("agents");
    expect(l[2].reason).toContain("absolute");
    expect(l[3].path).toBe(`/api/agents/${id}/stop`);
    expect(l[3].target).toBe(id);
    for (const x of l) expect(typeof x.at).toBe("string");
    expect((l[1].body as Record<string, unknown>).prompt).toBe(`${"p".repeat(80)}… (500 chars)`);
    expect((l[1].body as Record<string, unknown>).issue).toBe(7);
    expect(readFileSync(s.log.file, "utf8")).not.toContain("p".repeat(81));
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
    for (const n of [1, 2, 3]) await s.viaApp(`/api/later/n${n}/merge`);
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
    installGuard(app, { bind: "127.0.0.1", log, isFromApp });
    app.post("/api/x", (c) => c.json({ ok: true }));
    const r = await dispatch(app, { method: "POST", path: "/api/x" }, HOST);
    chmodSync(dir, 0o700);
    expect(r.status).toBe(200);
    expect(log.read(5).writeFailures.count).toBe(1);
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
