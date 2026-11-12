// Answering an agent's permission requests (#77): the host keeps them until you answer, or the
// agent stops; nothing allows them by default; every answer is a guarded, logged write.
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Options, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentHost, type QueryFn } from "../server/agents/host";
import { AgentRegistry } from "../server/agents/registry";
import { loginOnlyEnv } from "../server/agents/login";
import { agentRoutes } from "../server/routes/agents";
import { installGuard } from "../server/guard";
import { dispatch, isFromApp } from "../server/desktop";
import { ActionLog, type ActionRecord } from "../server/action-log";
import {
  askerOf,
  askSummary,
  DEFAULT_DENY_MESSAGE,
  parsePermissionAnswer,
  permissionQueue,
  type AskingAgent,
  requestInputText,
  subagentDetail,
} from "../shared/permission-requests";

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "perm-req-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const init = { type: "system", subtype: "init", apiKeySource: "none", session_id: "s1", claude_code_version: "2", model: "m", cwd: "/x", tools: [], mcp_servers: [], permissionMode: "default", slash_commands: [], output_style: "default", uuid: "u" } as unknown as SDKMessage;
const result = { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, num_turns: 1, duration_ms: 1, duration_api_ms: 1, stop_reason: null, usage: {}, modelUsage: {}, session_id: "s1", uuid: "u3" } as unknown as SDKMessage;

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await tick();
  }
}

/** A fake Claude Code that asks once to Write, then reports what it was told. */
function asking(signal?: AbortSignal) {
  const answers: PermissionResult[] = [];
  const query: QueryFn = ({ options }: { options: Options }) =>
    (async function* () {
      yield init;
      const a = await options.canUseTool!("Write", { file_path: "/tmp/x.txt", content: "hi" }, { signal: signal ?? new AbortController().signal, toolUseID: "t1" } as never);
      answers.push(a);
      // Like Claude Code, a run whose abort fired ends with an error, not a result.
      if (options.abortController?.signal.aborted) throw new Error("aborted");
      yield result;
    })() as unknown as ReturnType<QueryFn>;
  const dir = scratch();
  const host = new AgentHost({
    registry: new AgentRegistry(dir),
    query,
    resolveClaude: () => ({ path: "/fake/claude", realPath: "/fake/claude-2", fileId: "1:1:1" }),
    env: () => loginOnlyEnv({ PATH: "/usr/bin" }),
    emit: () => {},
  });
  const events = (id: string) => host.transcript(id).lines.filter((l) => l.from === "host").map((l) => l.message as Record<string, unknown>);
  return { host, answers, events };
}

async function parked(h: ReturnType<typeof asking>) {
  const a = h.host.start({ cwd: scratch(), prompt: "write a file" });
  await until(() => h.host.get(a.id).pendingPermissions.length === 1);
  return { id: a.id, requestId: h.host.get(a.id).pendingPermissions[0].requestId };
}

describe("reading an answer", () => {
  test("allow, deny with and without a message; anything else is refused in words", () => {
    expect(parsePermissionAnswer({ decision: "allow" })).toEqual({ decision: "allow" });
    expect(parsePermissionAnswer({ decision: "deny", message: "  not that file  " })).toEqual({ decision: "deny", message: "not that file" });
    expect(parsePermissionAnswer({ decision: "deny" })).toEqual({ decision: "deny", message: DEFAULT_DENY_MESSAGE });
    expect(parsePermissionAnswer({ decision: "deny", message: "   " })).toEqual({ decision: "deny", message: DEFAULT_DENY_MESSAGE });
    expect(parsePermissionAnswer({})).toHaveProperty("error");
    expect(parsePermissionAnswer({ decision: "yes" })).toHaveProperty("error");
    expect(parsePermissionAnswer({ decision: "allow", message: "x" })).toHaveProperty("error");
    expect(parsePermissionAnswer({ decision: "deny", message: 3 })).toHaveProperty("error");
    expect(parsePermissionAnswer({ decision: "deny", message: "x".repeat(5000) })).toHaveProperty("error");
  });

  test("what the agent asks, in a few words", () => {
    expect(askSummary("Write", { file_path: "/a/b.txt" })).toBe("write /a/b.txt");
    expect(askSummary("Edit", { file_path: "/a/b.ts" })).toBe("edit /a/b.ts");
    expect(askSummary("Bash", { command: "rm -rf\n build" })).toBe("run `rm -rf build`");
    expect(askSummary("WebFetch", { url: "https://x.example" })).toBe("fetch https://x.example");
    expect(askSummary("mcp__thing__do", {})).toBe("use mcp__thing__do");
  });

  test("the queue is every agent's requests, longest waiting first; an unreadable one is counted", () => {
    const ag = (id: string, ps: unknown[]): AskingAgent => ({ id, cwd: "/c", prompt: "p", pendingPermissions: ps });
    const req = (requestId: string, askedAt: string) => ({ requestId, toolName: "Write", input: {}, askedAt });
    const q = permissionQueue([
      ag("a", [req("r2", "2026-11-05T10:00:02Z")]),
      ag("b", [req("r1", "2026-11-05T10:00:01Z"), { nope: true }]),
      ag("c", []),
    ]);
    expect(q.requests.map((r) => [r.agent.id, r.request.requestId])).toEqual([["b", "r1"], ["a", "r2"]]);
    expect(q.unreadable).toBe(1);
  });
});

