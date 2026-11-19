// Steering a running agent as in the terminal: answering its multiple-choice question (#302),
// approving its finished plan into another mode (#303), and changing its mode while it runs
// (#306). Every change of mode goes through one check (checkModeChange) and is held to the
// safety check that stops an agent reporting a wider mode than it was given.
import { afterAll, describe, expect, test } from "bun:test";
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
import { checkModeChange, FULL_ACCESS_FIXED, modeCapFrom, modesForChange, modesOffered, type AgentMode } from "../shared/agent-modes";
import { answersLine, checkAnswers, parsePermissionAnswer, readPlan, readQuestions } from "../shared/permission-requests";

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "steer-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const init = (permissionMode: string) =>
  ({ type: "system", subtype: "init", apiKeySource: "none", session_id: "s1", claude_code_version: "2", model: "m", cwd: "/x", tools: [], mcp_servers: [], permissionMode, slash_commands: [], output_style: "default", uuid: "u" }) as unknown as SDKMessage;
const status = (permissionMode: string) => ({ type: "system", subtype: "status", status: null, permissionMode, uuid: "u2", session_id: "s1" }) as unknown as SDKMessage;
const result = { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, num_turns: 1, duration_ms: 1, duration_api_ms: 1, stop_reason: null, usage: {}, modelUsage: {}, session_id: "s1", uuid: "u3" } as unknown as SDKMessage;

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await tick();
  }
}

const QUESTIONS = {
  questions: [
    { question: "Which library should we use?", header: "Library", multiSelect: false, options: [{ label: "zod", description: "schemas" }, { label: "valibot", description: "smaller", preview: "v.object({})" }] },
    { question: "Which tests should run?", header: "Tests", multiSelect: true, options: [{ label: "unit", description: "fast" }, { label: "e2e", description: "slow" }] },
  ],
};
const PLAN = { plan: "# Plan\n\n1. Add the field\n2. Test it", planFilePath: "/home/u/.claude/plans/p.md" };

/**
 * A fake Claude Code driven step by step. It reports `mode` in each init, asks the tools it is
 * told to, applies a session setMode carried by an answer (as Claude Code does) and says so in a
 * status message, and takes setPermissionMode on the query. Ends when `end()` is called.
 */
