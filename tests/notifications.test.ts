// Desktop notifications (#314): which moments of an agent's run need you, the setting that turns
// each kind on or off, and the line the server hands the desktop app. Whether the app shows it
// (only while its window is not in front) and where a click goes are the app's: observed in the
// app, not here.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentHost, type QueryFn } from "../server/agents/host";
import { AgentRegistry } from "../server/agents/registry";
import { loginOnlyEnv } from "../server/agents/login";
import { buildApp } from "../server/app";
import { dispatch } from "../server/desktop";
import { ActionLog } from "../server/action-log";
import { readNotify, writeNotify } from "../server/notify";
import { modeCapFrom } from "../shared/agent-modes";
import { DEFAULT_NOTIFY, noticesFor, type Notice, type NoticeAgent } from "../shared/notifications";

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "notify-"));
  dirs.push(d);
  return d;
};
const stops: (() => void)[] = [];
afterAll(() => {
  for (const s of stops) s();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await tick();
  }
}

// ── which moments need you ──────────────────────────────────────────────────────────────────

const agent = (o: Partial<NoticeAgent> = {}): NoticeAgent => ({ id: "a-1", prompt: "fix the login page", issue: 12, status: "working", pendingPermissions: [], ...o });
const ask = (requestId: string, toolName = "Bash", subagent?: { id: string; type?: string }) => ({ requestId, toolName, ...(subagent ? { subagent } : {}) });

describe("noticesFor (#314)", () => {
  test("a new request is a permission notice naming the tool, never its input", () => {
    const n = noticesFor(agent(), agent({ status: "waiting", pendingPermissions: [ask("r1")] }));
    expect(n).toEqual([{ agentId: "a-1", kind: "permission", key: "r1", title: "#12 · fix the login page", body: "The agent asks to use Bash." }]);
  });

  test("a request already seen is not told again; a second one is", () => {
    const one = agent({ status: "waiting", pendingPermissions: [ask("r1")] });
    expect(noticesFor(one, one)).toEqual([]);
    const two = agent({ status: "waiting", pendingPermissions: [ask("r1"), ask("r2", "Write")] });
    expect(noticesFor(one, two).map((n) => [n.key, n.body])).toEqual([["r2", "The agent asks to use Write."]]);
  });

  test("a question and a plan are the question kind; a subagent's ask says whose", () => {
    const n = noticesFor(agent(), agent({ pendingPermissions: [ask("q", "AskUserQuestion"), ask("p", "ExitPlanMode"), ask("s", "Read", { id: "x", type: "Explore" })] }));
    expect(n.map((x) => [x.kind, x.body])).toEqual([
      ["question", "The agent asks you a question."],
      ["question", "The agent asks you to approve its plan."],
      ["permission", "Explore (subagent) asks to use Read."],
    ]);
  });

  test("a run that ends is told: finished, failed with why, stopped by something else; your own Stop is not", () => {
    expect(noticesFor(agent(), agent({ status: "done" })).map((n) => n.body)).toEqual(["The agent finished its turn."]);
    expect(noticesFor(agent({ status: "waiting" }), agent({ status: "failed", reason: "Claude Code stopped with an error: boom" })).map((n) => n.body)).toEqual([
      "The agent failed: Claude Code stopped with an error: boom",
    ]);
    expect(noticesFor(agent(), agent({ status: "stopped", reason: "its Claude Code process was killed" })).map((n) => n.body)).toEqual(["The agent was stopped: its Claude Code process was killed"]);
    // Quitting the app (or stopping its server) is yours too: no notification as you quit.
    expect(noticesFor(agent(), agent({ status: "stopped", reason: "AnviDeck app closed" }))).toEqual([]);
    expect(noticesFor(agent(), agent({ status: "stopped", reason: "AnviDeck shut down" }))).toEqual([]);
    expect(noticesFor(agent(), agent({ status: "stopped", reason: "stopped by you" }))).toEqual([]);
    expect(noticesFor(agent(), agent({ status: "stopped", reason: "stopped by you after its result; the result stands" }))).toEqual([]);
  });

  test("an end not seen happen (first view, or ended before) is not told", () => {
    expect(noticesFor(undefined, agent({ status: "done" }))).toEqual([]);
    expect(noticesFor(agent({ status: "done" }), agent({ status: "done" }))).toEqual([]);
    expect(noticesFor(agent({ status: "failed" }), agent({ status: "stopped", reason: "x" }))).toEqual([]);
  });

  test("a first view's waiting request is told", () => {
    expect(noticesFor(undefined, agent({ pendingPermissions: [ask("r1")] })).map((n) => n.kind)).toEqual(["permission"]);
  });

  test("a long failure reason is cut short", () => {
    const [n] = noticesFor(agent(), agent({ status: "failed", reason: "x".repeat(500) }));
    expect(n.body.length).toBe(140);
    expect(n.body.endsWith("…")).toBe(true);
  });
});

// ── the setting ─────────────────────────────────────────────────────────────────────────────

