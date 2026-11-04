import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentHost, HostError, MessageQueue, type HostEvent, type QueryFn } from "../server/agents/host";
import { AgentRegistry } from "../server/agents/registry";
import { explainStartFailure, loginOnlyEnv, parseAuthStatus, type ClaudeBinary } from "../server/agents/login";
import { agentRoutes, createAgentHost, sameOriginWrites } from "../server/routes/agents";
import { Hono } from "hono";

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "agent-host-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const CLAUDE: ClaudeBinary = { path: "/fake/bin/claude", realPath: "/fake/lib/claude-2.1.318", fileId: "1:100:1" };

const init = (apiKeySource = "none", session_id = "sess-1") =>
  ({ type: "system", subtype: "init", apiKeySource, session_id, claude_code_version: "2.1.318", model: "m", cwd: "/x", tools: [], mcp_servers: [], permissionMode: "default", slash_commands: [], output_style: "default", uuid: "u" }) as unknown as SDKMessage;
const assistant = (text: string) =>
  ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: "sess-1", uuid: "u2" }) as unknown as SDKMessage;
const result = (subtype = "success", is_error = false) =>
  ({ type: "result", subtype, is_error, result: "ok", total_cost_usd: 0.01, num_turns: 1, duration_ms: 1, duration_api_ms: 1, stop_reason: null, usage: {}, modelUsage: {}, session_id: "sess-1", uuid: "u3", errors: subtype === "success" ? undefined : ["boom"] }) as unknown as SDKMessage;

/** Resolves when the run is aborted; the generator then throws like the SDK does. */
const aborted = (o: Options) =>
  new Promise<never>((_, rej) => o.abortController!.signal.addEventListener("abort", () => rej(new Error("aborted"))));

type Script = (o: Options, prompt: AsyncIterable<SDKUserMessage>) => AsyncGenerator<SDKMessage>;

function fake(script: Script) {
  const calls: { options: Options; first?: string }[] = [];
  const fn: QueryFn = ({ prompt, options }) => {
    const call: { options: Options; first?: string } = { options };
    calls.push(call);
    return (async function* () {
      const it = prompt[Symbol.asyncIterator]();
      const first = await it.next();
      call.first = String((first.value as SDKUserMessage | undefined)?.message.content);
      yield* script(options, prompt);
    })();
  };
  return { fn, calls };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await tick();
  }
}

function makeHost(script: Script, opts: { cap?: number; dir?: string; resolve?: () => ClaudeBinary | null; env?: Record<string, string> } = {}) {
  const dir = opts.dir ?? scratch();
  const events: HostEvent[] = [];
  const q = fake(script);
  const host = new AgentHost({
    registry: new AgentRegistry(dir),
    query: q.fn,
    resolveClaude: opts.resolve ?? (() => CLAUDE),
    env: () => loginOnlyEnv(opts.env ?? { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-fake" }),
    cap: opts.cap ?? 3,
    emit: (e) => events.push(e),
  });
  const statuses = (id: string) =>
    events
      .filter((e) => e.type === "agent" && e.data.id === id)
      .map((e) => (e.data as { status: string }).status)
      // One event per change of anything; the sequence of statuses is what is asserted.
      .filter((s, i, all) => i === 0 || all[i - 1] !== s);
  return { host, events, statuses, calls: q.calls, dir };
}

describe("login-only environment", () => {
  test("credential and parent-session variables are removed, the rest kept", () => {
    const { env, stripped } = loginOnlyEnv({
      PATH: "/usr/bin",
      HOME: "/h",
      ANTHROPIC_API_KEY: "sk-x",
      ANTHROPIC_BASE_URL: "http://proxy",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "abc",
      ANTHROPIC_MODEL: "keep-me",
    });
    expect(stripped).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK"]);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ANTHROPIC_MODEL).toBe("keep-me");
  });

  test("a start that fails while the binary is replaced says Claude Code was updating", () => {
    const moved = { ...CLAUDE, realPath: "/fake/lib/claude-2.1.319" };
    expect(explainStartFailure(CLAUDE, moved, "spawn ENOENT")).toStartWith("Claude Code was updating, try again");
    // Same path, new file underneath: how this machine's install actually updates.
    const replaced = { ...CLAUDE, fileId: "1:200:2" };
    expect(explainStartFailure(CLAUDE, replaced, "spawn ENOENT")).toStartWith("Claude Code was updating, try again");
    expect(explainStartFailure(CLAUDE, null, "spawn ENOENT")).toStartWith("Claude Code was updating, try again");
  });

  test("a start that fails with the binary unchanged is not blamed on an update", () => {
    expect(explainStartFailure(CLAUDE, { ...CLAUDE }, "exit 1")).toBe("Could not start: exit 1");
  });

  test("auth status keeps method and plan, never the email", () => {
    const s = parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "me@x.com", orgName: "me@x.com's Org", subscriptionType: "max" }));
    expect(s).toEqual({ ok: true, loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", plan: "max" });
    expect(JSON.stringify(s)).not.toContain("me@x.com");
    expect(parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "api_key" })).ok).toBe(false);
    expect(parseAuthStatus("not json").error).toBeDefined();
  });
});