function fakeClaude(opts: { asks?: { tool: string; input: Record<string, unknown> }[]; setFails?: boolean } = {}) {
  const answers: PermissionResult[] = [];
  const modesSet: string[] = [];
  const launched: { permissionMode?: string; hasCallback: boolean }[] = [];
  const out: SDKMessage[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const push = (m: SDKMessage) => {
    out.push(m);
    wake?.();
  };
  const query: QueryFn = ({ options }: { options: Options }) => {
    let mode = options.permissionMode ?? "default";
    launched.push({ permissionMode: options.permissionMode, hasCallback: !!options.canUseTool });
    const gen = (async function* () {
      yield init(mode);
      for (const a of opts.asks ?? []) {
        const r = await options.canUseTool!(a.tool, a.input, { signal: new AbortController().signal, toolUseID: `t-${a.tool}` } as never);
        answers.push(r);
        const set = r.behavior === "allow" ? r.updatedPermissions?.find((u) => u.type === "setMode") : undefined;
        if (set && set.type === "setMode") {
          mode = set.mode;
          yield status(mode);
        }
      }
      while (!ended && !options.abortController?.signal.aborted) {
        while (out.length) yield out.shift()!;
        await new Promise<void>((r) => {
          wake = r;
          options.abortController?.signal.addEventListener("abort", () => r());
          setTimeout(r, 20);
        });
      }
      while (out.length) yield out.shift()!;
      if (options.abortController?.signal.aborted) throw new Error("aborted");
      yield result;
    })();
    return Object.assign(gen, {
      setPermissionMode: async (m: string) => {
        modesSet.push(m);
        if (opts.setFails) throw new Error("Claude Code refused the mode");
        mode = m;
        push(status(m));
      },
    }) as unknown as ReturnType<QueryFn>;
  };
  return { query, answers, modesSet, launched, push, end: () => { ended = true; wake?.(); } };
}

function makeHost(f: ReturnType<typeof fakeClaude>, cap = "acceptEdits") {
  const host = new AgentHost({
    registry: new AgentRegistry(scratch()),
    query: f.query,
    resolveClaude: () => ({ path: "/fake/claude", realPath: "/fake/claude-2", fileId: "1:1:1" }),
    env: () => loginOnlyEnv({ PATH: "/usr/bin" }),
    emit: () => {},
    modeCap: modeCapFrom(cap),
  });
  const events = (id: string) => host.transcript(id).lines.filter((l) => l.from === "host").map((l) => l.message as Record<string, unknown>);
  return { host, events };
}

const refusal = (fn: () => unknown): { status: number; message: string } => {
  try {
    fn();
  } catch (e) {
    return { status: (e as { status: number }).status, message: (e as Error).message };
  }
  throw new Error("not refused");
};

describe("reading questions, plans and answers", () => {
  test("the questions of an AskUserQuestion call; anything not that shape is not guessed at", () => {
    expect(readQuestions(QUESTIONS)).toEqual([
      { question: "Which library should we use?", header: "Library", multiSelect: false, options: [{ label: "zod", description: "schemas" }, { label: "valibot", description: "smaller", preview: "v.object({})" }] },
      { question: "Which tests should run?", header: "Tests", multiSelect: true, options: [{ label: "unit", description: "fast" }, { label: "e2e", description: "slow" }] },
    ]);
    expect(readQuestions({})).toBeNull();
    expect(readQuestions({ questions: [] })).toBeNull();
    expect(readQuestions({ questions: [{ question: "Q?", options: [{ description: "no label" }] }] })).toBeNull();
    expect(readQuestions({ questions: [{ question: "Q?", options: [] }, { question: "Q?", options: [] }] })).toBeNull();
  });

  test("every question needs an answer, nothing else is taken, and own words count", () => {
    const qs = readQuestions(QUESTIONS)!;
    expect(checkAnswers(qs, { "Which library should we use?": "zod", "Which tests should run?": "unit, e2e" })).toBeNull();
    expect(checkAnswers(qs, { "Which library should we use?": "neither: write it by hand", "Which tests should run?": "unit" })).toBeNull();
    expect(checkAnswers(qs, { "Which library should we use?": "zod" })).toContain("has no answer");
    expect(checkAnswers(qs, { "Which library should we use?": "zod", "Which tests should run?": "  " })).toContain("has no answer");
    expect(checkAnswers(qs, { "Which library should we use?": "zod", "Which tests should run?": "unit", "Delete prod?": "yes" })).toContain("not one of the questions");
    expect(answersLine({ "A?": "x", "B?": "y, z" })).toBe("A?: x; B?: y, z");
  });

  test("the plan an ExitPlanMode call carries, with its file", () => {
    expect(readPlan(PLAN)).toEqual({ plan: PLAN.plan, file: PLAN.planFilePath });
    expect(readPlan({ plan: "  " })).toBeNull();
    expect(readPlan({})).toBeNull();
  });

  test("the new answer kinds are read; their shape is checked", () => {
    expect(parsePermissionAnswer({ decision: "answer", answers: { "Q?": "a" } })).toEqual({ decision: "answer", answers: { "Q?": "a" } });
    expect(parsePermissionAnswer({ decision: "answer", answers: { "Q?": 3 } })).toHaveProperty("error");
    expect(parsePermissionAnswer({ decision: "answer", answers: ["a"] })).toHaveProperty("error");
    expect(parsePermissionAnswer({ decision: "approve-plan", mode: "acceptEdits" })).toEqual({ decision: "approve-plan", mode: "acceptEdits" });
    expect(parsePermissionAnswer({ decision: "approve-plan" })).toHaveProperty("error");
  });
});

describe("one check for every change of mode", () => {
  const cap = modeCapFrom("acceptEdits");
  test("a mode the cap allows passes; above the cap is 403; into or out of Full access is 409", () => {
    expect(checkModeChange("default", "acceptEdits", cap)).toEqual({ ok: true, mode: "acceptEdits" });
    expect(checkModeChange("acceptEdits", "plan", cap)).toEqual({ ok: true, mode: "plan" });
    expect(checkModeChange("default", "acceptEdits", modeCapFrom("default"))).toMatchObject({ ok: false, status: 403 });
    expect(checkModeChange("default", "bypassPermissions", modeCapFrom("bypassPermissions"))).toMatchObject({ ok: false, status: 409 });
    expect(checkModeChange("bypassPermissions", "default", modeCapFrom("bypassPermissions"))).toMatchObject({ ok: false, status: 409 });
    expect(checkModeChange("default", "auto", cap)).toMatchObject({ ok: false, status: 400 });
  });

  test("the pickers never offer Full access, and say why", () => {
    const m = modesForChange(modesOffered(modeCapFrom("bypassPermissions")));
    expect(m.find((x) => x.mode === "bypassPermissions")).toMatchObject({ allowed: false, why: FULL_ACCESS_FIXED });
    expect(m.filter((x) => x.allowed).map((x) => x.mode)).toEqual(["plan", "dontAsk", "default", "acceptEdits"]);
  });
});

describe("the agent's question (#302)", () => {
  test("answered on the card: the call is allowed with the answers in its input, and the transcript keeps them", async () => {
    const f = fakeClaude({ asks: [{ tool: "AskUserQuestion", input: QUESTIONS }] });
    const { host, events } = makeHost(f);
    const a = host.start({ cwd: scratch(), prompt: "ask me" });
    await until(() => host.get(a.id).pendingPermissions.length === 1);
    const r = host.get(a.id).pendingPermissions[0].requestId;
    // A bare Allow would send no answer: refused, and the question still waits.
    expect(refusal(() => host.answer(a.id, r, { decision: "allow" }))).toMatchObject({ status: 400 });
    expect(refusal(() => host.answer(a.id, r, { decision: "answer", answers: { "Which library should we use?": "zod" } })).message).toContain("has no answer");
    expect(host.get(a.id).pendingPermissions.length).toBe(1);
    host.answer(a.id, r, { decision: "answer", answers: { "Which library should we use?": " zod ", "Which tests should run?": "unit, e2e" } });
    await until(() => f.answers.length === 1);
    const answers = { "Which library should we use?": "zod", "Which tests should run?": "unit, e2e" };
    expect(f.answers[0]).toEqual({ behavior: "allow", updatedInput: { ...QUESTIONS, answers } });
    expect(events(a.id).find((e) => e.event === "permission-answered")).toEqual({ event: "permission-answered", requestId: r, behavior: "allow", answers });
    f.end();
  });

  test("declined: the agent reads the message, as a deny", async () => {
    const f = fakeClaude({ asks: [{ tool: "AskUserQuestion", input: QUESTIONS }] });
    const { host } = makeHost(f);
    const a = host.start({ cwd: scratch(), prompt: "ask me" });
    await until(() => host.get(a.id).pendingPermissions.length === 1);
    host.answer(a.id, host.get(a.id).pendingPermissions[0].requestId, { decision: "deny", message: "pick yourself" });
    await until(() => f.answers.length === 1);
    expect(f.answers[0]).toEqual({ behavior: "deny", message: "pick yourself" });
    f.end();
  });

  test("answers are taken only for a question; a question the card cannot read keeps Allow", async () => {
    const f = fakeClaude({ asks: [{ tool: "Write", input: { file_path: "/x" } }, { tool: "AskUserQuestion", input: { questions: "?" } }] });
    const { host } = makeHost(f);
    const a = host.start({ cwd: scratch(), prompt: "go" });
    await until(() => host.get(a.id).pendingPermissions.length === 1);
    const w = host.get(a.id).pendingPermissions[0].requestId;
    expect(refusal(() => host.answer(a.id, w, { decision: "answer", answers: {} })).message).toContain("not a question");
    host.answer(a.id, w, { decision: "allow" });
    await until(() => host.get(a.id).pendingPermissions[0]?.toolName === "AskUserQuestion");
    host.answer(a.id, host.get(a.id).pendingPermissions[0].requestId, { decision: "allow" });
    await until(() => f.answers.length === 2);
    expect(f.answers[1]).toEqual({ behavior: "allow", updatedInput: { questions: "?" } });
    f.end();
  });
});

describe("the agent's plan (#303)", () => {
  async function planning(cap = "acceptEdits") {
    const f = fakeClaude({ asks: [{ tool: "ExitPlanMode", input: PLAN }] });
    const h = makeHost(f, cap);
    const a = h.host.start({ cwd: scratch(), prompt: "plan it", mode: "plan" });
    await until(() => h.host.get(a.id).pendingPermissions.length === 1);
    return { f, ...h, id: a.id, r: h.host.get(a.id).pendingPermissions[0].requestId };
  }

  test("approved into Accept edits: Claude Code is told in the answer, the agent records it, a resume keeps it", async () => {
    const p = await planning();
    // A bare Allow would leave it in Plan only: refused.
    expect(refusal(() => p.host.answer(p.id, p.r, { decision: "allow" }))).toMatchObject({ status: 400 });
    p.host.answer(p.id, p.r, { decision: "approve-plan", mode: "acceptEdits" });
    await until(() => p.f.answers.length === 1);
    expect(p.f.answers[0]).toEqual({ behavior: "allow", updatedInput: PLAN, updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] });
    expect(p.host.get(p.id).mode).toBe("acceptEdits");
    // Claude Code reports the wider mode: it is the agent's now, so it runs on.
    await until(() => p.host.get(p.id).permissionMode === "acceptEdits");
    p.f.push(init("acceptEdits"));
    await tick(40);
    expect(p.host.get(p.id).status).not.toBe("failed");
    expect(p.events(p.id).filter((e) => e.event === "mode-changed")).toEqual([{ event: "mode-changed", from: "plan", to: "acceptEdits", via: "plan approved" }]);
    expect(p.events(p.id).find((e) => e.event === "permission-answered")).toMatchObject({ behavior: "allow", mode: "acceptEdits" });
    expect(new AgentRegistry(p.host.registry.dir).load().find((x) => x.id === p.id)!.mode).toBe("acceptEdits");
    p.host.stop(p.id);
    await until(() => !p.host.get(p.id).running);
    p.host.resume(p.id, "go on");
    await until(() => p.f.launched.length === 2);
    expect(p.f.launched[1].permissionMode).toBe("acceptEdits");
    p.host.stop(p.id);
  });

  test("keep planning: the feedback reaches the agent as the deny message, and its mode stays Plan only", async () => {
    const p = await planning();
    p.host.answer(p.id, p.r, { decision: "deny", message: "split step 2" });
    await until(() => p.f.answers.length === 1);
    expect(p.f.answers[0]).toEqual({ behavior: "deny", message: "split step 2" });
    expect(p.host.get(p.id).mode).toBe("plan");
    p.f.end();
  });

  test("a mode above the cap, or Full access, is refused: the plan still waits and the agent stays in Plan only", async () => {
    const p = await planning("default");
    expect(refusal(() => p.host.answer(p.id, p.r, { decision: "approve-plan", mode: "acceptEdits" }))).toMatchObject({ status: 403 });
    expect(refusal(() => p.host.answer(p.id, p.r, { decision: "approve-plan", mode: "bypassPermissions" }))).toMatchObject({ status: 409 });
    expect(p.host.get(p.id).mode).toBe("plan");
    expect(p.host.get(p.id).pendingPermissions.length).toBe(1);
    expect(p.f.answers).toEqual([]);
    p.host.answer(p.id, p.r, { decision: "approve-plan", mode: "default" });
    await until(() => p.f.answers.length === 1);
    expect(p.host.get(p.id).mode).toBe("default");
    p.f.end();
  });

  test("approve-plan is taken only for a plan", async () => {
    const f = fakeClaude({ asks: [{ tool: "Write", input: { file_path: "/x" } }] });
    const { host } = makeHost(f);
    const a = host.start({ cwd: scratch(), prompt: "go" });
    await until(() => host.get(a.id).pendingPermissions.length === 1);
    expect(refusal(() => host.answer(a.id, host.get(a.id).pendingPermissions[0].requestId, { decision: "approve-plan", mode: "acceptEdits" })).message).toContain("not a plan");
    expect(host.get(a.id).mode).toBe("default");
    host.stop(a.id);
  });
});