describe("the notification setting (#314)", () => {
  test("no file is the default, every kind on", () => {
    const d = scratch();
    expect(readNotify(d)).toMatchObject({ status: "ok", source: "default", settings: DEFAULT_NOTIFY });
  });

  test("set keeps the other settings in the file, and reads back", () => {
    const d = scratch();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ agentGithubAccess: "none" }));
    writeNotify(d, { permission: true, question: false, ended: true }, new Date("2026-11-21T10:00:00Z"));
    const j = JSON.parse(readFileSync(join(d, "settings.json"), "utf8"));
    expect(j.agentGithubAccess).toBe("none");
    expect(readNotify(d)).toMatchObject({ status: "ok", source: "set", setAt: "2026-11-21T10:00:00.000Z", settings: { permission: true, question: false, ended: true } });
  });

  test("a broken file or a value not true or false is said, never guessed; a broken file is not written over", () => {
    const d = scratch();
    writeFileSync(join(d, "settings.json"), "{not json");
    expect(readNotify(d)).toMatchObject({ status: "unreadable" });
    expect(() => writeNotify(d, DEFAULT_NOTIFY)).toThrow(/fix or move it first/);
    expect(readFileSync(join(d, "settings.json"), "utf8")).toBe("{not json");
    writeFileSync(join(d, "settings.json"), JSON.stringify({ notifications: { ended: "yes" } }));
    expect(readNotify(d)).toMatchObject({ status: "unreadable", reason: 'notifications.ended is "yes", not true or false' });
  });
});

// ── the server end to end: a fake agent's moments become NOTIFY lines ──────────────────────

const init = { type: "system", subtype: "init", apiKeySource: "none", session_id: "s1", claude_code_version: "2", model: "m", cwd: "/x", tools: [], mcp_servers: [], permissionMode: "default", slash_commands: [], output_style: "default", uuid: "u" } as unknown as SDKMessage;
const ok = { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, num_turns: 1, duration_ms: 1, duration_api_ms: 1, stop_reason: "end_turn", usage: {}, modelUsage: {}, session_id: "s1", uuid: "r" } as unknown as SDKMessage;

/** A fake Claude Code whose turn asks for each tool in `asks` in turn, then reports success. */
function fakeClaude(asks: string[]): QueryFn {
  return ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const it = prompt[Symbol.asyncIterator]();
    const gen = (async function* () {
      if ((await it.next()).done) return;
      yield init;
      for (const t of asks) await options.canUseTool!(t, t === "AskUserQuestion" ? { questions: [] } : { command: "make" }, { signal: new AbortController().signal } as never);
      yield ok;
    })();
    return Object.assign(gen, { setPermissionMode: async () => {}, close: () => {} }) as unknown as ReturnType<QueryFn>;
  };
}

async function desktopApp(asks: string[], o: { desktop?: boolean; withSink?: boolean } = {}) {
  const dir = scratch();
  const sent: Notice[] = [];
  let host!: AgentHost;
  const makeAgentHost = () =>
    (host = new AgentHost({
      registry: new AgentRegistry(dir),
      query: fakeClaude(asks),
      resolveClaude: () => ({ path: "/fake/claude", realPath: "/fake/claude-2", fileId: "1:1:1" }),
      env: () => loginOnlyEnv({ PATH: "/usr/bin" }),
      emit: () => {},
      modeCap: modeCapFrom("acceptEdits"),
      messageWaitMs: 100,
      exitGraceMs: 100,
    }));
  const { app, agents } = await buildApp({
    bind: "127.0.0.1",
    desktop: o.desktop ?? true,
    log: new ActionLog(dir),
    makeAgentHost,
    ...(o.withSink === false ? {} : { notify: (n: Notice) => sent.push(n) }),
  });
  stops.push(() => agents.stopAll("test over"));
  const w = (path: string, body?: unknown) => dispatch(app, { method: "POST", path, body }, "127.0.0.1:4999");
  return { app, host, dir, sent, w };
}