describe("answering on the host", () => {
  test("Allow lets the call run as asked, and the transcript says who answered what", async () => {
    const h = asking();
    const { id, requestId } = await parked(h);
    expect(h.events(id).some((e) => e.event === "permission-asked" && e.requestId === requestId)).toBe(true);
    const v = h.host.answer(id, requestId, { decision: "allow" });
    expect(v.pendingPermissions).toEqual([]);
    await until(() => h.host.get(id).status === "done");
    expect(h.answers).toEqual([{ behavior: "allow", updatedInput: { file_path: "/tmp/x.txt", content: "hi" } }]);
    expect(h.events(id).find((e) => e.event === "permission-answered")).toEqual({ event: "permission-answered", requestId, behavior: "allow" });
  });

  test("Deny refuses the call with your message, without interrupting, so the agent can answer it", async () => {
    const h = asking();
    const { id, requestId } = await parked(h);
    h.host.answer(id, requestId, { decision: "deny", message: "use /tmp/y.txt instead" });
    await until(() => h.host.get(id).status === "done");
    expect(h.answers).toEqual([{ behavior: "deny", message: "use /tmp/y.txt instead" }]);
    expect(h.events(id).find((e) => e.event === "permission-answered")).toMatchObject({ behavior: "deny", message: "use /tmp/y.txt instead" });
  });

  test("a second answer, an unknown agent and a bad answer are refused; nothing is settled by them", async () => {
    const h = asking();
    const { id, requestId } = await parked(h);
    expect(() => h.host.answer("nope", requestId, { decision: "allow" })).toThrow("no agent");
    expect(() => h.host.answer(id, requestId, { decision: "maybe" })).toThrow('"allow" or "deny"');
    expect(() => h.host.answer(id, "no-such-request", { decision: "allow" })).toThrow("no longer waiting");
    expect(h.host.get(id).pendingPermissions.length).toBe(1);
    h.host.answer(id, requestId, { decision: "deny" });
    expect(() => h.host.answer(id, requestId, { decision: "allow" })).toThrow("no longer waiting");
    await until(() => h.host.get(id).status === "done");
    expect(h.answers).toEqual([{ behavior: "deny", message: DEFAULT_DENY_MESSAGE }]);
  });

  test("a request nobody answers keeps waiting: no timeout settles it", async () => {
    const h = asking();
    const { id } = await parked(h);
    await tick(1500);
    expect(h.answers).toEqual([]);
    expect(h.host.get(id).status).toBe("waiting");
    expect(h.host.get(id).pendingPermissions.length).toBe(1);
    h.host.stopAll("test over");
  });

  test("stopping the agent withdraws the request as a deny, records it, and it can no longer be answered", async () => {
    const h = asking();
    const { id, requestId } = await parked(h);
    h.host.stop(id);
    expect(h.host.get(id).pendingPermissions).toEqual([]);
    await until(() => h.answers.length === 1);
    expect(h.answers[0]).toMatchObject({ behavior: "deny", interrupt: true });
    expect(h.events(id).find((e) => e.event === "permission-withdrawn")).toMatchObject({ requestId, reason: "stopped by you" });
    expect(() => h.host.answer(id, requestId, { decision: "allow" })).toThrow("no longer waiting");
    await until(() => h.host.running === 0);
    expect(h.host.get(id).status).toBe("stopped");
  });

  test("Claude Code cancelling the call withdraws the request too", async () => {
    const cancel = new AbortController();
    const h = asking(cancel.signal);
    const { id, requestId } = await parked(h);
    cancel.abort();
    await until(() => h.answers.length === 1);
    expect(h.answers[0].behavior).toBe("deny");
    expect(h.host.get(id).pendingPermissions).toEqual([]);
    expect(h.events(id).find((e) => e.event === "permission-withdrawn")).toMatchObject({ requestId, reason: "Claude Code cancelled the call" });
  });
});