describe("changing a running agent's mode (#306)", () => {
  async function running(mode: AgentMode = "default", cap = "acceptEdits", setFails = false) {
    const f = fakeClaude({ setFails });
    const h = makeHost(f, cap);
    const a = h.host.start({ cwd: scratch(), prompt: "work", mode, ...(mode === "bypassPermissions" ? { confirm: "I understand Full access runs every tool call without asking", githubAccess: h.host.githubAccess().status === "ok" ? (h.host.githubAccess() as { access: string }).access : undefined } : {}) });
    await until(() => h.host.get(a.id).status === "working");
    return { f, ...h, id: a.id };
  }

  test("Ask me to Accept edits: Claude Code gets the mode, the agent, its record and a resume keep it", async () => {
    const r = await running();
    const v = r.host.setMode(r.id, { mode: "acceptEdits" });
    expect(v.mode).toBe("acceptEdits");
    expect(r.f.modesSet).toEqual(["acceptEdits"]);
    await until(() => r.host.get(r.id).permissionMode === "acceptEdits");
    await until(() => r.events(r.id).some((e) => e.event === "mode-confirmed"));
    expect(r.events(r.id).filter((e) => e.event === "mode-changed")).toEqual([{ event: "mode-changed", from: "default", to: "acceptEdits", via: "changed on its card" }]);
    expect(new AgentRegistry(r.host.registry.dir).load().find((x) => x.id === r.id)!.mode).toBe("acceptEdits");
    r.host.stop(r.id);
    await until(() => !r.host.get(r.id).running);
    r.host.resume(r.id, "go on");
    await until(() => r.f.launched.length === 2);
    expect(r.f.launched[1].permissionMode).toBe("acceptEdits");
    r.host.stop(r.id);
  });

  test("above the cap: refused by the server, nothing sent to Claude Code, the mode unchanged", async () => {
    const r = await running("default", "default");
    expect(refusal(() => r.host.setMode(r.id, { mode: "acceptEdits" }))).toMatchObject({ status: 403 });
    expect(r.f.modesSet).toEqual([]);
    expect(r.host.get(r.id).mode).toBe("default");
    r.host.stop(r.id);
  });

  test("into Full access, or out of it, is refused: Full access is set when an agent starts", async () => {
    const r = await running("default", "bypassPermissions");
    expect(refusal(() => r.host.setMode(r.id, { mode: "bypassPermissions" }))).toMatchObject({ status: 409 });
    r.host.stop(r.id);
    const full = await running("bypassPermissions", "bypassPermissions");
    expect(full.f.launched[0].hasCallback).toBe(false);
    expect(refusal(() => full.host.setMode(full.id, { mode: "default" }))).toMatchObject({ status: 409 });
    expect(full.f.modesSet).toEqual([]);
    full.host.stop(full.id);
  });

  test("a stopped agent's mode is not changed", async () => {
    const r = await running();
    r.host.stop(r.id);
    await until(() => !r.host.get(r.id).running);
    expect(refusal(() => r.host.setMode(r.id, { mode: "acceptEdits" }))).toMatchObject({ status: 409 });
    expect(r.host.get(r.id).mode).toBe("default");
  });

  test("Claude Code refusing the mode puts the agent back in the one it had, and says so", async () => {
    const r = await running("default", "acceptEdits", true);
    r.host.setMode(r.id, { mode: "acceptEdits" });
    await until(() => r.host.get(r.id).mode === "default");
    expect(r.events(r.id).find((e) => e.event === "mode-change-failed")).toMatchObject({ from: "default", to: "acceptEdits", reason: "Claude Code refused the mode" });
    r.host.stop(r.id);
  });
});