describe("agent host", () => {
  test("start → working → done; transcript and registry on disk; agent runs on the login", async () => {
    const { host, statuses, calls, dir } = makeHost(async function* () {
      yield init();
      yield assistant("hi");
      yield result();
    });
    const cwd = scratch();
    const a = host.start({ cwd, prompt: "say hi", issue: 75 });
    expect(a.status).toBe("starting");
    await until(() => host.get(a.id).status === "done");
    expect(statuses(a.id)).toEqual(["starting", "working", "done"]);
    const got = host.get(a.id);
    expect(got.sessionId).toBe("sess-1");
    expect(got.apiKeySource).toBe("none");
    expect(got.strippedEnv).toEqual(["ANTHROPIC_API_KEY"]);
    expect(got.costEstimateUsd).toBe(0.01);
    // The SDK got the installed claude and an environment without the key.
    expect(calls[0].options.pathToClaudeCodeExecutable).toBe(CLAUDE.path);
    expect(calls[0].options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(calls[0].options.cwd).toBe(cwd);
    expect(calls[0].first).toBe("say hi");
    const saved = JSON.parse(readFileSync(join(dir, "agents.json"), "utf8")).agents;
    expect(saved[0]).toMatchObject({ id: a.id, status: "done", sessionId: "sess-1", issue: 75 });
    const tx = host.transcript(a.id).lines;
    expect(tx.filter((l) => l.from === "sdk").map((l) => (l.message as { type: string }).type)).toEqual(["system", "assistant", "result"]);
    expect(tx.map((l) => l.seq)).toEqual(tx.map((_, i) => i + 1));
    await until(() => host.running === 0);
  });

  test("an agent reporting any credential source but none is stopped at once and never shown running", async () => {
    let wasAborted = false;
    const { host, statuses } = makeHost(async function* (o) {
      o.abortController!.signal.addEventListener("abort", () => (wasAborted = true));
      yield init("ANTHROPIC_API_KEY");
      yield assistant("I would now spend API credit");
      yield result();
    });
    const a = host.start({ cwd: scratch(), prompt: "x" });
    await until(() => host.running === 0);
    const got = host.get(a.id);
    expect(got.status).toBe("failed");
    expect(got.reason).toContain('"ANTHROPIC_API_KEY"');
    expect(statuses(a.id)).not.toContain("working");
    expect(statuses(a.id)).not.toContain("done");
    expect(wasAborted).toBe(true);
    // Nothing after the init made it into the transcript.
    expect(host.transcript(a.id).lines.some((l) => (l.message as { type?: string }).type === "assistant")).toBe(false);
  });

  test("could not start never shows as done", async () => {
    const { host } = makeHost(async function* () {
      throw new Error("spawn ENOENT");
    });
    const a = host.start({ cwd: scratch(), prompt: "x" });
    await until(() => host.running === 0);
    expect(host.get(a.id).status).toBe("failed");
    expect(host.get(a.id).reason).toContain("spawn ENOENT");
  });

  test("exiting without a result, or a result before init, is failed", async () => {
    const quiet = makeHost(async function* () {
      yield init();
    });
    const a = quiet.host.start({ cwd: scratch(), prompt: "x" });
    await until(() => quiet.host.running === 0);
    expect(quiet.host.get(a.id).status).toBe("failed");
    expect(quiet.host.get(a.id).reason).toContain("without a result");

    const early = makeHost(async function* () {
      yield result();
    });
    const b = early.host.start({ cwd: scratch(), prompt: "x" });
    await until(() => early.host.running === 0);
    expect(early.host.get(b.id).status).toBe("failed");
  });

  test("a quiet exit before init says why, with Claude Code's own stderr", async () => {
    let n = 0;
    const { host } = makeHost(
      async function* (o) {
        o.stderr?.("Error: claude.exe vanished\n");
      },
      { resolve: () => (n++ === 0 ? CLAUDE : { ...CLAUDE, fileId: "1:200:2" }) },
    );
    const a = host.start({ cwd: scratch(), prompt: "x" });
    await until(() => host.running === 0);
    const got = host.get(a.id);
    expect(got.status).toBe("failed");
    expect(got.reason).toStartWith("Claude Code was updating, try again");
    expect(got.reason).toContain("claude.exe vanished");
  });

  test("an error result is failed, not done", async () => {
    const { host } = makeHost(async function* () {
      yield init();
      yield result("error_during_execution", true);
    });
    const a = host.start({ cwd: scratch(), prompt: "x" });
    await until(() => host.running === 0);
    expect(host.get(a.id).status).toBe("failed");
    expect(host.get(a.id).reason).toContain("error_during_execution");
  });

  test("a spawn failure while claude was being replaced says it was updating", async () => {
    let n = 0;
    const { host } = makeHost(
      async function* () {
        throw new Error("spawn ENOENT");
      },
      { resolve: () => (n++ === 0 ? CLAUDE : { ...CLAUDE, fileId: "1:200:2" }) },
    );
    const a = host.start({ cwd: scratch(), prompt: "x" });
    await until(() => host.running === 0);
    expect(host.get(a.id).reason).toStartWith("Claude Code was updating, try again");
  });

  test("stop ends the run at once; cap refuses a start beyond it", async () => {
    const hold: Script = async function* (o) {
      yield init();
      await aborted(o);
    };
    const { host, statuses } = makeHost(hold, { cap: 1 });
    const a = host.start({ cwd: scratch(), prompt: "x" });
    await until(() => host.get(a.id).status === "working");
    let err: unknown;
    try {
      host.start({ cwd: scratch(), prompt: "y" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HostError);
    expect((err as HostError).status).toBe(429);
    expect(host.list().length).toBe(1);
    expect(host.stop(a.id).status).toBe("stopped");
    await until(() => host.running === 0);
    expect(host.get(a.id).status).toBe("stopped");
    expect(statuses(a.id).at(-1)).toBe("stopped");
    expect(() => host.stop(a.id)).toThrow("not running");
    // Room again.
    const b = host.start({ cwd: scratch(), prompt: "y" });
    expect(b.status).toBe("starting");
    host.stopAll("test over");
  });

  test("after a restart a live agent is listed as stopped with its transcript, and resumes its session", async () => {
    const dir = scratch();
    const first = makeHost(async function* (o) {
      yield init("none", "sess-keep");
      yield assistant("working on it");
      await aborted(o);
    }, { dir });
    const a = first.host.start({ cwd: scratch(), prompt: "long job" });
    await until(() => first.host.get(a.id).status === "working" && first.host.get(a.id).messageCount >= 3);
    // The server goes away without stopping it (crash / kill): the registry still says working.
    expect(JSON.parse(readFileSync(join(dir, "agents.json"), "utf8")).agents[0].status).toBe("working");

    const second = makeHost(async function* () {
      yield init("none", "sess-keep");
      yield assistant("resumed");
      yield result();
    }, { dir });
    const back = second.host.get(a.id);
    expect(back.status).toBe("stopped");
    expect(back.reason).toContain("restarted");
    expect(second.host.transcript(a.id).lines.length).toBe(back.messageCount);
    const before = back.messageCount;

    second.host.resume(a.id, "carry on");
    expect(second.calls[0].options.resume).toBe("sess-keep");
    await until(() => second.host.get(a.id).status === "done");
    expect(second.calls[0].first).toBe("carry on");
    const lines = second.host.transcript(a.id).lines;
    expect(lines[before].seq).toBe(before + 1);
    expect(second.host.get(a.id).runs).toBe(2);
    first.host.stopAll("test over");
  });

  test("resume is refused for an agent that never reached Claude Code", async () => {
    const { host } = makeHost(async function* () {
      throw new Error("nope");
    });
    const a = host.start({ cwd: scratch(), prompt: "x" });
    await until(() => host.running === 0);
    expect(() => host.resume(a.id, "again")).toThrow("no session to resume");
  });

  test("permission requests park the agent as waiting until answered", async () => {
    let answer: unknown;
    const { host, statuses } = makeHost(async function* (o) {
      yield init();
      answer = await o.canUseTool!("Write", { file_path: "/x" }, { signal: new AbortController().signal, toolUseID: "t1" } as never);
      yield result();
    });
    const a = host.start({ cwd: scratch(), prompt: "x" });
    await until(() => host.get(a.id).status === "waiting");
    const pending = host.get(a.id).pendingPermissions;
    expect(pending.map((p) => p.toolName)).toEqual(["Write"]);
    expect(host.answerPermission(a.id, "no-such", { behavior: "allow" })).toBe(false);
    expect(host.answerPermission(a.id, pending[0].requestId, { behavior: "deny", message: "no" })).toBe(true);
    await until(() => host.get(a.id).status === "done");
    expect(answer).toEqual({ behavior: "deny", message: "no" });
    expect(statuses(a.id)).toEqual(["starting", "working", "waiting", "working", "done"]);
  });

  test("bad requests are refused before anything runs", () => {
    const { host, calls } = makeHost(async function* () {});
    expect(() => host.start({ cwd: "relative/path", prompt: "x" })).toThrow("absolute");
    expect(() => host.start({ cwd: "/definitely/not/here", prompt: "x" })).toThrow("does not exist");
    expect(() => host.start({ cwd: scratch(), prompt: "  " })).toThrow("empty");
    expect(() => host.start({ cwd: scratch(), prompt: "x", issue: "abc" })).toThrow("issue");
    const none = makeHost(async function* () {}, { resolve: () => null });
    expect(() => none.host.start({ cwd: scratch(), prompt: "x" })).toThrow("not on PATH");
    expect(calls.length + none.calls.length).toBe(0);
  });

  test("the prompt is a stream: messages sent mid-turn arrive in order", async () => {
    const q = new MessageQueue();
    q.push("one");
    const got: string[] = [];
    const reader = (async () => {
      for await (const m of q) got.push(String(m.message.content));
    })();
    await tick();
    q.push("two");
    q.end();
    expect(q.push("three")).toBe(false);
    await reader;
    expect(got).toEqual(["one", "two"]);
  });
});

describe("agent routes", () => {
  const { host } = makeHost(async function* () {
    yield init();
    yield result();
  });
  const app = new Hono();
  app.route("/api/agents", agentRoutes(host, async () => ({ ok: true, authMethod: "claude.ai", plan: "max" })));
  const post = (headers: Record<string, string>, body: unknown) =>
    app.request("http://localhost:4475/api/agents", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  test("a write without this server's Origin is refused", async () => {
    const cwd = scratch();
    expect((await post({ host: "localhost:4475" }, { cwd, prompt: "x" })).status).toBe(403);
    expect((await post({ host: "localhost:4475", origin: "https://evil.example" }, { cwd, prompt: "x" })).status).toBe(403);
    expect((await post({ host: "localhost:4475", origin: "http://localhost:9999" }, { cwd, prompt: "x" })).status).toBe(403);
    expect(host.list().length).toBe(0);
  });

  test("a write from this server's own page starts an agent; reads need no Origin", async () => {
    const r = await post({ host: "localhost:4475", origin: "http://localhost:4475" }, { cwd: scratch(), prompt: "x" });
    expect(r.status).toBe(201);
    const list = await app.request("http://localhost:4475/api/agents", { headers: { host: "localhost:4475" } });
    expect(list.status).toBe(200);
    const j = (await list.json()) as { agents: unknown[]; login: { plan: string } };
    expect(j.agents.length).toBe(1);
    expect(j.login.plan).toBe("max");
  });

  test("host errors keep their status and words", async () => {
    const r = await post({ host: "localhost:4475", origin: "http://localhost:4475" }, { cwd: "nope", prompt: "x" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain("absolute");
    const missing = await app.request("http://localhost:4475/api/agents/zzz", { headers: { host: "localhost:4475" } });
    expect(missing.status).toBe(404);
  });

  test("sameOriginWrites lets GET through without Origin", async () => {
    const a = new Hono();
    a.use("/*", sameOriginWrites);
    a.get("/x", (c) => c.text("ok"));
    a.post("/x", (c) => c.text("ok"));
    expect((await a.request("http://h/x", { headers: { host: "h" } })).status).toBe(200);
    expect((await a.request("http://h/x", { method: "POST", headers: { host: "h" } })).status).toBe(403);
    expect((await a.request("http://h/x", { method: "POST", headers: { host: "h", origin: "http://h" } })).status).toBe(200);
  });
});

describe("an unreadable registry turns off only the agent host", () => {
  test("the agent routes answer 503 with the reason, other routes still answer, and the file is untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-host-bad-"));
    const file = join(dir, "agents.json");
    writeFileSync(file, "{ not json");
    const agents = createAgentHost(() => {}, () => new AgentHost({ query: (() => { throw new Error("unused"); }) as unknown as QueryFn, registry: new AgentRegistry(dir) }));
    expect(agents.host).toBeNull();
    const app = new Hono();
    app.route("/api/agents", agents.api);
    app.route("/", agents.page);
    app.get("/api/projects", (c) => c.json({ ok: true }));
    const r = await app.request("/api/agents");
    expect(r.status).toBe(503);
    expect((await r.json()).error).toContain("registry could not be read");
    expect((await app.request("/agent-host")).status).toBe(503);
    expect((await app.request("/api/projects")).status).toBe(200);
    expect(() => agents.stopAll("shut down")).not.toThrow();
    expect(readFileSync(file, "utf8")).toBe("{ not json");
    rmSync(dir, { recursive: true, force: true });
  });
});