describe("the route", () => {
  const HOST = "localhost:4475";
  const ORIGIN = `http://${HOST}`;

  function server() {
    const h = asking();
    const log = new ActionLog(scratch());
    const app = new Hono();
    installGuard(app, { bind: "127.0.0.1", log, isFromApp });
    app.route("/api/agents", agentRoutes(h.host, async () => ({ ok: true })));
    const send = (path: string, headers: Record<string, string>, body: unknown) =>
      app.request(`http://${HOST}${path}`, { method: "POST", headers: { host: HOST, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    /** An answer from the app's window, over its private channel (#241). */
    const viaApp = async (path: string, body: unknown) => {
      const r = await dispatch(app, { method: "POST", path, body }, HOST);
      return { status: r.status, json: async () => r.body };
    };
    const get = (path: string) => app.request(`http://${HOST}${path}`, { headers: { host: HOST } });
    const lines = (): ActionRecord[] => readFileSync(log.file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return { h, send, viaApp, get, lines };
  }

  test("a parked request is in GET /api/agents (a reloaded page finds it); an answer is a guarded, logged write", async () => {
    const s = server();
    const { id, requestId } = await parked(s.h);
    const listed = (await (await s.get("/api/agents")).json()) as { agents: { id: string; pendingPermissions: { requestId: string; toolName: string; input: unknown }[] }[] };
    expect(listed.agents.find((a) => a.id === id)?.pendingPermissions).toMatchObject([{ requestId, toolName: "Write", input: { file_path: "/tmp/x.txt" } }]);

    const path = `/api/agents/${id}/permissions/${requestId}`;
    // Over HTTP, even from AnviDeck's own Origin: refused (#241).
    const overHttp = await s.send(path, { origin: ORIGIN }, { decision: "allow" });
    expect(overHttp.status).toBe(403);
    expect(s.h.host.get(id).pendingPermissions.length).toBe(1);

    const bad = await s.viaApp(path, { decision: "perhaps" });
    expect(bad.status).toBe(400);

    const ok = await s.viaApp(path, { decision: "deny", message: "not now" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { pendingPermissions: unknown[] }).pendingPermissions).toEqual([]);

    const again = await s.viaApp(path, { decision: "allow" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain("no longer waiting");

    await until(() => s.h.answers.length === 1);
    expect(s.h.answers[0]).toEqual({ behavior: "deny", message: "not now" });
    const log = s.lines().filter((l) => l.path === path);
    expect(log.map((l) => [l.status, l.result, l.target])).toEqual([
      [403, "refused", id],
      [400, "failed", id],
      [200, "accepted", id],
      [409, "failed", id],
    ]);
    expect(log[2].body).toEqual({ decision: "deny", message: "not now" });
  });
});

describe("the card shows the whole input that Allow would run", () => {
  test("a long command keeps its tail, and its length is stated", () => {
    const cmd = "echo " + "x".repeat(2500) + " && rm -rf ~/TAIL_MARKER";
    const r = requestInputText({ command: cmd });
    expect(r.text).toContain("rm -rf ~/TAIL_MARKER");
    expect(r.chars).toBe(r.text.length);
    expect(r.chars).toBeGreaterThan(2500);
  });

  test("the card puts exactly that text in its input box and never shortens it", () => {
    const src = readFileSync(new URL("../ui/components/PermissionRequests.ts", import.meta.url), "utf8");
    expect(src).toMatch(/const shown = requestInputText\(p\.input\);/);
    expect(src).toMatch(/el\("pre", "perm-input", shown\.text\)/);
    expect(src).not.toMatch(/perm-input[^\n]*\.slice\(/);
    expect(src).not.toMatch(/shown\.text\.slice|shown\.text\.substring/);
  });
});

describe("a subagent's request, on its parent's card (#267)", () => {
  const taskStarted = (id: string) =>
    ({ type: "system", subtype: "task_started", task_id: id, tool_use_id: "tu-agent", description: "look around", subagent_type: "Explore", session_id: "s1", uuid: "ts" }) as unknown as SDKMessage;

  /** A fake Claude Code whose subagent asks before its task_started has arrived (the name comes later). */
  function subagentAsking(opts: { agentID?: string; nameAfter: boolean }) {
    const answers: PermissionResult[] = [];
    let release!: () => void;
    const named = new Promise<void>((r) => (release = r));
    const query: QueryFn = ({ options }: { options: Options }) =>
      (async function* () {
        yield init;
        if (!opts.nameAfter && opts.agentID) yield taskStarted(opts.agentID);
        const asked = options.canUseTool!("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "tu-bash", ...(opts.agentID ? { agentID: opts.agentID } : {}) } as never);
        if (opts.nameAfter && opts.agentID) {
          await named;
          yield taskStarted(opts.agentID);
        }
        answers.push(await asked);
        yield result;
      })() as unknown as ReturnType<QueryFn>;
    const host = new AgentHost({
      registry: new AgentRegistry(scratch()),
      query,
      resolveClaude: () => ({ path: "/fake/claude", realPath: "/fake/claude-2", fileId: "1:1:1" }),
      env: () => loginOnlyEnv({ PATH: "/usr/bin" }),
      emit: () => {},
    });
    const events = (id: string) => host.transcript(id).lines.filter((l) => l.from === "host").map((l) => l.message as Record<string, unknown>);
    return { host, answers, events, release };
  }

  test("named from its task_started; the transcript keeps who asked and the call's id; Allow settles it", async () => {
    const h = subagentAsking({ agentID: "sub-1", nameAfter: false });
    const a = h.host.start({ cwd: scratch(), prompt: "p" });
    await until(() => h.host.get(a.id).pendingPermissions.length === 1);
    const p = h.host.get(a.id).pendingPermissions[0];
    expect(p.subagent).toEqual({ id: "sub-1", type: "Explore", description: "look around" });
    expect(p.toolUseId).toBe("tu-bash");
    expect(askerOf(p)).toBe("Explore (subagent)");
    expect(h.events(a.id).find((e) => e.event === "permission-asked")).toMatchObject({ toolUseId: "tu-bash", subagent: { id: "sub-1", type: "Explore", description: "look around" } });
    h.host.answer(a.id, p.requestId, { decision: "allow" });
    await until(() => h.host.get(a.id).status === "done");
    expect(h.answers).toEqual([{ behavior: "allow", updatedInput: { command: "ls" } }]);
  });

  test("a name that arrives after the request reaches the parked request; until then it reads as a subagent", async () => {
    const h = subagentAsking({ agentID: "sub-2", nameAfter: true });
    const a = h.host.start({ cwd: scratch(), prompt: "p" });
    await until(() => h.host.get(a.id).pendingPermissions.length === 1);
    const before = h.host.get(a.id).pendingPermissions[0];
    expect(before.subagent).toEqual({ id: "sub-2" });
    expect(askerOf(before)).toBe("A subagent");
    h.release();
    await until(() => h.host.get(a.id).pendingPermissions[0]?.subagent?.type === "Explore");
    expect(askerOf(h.host.get(a.id).pendingPermissions[0])).toBe("Explore (subagent)");
    h.host.answer(a.id, before.requestId, { decision: "deny", message: "no" });
    await until(() => h.host.get(a.id).status === "done");
    expect(h.answers).toEqual([{ behavior: "deny", message: "no" }]);
  });

  test("the agent's own request has no subagent field and reads as before", async () => {
    const h = subagentAsking({ nameAfter: false });
    const a = h.host.start({ cwd: scratch(), prompt: "p" });
    await until(() => h.host.get(a.id).pendingPermissions.length === 1);
    const p = h.host.get(a.id).pendingPermissions[0];
    expect("subagent" in p).toBe(false);
    expect(askerOf(p)).toBe("An agent");
    expect(subagentDetail(p)).toBe("");
    expect("subagent" in h.events(a.id).find((e) => e.event === "permission-asked")!).toBe(false);
  });

  test("the wording, and a subagent field the page cannot read makes the row unreadable, never the agent's own", () => {
    expect(subagentDetail({ subagent: { id: "x9", type: "Explore", description: "find  the\nconfig" } })).toBe('subagent Explore, "find the config", id x9');
    expect(subagentDetail({ subagent: { id: "x9" } })).toBe("subagent (name not known yet), id x9");
    const ag = (ps: unknown[]): AskingAgent => ({ id: "a", cwd: "/c", prompt: "p", pendingPermissions: ps });
    const req = { requestId: "r1", toolName: "Bash", input: {}, askedAt: "2026-11-12T10:00:00Z" };
    expect(permissionQueue([ag([{ ...req, subagent: { id: "s" } }])]).requests).toHaveLength(1);
    const bad = permissionQueue([ag([{ ...req, subagent: "Explore" }, { ...req, requestId: "r2", subagent: {} }, { ...req, requestId: "r3", subagent: { id: "s", type: 7 } }, { ...req, requestId: "r4", subagent: { id: "s", description: {} } }])]);
    expect(bad.requests).toHaveLength(0);
    expect(bad.unreadable).toBe(4);
  });
});