describe("the server tells the app when an agent needs you (#314)", () => {
  test("a fake agent's permission request, then its end, each reach the app once, in order", async () => {
    const { host, sent, w } = await desktopApp(["Bash"]);
    const a = host.start({ cwd: scratch(), prompt: "build the thing" });
    await until(() => host.get(a.id).pendingPermissions.length === 1);
    await tick(30);
    expect(sent.map((n) => [n.agentId, n.kind, n.body])).toEqual([[a.id, "permission", "The agent asks to use Bash."]]);
    const req = host.get(a.id).pendingPermissions[0];
    const r = await w(`/api/agents/${a.id}/permissions/${req.requestId}`, { decision: "allow" });
    expect(r.status).toBe(200);
    await until(() => host.get(a.id).status === "done");
    await tick(30);
    expect(sent.map((n) => n.kind)).toEqual(["permission", "ended"]);
    expect(sent[1].body).toBe("The agent finished its turn.");
  });

  test("a question is its own kind; turned off, nothing of it is sent, and the others still are", async () => {
    const { host, sent, w } = await desktopApp(["AskUserQuestion"]);
    const off = await w("/api/agents/settings/notifications", { question: false });
    expect(off.status).toBe(200);
    expect((off.body as { setting: { settings: unknown } }).setting.settings).toEqual({ permission: true, question: false, ended: true });
    const a = host.start({ cwd: scratch(), prompt: "ask me" });
    await until(() => host.get(a.id).pendingPermissions.length === 1);
    await tick(30);
    expect(sent).toEqual([]);
    host.stop(a.id, "Claude Code was killed");
    await until(() => host.get(a.id).status === "stopped");
    expect(sent.map((n) => [n.kind, n.body])).toEqual([["ended", "The agent was stopped: Claude Code was killed"]]);
  });

  test("your own Stop is not notified", async () => {
    const { host, sent } = await desktopApp(["Bash"]);
    const a = host.start({ cwd: scratch(), prompt: "x" });
    await until(() => host.get(a.id).pendingPermissions.length === 1);
    await tick(30);
    host.stop(a.id);
    await until(() => host.get(a.id).status === "stopped");
    await tick(30);
    expect(sent.map((n) => n.kind)).toEqual(["permission"]);
  });

  test("another server's agent is not notified here", async () => {
    const { host, sent } = await desktopApp([]);
    // As the watch of other servers' agents pushes it (#223): owner is another instance.
    const other = { id: "b-9", prompt: "p", status: "working", pendingPermissions: [], owner: { pid: 1, instance: "someone-else" } };
    const emit = (host as unknown as { emitFn: (e: unknown) => void }).emitFn;
    emit({ type: "agent", data: other });
    emit({ type: "agent", data: { ...other, status: "waiting", pendingPermissions: [{ requestId: "r", toolName: "Bash", input: {}, askedAt: "" }] } });
    emit({ type: "agent", data: { ...other, status: "done", pendingPermissions: [] } });
    expect(sent).toEqual([]);
  });

  test("the setting route takes only the three kinds, each true or false, and is logged", async () => {
    const { app, w } = await desktopApp([]);
    expect((await w("/api/agents/settings/notifications", {})).status).toBe(400);
    expect((await w("/api/agents/settings/notifications", { sound: true })).status).toBe(400);
    expect((await w("/api/agents/settings/notifications", { ended: "no" })).status).toBe(400);
    expect((await w("/api/agents/settings/notifications", { ended: false })).status).toBe(200);
    const got = await (await app.fetch(new Request("http://127.0.0.1:4999/api/agents", { headers: { host: "127.0.0.1:4999" } }))).json();
    expect(got.notifications.setting).toMatchObject({ status: "ok", source: "set", settings: { permission: true, question: true, ended: false } });
    expect(got.notifications.kinds.map((k: { kind: string }) => k.kind)).toEqual(["permission", "question", "ended"]);
    const log = await (await app.fetch(new Request("http://127.0.0.1:4999/api/actions", { headers: { host: "127.0.0.1:4999" } }))).json();
    const line = JSON.stringify(log);
    expect(line).toContain("ended on");
    expect(line).toContain("ended off");
  });

  test("an unreadable setting does not silence anything: notices go out as by default", async () => {
    const { host, sent, dir } = await desktopApp(["Bash", "Write"]);
    const a = host.start({ cwd: scratch(), prompt: "x" });
    await until(() => host.get(a.id).pendingPermissions.length === 1);
    // Broken after the start (a broken file refuses a start, #147), before the second request.
    writeFileSync(join(dir, "settings.json"), "{broken");
    const first = host.get(a.id).pendingPermissions[0];
    host.answer(a.id, first.requestId, { decision: "allow" });
    await until(() => host.get(a.id).pendingPermissions.some((p) => p.toolName === "Write"));
    await tick(30);
    expect(sent.map((n) => n.body)).toEqual(["The agent asks to use Bash.", "The agent asks to use Write."]);
  });

  test("without the desktop app (the browser build) nothing is sent anywhere; with it, the line goes to the app's channel", async () => {
    const lines = async (desktop: boolean) => {
      const out: string[] = [];
      const real = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        out.push(String(chunk));
        return (real as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof process.stdout.write;
      try {
        const { host } = await desktopApp(["Bash"], { desktop, withSink: false });
        const a = host.start({ cwd: scratch(), prompt: "x" });
        await until(() => host.get(a.id).pendingPermissions.length === 1);
        await tick(30);
      } finally {
        process.stdout.write = real;
      }
      return out.filter((l) => l.includes("ANVIDECK-NOTIFY"));
    };
    expect(await lines(false)).toEqual([]);
    const app = await lines(true);
    expect(app.length).toBe(1);
    expect(app[0].startsWith("\u001eANVIDECK-NOTIFY {")).toBe(true);
    expect(JSON.parse(app[0].slice(app[0].indexOf("{")))).toMatchObject({ kind: "permission", body: "The agent asks to use Bash." });
  });
});