describe("the safety check follows the mode the agent has now", () => {
  test("a status message reporting a wider mode than the agent's stops it at once", async () => {
    const f = fakeClaude();
    const { host } = makeHost(f);
    const a = host.start({ cwd: scratch(), prompt: "work" });
    await until(() => host.get(a.id).status === "working");
    f.push(status("acceptEdits"));
    await until(() => host.get(a.id).status === "failed");
    expect(host.get(a.id).reason).toContain('reported permission mode "acceptEdits", wider than the Ask me it was given');
  });

  test("moved to a narrower mode: the old one passes until Claude Code confirms, never after", async () => {
    const f = fakeClaude();
    const { host } = makeHost(f);
    const a = host.start({ cwd: scratch(), prompt: "work", mode: "acceptEdits" });
    await until(() => host.get(a.id).status === "working");
    // Claude Code reports the old mode before the move lands: not a breach.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const live = (host as unknown as { live: Map<string, { query: { setPermissionMode: (m: string) => Promise<void> } }> }).live.get(a.id)!;
    const real = live.query.setPermissionMode;
    live.query.setPermissionMode = async (m) => {
      await held;
      return real(m);
    };
    host.setMode(a.id, { mode: "plan" });
    expect(refusal(() => host.setMode(a.id, { mode: "default" })).message).toContain("still on its way");
    f.push(init("acceptEdits"));
    await tick(40);
    expect(host.get(a.id).status).toBe("working");
    release();
    await until(() => host.get(a.id).permissionMode === "plan");
    await tick(20);
    // Confirmed: the old, wider mode is a breach from now on.
    f.push(init("acceptEdits"));
    await until(() => host.get(a.id).status === "failed");
    expect(host.get(a.id).reason).toContain("wider than the Plan only it was given");
  });
});

describe("the old mode's allowance ends when the change is confirmed", () => {
  test("confirmed by setPermissionMode alone, with no status message: the old, wider mode stops it", async () => {
    const f = fakeClaude();
    const { host } = makeHost(f);
    const a = host.start({ cwd: scratch(), prompt: "work", mode: "acceptEdits" });
    await until(() => host.get(a.id).status === "working");
    const live = (host as unknown as { live: Map<string, { query: { setPermissionMode: (m: string) => Promise<void> } }> }).live.get(a.id)!;
    live.query.setPermissionMode = async () => {};
    host.setMode(a.id, { mode: "default" });
    await tick(20);
    f.push(init("acceptEdits"));
    await until(() => host.get(a.id).status === "failed");
    expect(host.get(a.id).reason).toContain("wider than the Ask me it was given");
  });
});

describe("the routes", () => {
  const HOST = "localhost:4476";
  function server(f: ReturnType<typeof fakeClaude>) {
    const h = makeHost(f);
    const log = new ActionLog(scratch());
    const app = new Hono();
    installGuard(app, { bind: "127.0.0.1", log, isFromApp });
    app.route("/api/agents", agentRoutes(h.host, async () => ({ ok: true }) as never));
    const viaApp = async (path: string, body: unknown) => dispatch(app, { method: "POST", path, body }, HOST);
    const overHttp = (path: string, body: unknown) =>
      app.request(`http://${HOST}${path}`, { method: "POST", headers: { host: HOST, "content-type": "application/json", origin: `http://${HOST}` }, body: JSON.stringify(body) });
    const lines = (): ActionRecord[] => readFileSync(log.file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return { ...h, viaApp, overHttp, lines };
  }

  test("a mode change is a guarded write, logged with the mode it left and the one asked", async () => {
    const f = fakeClaude();
    const s = server(f);
    const a = s.host.start({ cwd: scratch(), prompt: "work" });
    await until(() => s.host.get(a.id).status === "working");
    const path = `/api/agents/${a.id}/mode`;
    expect((await s.overHttp(path, { mode: "acceptEdits" })).status).toBe(403);
    expect(s.host.get(a.id).mode).toBe("default");
    const ok = await s.viaApp(path, { mode: "acceptEdits" });
    expect(ok.status).toBe(200);
    expect((ok.body as { mode: string }).mode).toBe("acceptEdits");
    const log = s.lines().filter((l) => l.path === path);
    expect(log.map((l) => [l.status, l.result])).toEqual([[403, "refused"], [200, "accepted"]]);
    expect(log[1].detail).toEqual({ from: "default", to: "acceptEdits" });
    s.host.stop(a.id);
  });

  test("the answers given and the mode a plan is approved in are in the action log", async () => {
    const f = fakeClaude({ asks: [{ tool: "AskUserQuestion", input: QUESTIONS }, { tool: "ExitPlanMode", input: PLAN }] });
    const s = server(f);
    const a = s.host.start({ cwd: scratch(), prompt: "go", mode: "plan" });
    await until(() => s.host.get(a.id).pendingPermissions.length === 1);
    const q = s.host.get(a.id).pendingPermissions[0].requestId;
    const answers = { "Which library should we use?": "zod", "Which tests should run?": "unit" };
    expect((await s.viaApp(`/api/agents/${a.id}/permissions/${q}`, { decision: "answer", answers })).status).toBe(200);
    await until(() => s.host.get(a.id).pendingPermissions[0]?.toolName === "ExitPlanMode");
    const p = s.host.get(a.id).pendingPermissions[0].requestId;
    expect((await s.viaApp(`/api/agents/${a.id}/permissions/${p}`, { decision: "approve-plan", mode: "acceptEdits" })).status).toBe(200);
    const log = s.lines().filter((l) => l.path.includes("/permissions/"));
    expect(log.map((l) => l.detail)).toEqual([
      { decision: "answer", answers: "Which library should we use?: zod; Which tests should run?: unit" },
      { decision: "approve-plan", mode: "acceptEdits" },
    ]);
    s.host.stop(a.id);
  });
});
