// The Agents screen (#82): its model (timeline, plan, refusals, hook joins, tabs) and its reader.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentTabs,
  buildTimeline,
  gridAgents,
  parseAgentsScreenParams,
  parseRefusal,
  planFrom,
  sourceLine,
  toolTarget,
  type HostAgent,
  type TLine,
  type ToolCall,
} from "../ui/components/agents-model";
import { readAgentSession, trimRecord } from "../server/readers/agent-session";
import { agentsScreenRoutes } from "../server/routes/agents-screen";
import { TOOL_RESULT_MAX_CHARS } from "../shared/agents-screen-types";
import { DIVERGENCE, LAYER } from "./fixtures/refusals";

const ROOT = join(import.meta.dir, "..");
const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "agents-screen-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// ── helpers to write transcript lines ─────────────────────────────────────────────────────

const T0 = Date.parse("2026-11-05T10:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const use = (s: number, id: string, name: string, input: Record<string, unknown>, from: TLine["from"] = "sdk"): TLine => ({
  at: at(s), from, message: { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } },
});
const result = (s: number, id: string, content: unknown, isError = false, from: TLine["from"] = "sdk"): TLine => ({
  at: at(s), from, message: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } },
});
const say = (s: number, text: string, from: TLine["from"] = "sdk"): TLine => ({ at: at(s), from, message: { type: "assistant", message: { content: [{ type: "text", text }] } } });
const host = (s: number, message: Record<string, unknown>): TLine => ({ at: at(s), from: "host", message });
const meter = (s: number, hook: string, event = "PreToolUse", outcome = "silent", bytes = 0) => ({ ts: at(s), hook, event, outcome, bytes });
const tool = (tl: { tools: ToolCall[] }, id: string) => tl.tools.find((t) => t.id === id)!;

// ── refusals ──────────────────────────────────────────────────────────────────────────────

describe("refusal card: read from the guard's own text", () => {
  test("a divergence refusal (real stave text): layer path, rule, design id, first remedy", () => {
    const r = parseRefusal(DIVERGENCE)!;
    expect(r.file).toBe("src/engine/StrudelEngine.ts");
    expect(r.pkg).toBe("editor");
    expect(r.designId).toBe("cffdf7d00026");
    expect(r.violations).toEqual([
      {
        rule: "divergence",
        fromFile: "src/engine/StrudelEngine.ts",
        toFile: "src/monaco/docs/strudelNotInStave.ts",
        fromLayer: "engine",
        toLayer: "monaco",
        detail: "engine imports monaco, which the design does not declare",
      },
    ]);
    expect(r.remedy).toStartWith("divergence engine -> monaco — either change the code: engine may import codeView, ir, perf");
    // The whole text the agent read is kept, from the guard's first word.
    expect(r.text).toStartWith("BLOCKED: this edit to src/engine/StrudelEngine.ts");
    expect(DIVERGENCE.endsWith(r.text)).toBe(true);
  });

  test("a layer refusal (real anvi text, no design id): layers named as the guard named them", () => {
    const r = parseRefusal(LAYER)!;
    expect(r.violations).toEqual([
      { rule: "layer", fromFile: "src/ir/steppedAutomation.ts", toFile: "src/engine/StrudelEngine.ts", fromLayer: "layer 0", toLayer: "layer 2", detail: "layer 0 imports layer 2" },
    ]);
    expect(r.designId).toBeUndefined();
    expect(r.remedy).toBe("layer — move the code to a layer allowed to depend on the target, or depend on something lower");
  });

  test("not a refusal: other hook errors and ordinary output are not refusal cards", () => {
    expect(parseRefusal("PreToolUse:Bash hook error: shell rewrite refused")).toBeNull();
    expect(parseRefusal("File created successfully at: /x")).toBeNull();
  });

  test("two violations in one refusal are both shown", () => {
    const two = LAYER.replace(
      "      layer 0 imports layer 2\n",
      "      layer 0 imports layer 2\n  · cycle: src/a.ts -> src/b.ts\n      part of a cycle\n",
    );
    expect(parseRefusal(two)!.violations.map((v) => v.rule)).toEqual(["layer", "cycle"]);
  });
});

// ── the timeline ──────────────────────────────────────────────────────────────────────────

describe("timeline: tool calls, their results and their state", () => {
  test("a call and its result are joined by id; states: ok, error, refused, blocked by a hook", () => {
    const tl = buildTimeline({
      lines: [
        use(1, "a", "Bash", { command: "ls" }), result(2, "a", "one.txt"),
        use(3, "b", "Bash", { command: "false" }), result(4, "b", "exit 1", true),
        use(5, "c", "Edit", { file_path: "/p/src/engine/StrudelEngine.ts" }), result(6, "c", DIVERGENCE, true),
        use(7, "d", "Bash", { command: "rm x" }), result(8, "d", "PreToolUse:Bash hook error: refused by a guard", true),
      ],
      cwd: "/p",
    });
    expect(tl.tools.map((t) => [t.id, t.state])).toEqual([["a", "ok"], ["b", "error"], ["c", "refused"], ["d", "blocked"]]);
    expect(tool(tl, "c").target).toBe("src/engine/StrudelEngine.ts");
    expect(tl.refusals.map((r) => r.tool.id)).toEqual(["c"]);
    expect(tool(tl, "c").refusal!.violations[0].toLayer).toBe("monaco");
  });

  test("a call with no result is running while the agent runs, and 'no result' once it stopped", () => {
    const lines = [use(1, "a", "Write", { file_path: "/p/x" })];
    expect(buildTimeline({ lines, live: true }).tools[0].state).toBe("running");
    expect(buildTimeline({ lines, live: false }).tools[0].state).toBe("no-result");
  });

  test("an error result whose text only mentions a refusal is not a refusal card unless the guard's text is in it", () => {
    const tl = buildTimeline({ lines: [use(1, "a", "Bash", { command: "cat log" }), result(2, "a", "the log says nothing was BLOCKED")] });
    expect(tool(tl, "a").state).toBe("ok");
    expect(tl.refusals).toEqual([]);
  });

  test("the owner's words: host events for an AnviDeck agent, typed prompts for a terminal session", () => {
    const hostTl = buildTimeline({
      lines: [
        host(0, { event: "started", prompt: "list the files" }),
        { at: at(0), from: "sdk", message: { type: "user", message: { content: "list the files" } } },
        host(5, { event: "message-sent", messageId: "m1", said: "also say hi", text: "also say hi" }),
        host(6, { event: "message-delivered", messageId: "m1", by: "started" }),
        host(7, { event: "message-sent", messageId: "m2", said: "late", text: "late" }),
        host(8, { event: "message-not-delivered", messageId: "m2", reason: "the agent's run ended" }),
      ],
    });
    const you = hostTl.items.filter((i) => i.kind === "you");
    // The SDK's echo of the prompt is not shown twice.
    expect(you.map((y) => [y.text, y.kind === "you" ? y.state : null])).toEqual([
      ["list the files", undefined],
      ["also say hi", "delivered"],
      ["late", "not-delivered"],
    ]);
    const cliTl = buildTimeline({
      lines: [
        { at: at(0), from: "cli", message: { type: "user", message: { content: "fix the bug" } } },
        { at: at(1), from: "cli", message: { type: "user", message: { content: "<command-name>/clear</command-name>" } } },
        { at: at(2), from: "cli", message: { type: "user", message: { content: [{ type: "text", text: "and test it" }] } } },
      ],
    });
    expect(cliTl.items.map((i) => (i.kind === "you" ? i.text : i.kind))).toEqual(["fix the bug", "and test it"]);
  });

  test("a permission request belongs to the open call with the same tool and input; a deny makes it denied", () => {
    const input = { file_path: "/p/hello.txt", content: "hi\n" };
    const lines = [
      // The asked-about call is not the newest open Write: only its input names it.
      use(1, "w2", "Write", input),
      use(2, "w1", "Write", { file_path: "/p/other.txt", content: "x" }),
      host(3, { event: "permission-asked", requestId: "r1", toolName: "Write", input }),
      host(4, { event: "permission-answered", requestId: "r1", behavior: "deny", message: "not now" }),
      result(5, "w2", "denied", true),
    ];
    const tl = buildTimeline({ lines });
    expect(tool(tl, "w2").permission).toEqual({ requestId: "r1", answer: "deny", message: "not now", reason: undefined });
    expect(tool(tl, "w2").state).toBe("denied");
    expect(tool(tl, "w1").permission).toBeUndefined();
    // A request that matches no call is still shown, never dropped.
    const lone = buildTimeline({ lines: [host(1, { event: "permission-asked", requestId: "r9", toolName: "Bash", input: { command: "x" } })] });
    expect(lone.items).toHaveLength(1);
    expect(lone.items[0].kind).toBe("event");
  });
});

describe("what anvi did at each call: three sources, each joined its own way", () => {
  test("context from Claude Code's transcript is joined by the call's id; session context is listed apart; strays are counted", () => {
    const tl = buildTimeline({
      lines: [use(1, "e1", "Edit", { file_path: "/p/a.ts" }), result(3, "e1", "ok"), use(4, "e2", "Edit", { file_path: "/p/b.ts" }), result(5, "e2", "ok")],
      attachments: [
        { at: at(2), line: 9, type: "attachment", attachment: { type: "hook_additional_context", hookName: "PreToolUse:Edit", toolUseID: "e2", content: ["Boundary B4: 3 error patterns"] } },
        { at: at(2), line: 10, type: "attachment", attachment: { type: "hook_success", hookName: "PreToolUse:Edit", toolUseID: "e2", command: 'node "/h/catalogue-context-injector.js"', stdout: "{}", durationMs: 40, hookEvent: "PreToolUse" } },
        { at: at(0), line: 2, type: "attachment", attachment: { type: "hook_additional_context", hookName: "SessionStart", toolUseID: "SessionStart", content: ["HEALTH: ok"] } },
        { at: at(2), line: 11, type: "attachment", attachment: { type: "hook_additional_context", hookName: "PreToolUse:Edit", toolUseID: "toolu_gone", content: ["?"] } },
      ],
    });
    expect(tool(tl, "e1").context).toEqual([]);
    expect(tool(tl, "e2").context).toEqual([{ hook: "PreToolUse:Edit", text: "Boundary B4: 3 error patterns", chars: 29 }]);
    expect(tool(tl, "e2").hooks).toEqual([{ source: "transcript", name: "catalogue-context-injector.js", event: "PreToolUse", outcome: "ran, gave output", ms: 40 }]);
    expect(tl.sessionContext.map((c) => c.text)).toEqual(["HEALTH: ok"]);
    expect(tl.unplaced.context).toBe(1);
  });

  test("meter rows go on the one call open at that moment; a later call recorded after the row is not its call", () => {
    // Observed on a real agent: Bash 18.484→18.716, its hooks at 18.56, the next Write recorded at 19.027.
    const tl = buildTimeline({
      lines: [use(18.484, "b", "Bash", { command: "ls" }), result(18.716, "b", "x"), use(19.027, "w", "Write", { file_path: "/p/h" })],
      meter: [meter(18.56, "shell-rewrite-guard.js"), meter(19.1, "structure-guard-hook.js")],
      live: true,
    });
    expect(tool(tl, "b").hooks.map((h) => h.name)).toEqual(["shell-rewrite-guard.js"]);
    expect(tool(tl, "w").hooks.map((h) => h.name)).toEqual(["structure-guard-hook.js"]);
    expect(tl.unplaced.meter).toBe(0);
  });

  test("a row while two calls are open is not guessed: it is counted as not placed", () => {
    const tl = buildTimeline({
      lines: [use(1, "a", "Read", { file_path: "/p/a" }), use(1.01, "b", "Read", { file_path: "/p/b" }), result(3, "a", "x"), result(3, "b", "y")],
      meter: [meter(1.5, "tree-lock-guard.js")],
    });
    expect(tool(tl, "a").hooks).toEqual([]);
    expect(tool(tl, "b").hooks).toEqual([]);
    expect(tl.unplaced.meter).toBe(1);
  });

  test("session hooks are not tool calls' and not counted as strays; a subagent's hook runs are not put on its Agent call", () => {
    const tl = buildTimeline({
      lines: [use(1, "ag", "Agent", { description: "research" }), result(60, "ag", "done")],
      meter: [meter(0.5, "named-entry-delivery.js", "UserPromptSubmit"), meter(10, "tree-lock-guard.js")],
    });
    expect(tool(tl, "ag").hooks).toEqual([]);
    expect(tl.unplaced.meter).toBe(1);
  });

  test("totals count placed meter runs: informed, bytes, blocked", () => {
    const tl = buildTimeline({
      lines: [use(1, "e", "Edit", { file_path: "/p/a.ts" }), result(2, "e", "ok")],
      meter: [meter(1.1, "catalogue-context-injector.js", "PreToolUse", "informed", 900), meter(1.2, "structure-guard-hook.js", "PreToolUse", "blocked", 0), meter(1.3, "x.js")],
    });
    expect(tl.hookTotals).toEqual({ runs: 3, informed: 1, bytes: 900, blocked: 1 });
  });

  test("hook-log rows go on the call that edited that file at that time; others are counted", () => {
    const tl = buildTimeline({
      lines: [use(1, "e1", "Edit", { file_path: "/p/src/a.ts" }), result(2, "e1", "ok"), use(10, "e2", "Edit", { file_path: "/p/src/a.ts" }), result(11, "e2", "ok")],
      hookLog: [
        { ts: at(10.1), file: "src/a.ts", boundaries: ["B1"], fatality: false, patterns: ["p"], invariants: [] },
        { ts: at(10.2), file: "src/zzz.ts", boundaries: [], fatality: false, patterns: [], invariants: [] },
      ],
    });
    expect(tool(tl, "e1").hookLog).toEqual([]);
    expect(tool(tl, "e2").hookLog.map((r) => r.boundaries)).toEqual([["B1"]]);
    expect(tl.unplaced.hookLog).toBe(1);
  });
});

describe("plan with progress, from the agent's own plan calls", () => {
  const t = (name: string, input: Record<string, unknown>, res?: string): ToolCall => ({
    kind: "tool", id: Math.random().toString(36), name, input, target: "", at: at(1), state: "ok", hooks: [], context: [], hookLog: [],
    ...(res ? { result: { at: at(2), isError: false, text: res } } : {}),
  });

  test("TodoWrite replaces the whole list; progress counts completed items", () => {
    const p = planFrom([
      t("TodoWrite", { todos: [{ content: "a", status: "pending" }] }),
      t("TodoWrite", { todos: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c", status: "pending" }] }),
    ])!;
    expect(p.source).toBe("TodoWrite");
    expect(p.items).toEqual([{ text: "a", status: "completed" }, { text: "b", status: "in_progress" }, { text: "c", status: "pending" }]);
    expect([p.done, p.total]).toEqual([1, 3]);
  });

  test("TaskCreate adds by the number Claude Code gave it; TaskUpdate changes or deletes it", () => {
    const p = planFrom([
      t("TaskCreate", { subject: "measure" }, "Task #1 created successfully: measure"),
      t("TaskCreate", { subject: "fix" }, "Task #2 created successfully: fix"),
      t("TaskCreate", { subject: "drop me" }, "Task #3 created successfully: drop me"),
      t("TaskUpdate", { taskId: "1", status: "completed" }),
      t("TaskUpdate", { taskId: "2", status: "in_progress" }),
      t("TaskUpdate", { taskId: "3", status: "deleted" }),
    ])!;
    expect(p.items).toEqual([{ text: "measure", status: "completed" }, { text: "fix", status: "in_progress" }]);
    expect([p.done, p.total]).toEqual([1, 2]);
  });

  test("no plan call: no plan (the screen says so), never an empty plan", () => {
    expect(planFrom([t("Bash", { command: "ls" })])).toBeNull();
  });
});

// ── tabs, grid, sources ───────────────────────────────────────────────────────────────────

const agent = (id: string, status: string, extra: Partial<HostAgent> = {}): HostAgent => ({
  id, status, cwd: "/p", prompt: `prompt ${id}`, running: ["starting", "working", "waiting"].includes(status),
  createdAt: at(Number(id.replace(/\D/g, "")) || 0), updatedAt: at(0), pendingPermissions: [], ...extra,
});

describe("tabs and the 2×2 grid", () => {
  test("AnviDeck's agents first, most urgent first; terminal sessions after them, view only, and an AnviDeck session not twice", () => {
    const ask = { requestId: "r", toolName: "Write", input: {}, askedAt: at(0) };
    const tabs = agentTabs(
      [agent("a1", "done"), agent("a2", "working"), agent("a3", "working", { pendingPermissions: [ask] }), agent("a4", "failed", { sessionId: "s-host" })],
      [
        { sessionId: "s-host", project: "p", cwd: "/p", lastTs: at(5), modifiedAt: at(5) },
        { sessionId: "s-term-1234567", project: "p", cwd: "/p", lastTs: "2026-10-30T17:15:05.000Z", modifiedAt: at(5) },
      ],
    );
    expect(tabs.map((t) => [t.id, t.tone, t.status])).toEqual([
      ["a3", "waiting", "waiting on you (1)"],
      ["a2", "working", "working"],
      ["a4", "failed", "failed"],
      ["a1", "done", "done"],
      ["s-term-1234567", "view", "view only"],
    ]);
    expect(tabs.at(-1)!.label).toBe("s-term-1 · 10-30 17:15");
  });

  test("the grid shows at most four, running ones first", () => {
    const g = gridAgents([agent("a1", "done"), agent("a2", "done"), agent("a3", "working"), agent("a4", "stopped"), agent("a5", "waiting"), agent("a6", "done")]);
    expect(g.map((a) => a.id)).toEqual(["a5", "a3", "a6", "a2"]);
  });

  test("the hash: session and agent open a tab, grid=1 the grid; the replay view's own hashes still open it", () => {
    const p = (s: string) => parseAgentsScreenParams(new URLSearchParams(s));
    expect(p("agent=a1")).toEqual({ agent: "a1", session: undefined, grid: false, replay: false });
    expect(p("grid=1").grid).toBe(true);
    expect(p("session=s1").replay).toBe(false);
    expect(p("project=stave&sid=811b15d0").replay).toBe(true);
    expect(p("view=replay&project=stave").replay).toBe(true);
  });

  test("tool targets: files relative to the agent's folder, commands by their first line", () => {
    expect(toolTarget("Edit", { file_path: "/p/src/a.ts" }, "/p")).toBe("src/a.ts");
    expect(toolTarget("Edit", { file_path: "/elsewhere/a.ts" }, "/p")).toBe("/elsewhere/a.ts");
    expect(toolTarget("Bash", { command: "cd x\nls" })).toBe("cd x");
  });
});

describe("sources: absent, empty and unreadable say different things", () => {
  const base = { count: 0, skippedLines: 0 };
  test("a missing transcript is a failure to read; a missing meter or hook log is only 'not present'", () => {
    expect(sourceLine("transcript", { ...base, status: "not-found", detail: "gone" })).toEqual({ text: "could not read: gone", tone: "bad" });
    expect(sourceLine("meter", { ...base, status: "not-found" })).toEqual({ text: "not present", tone: "neutral" });
    expect(sourceLine("hookLog", { ...base, status: "not-found" })).toEqual({ text: "not present", tone: "neutral" });
  });
  test("unreadable is red for every source; empty is 'nothing in it'; damaged lines are counted", () => {
    expect(sourceLine("hookLog", { ...base, status: "unreadable", detail: "EACCES" }).tone).toBe("bad");
    expect(sourceLine("meter", { ...base, status: "none" }).text).toStartWith("read, nothing in it");
    expect(sourceLine("meter", { status: "partial", count: 3, skippedLines: 2 })).toEqual({ text: "3 rows; 2 lines could not be read", tone: "warn" });
    expect(sourceLine("transcript", { status: "ok", count: 400, total: 543, skippedLines: 0 }).text).toBe("400 newest of 543 records");
    expect(sourceLine("meter", { status: "ok", count: 10, total: 30, beforeWindow: 20, skippedLines: 0 }).text).toBe("10 newest of 30 rows (20 older left out)");
  });
});

// ── the reader and its route ──────────────────────────────────────────────────────────────

describe("reader: one session's transcript, hook meter and hook log", () => {
  const SID = "11111111-2222-3333-4444-555555555555";
  function world() {
    const claude = scratch();
    const meterDir = join(claude, "meter");
    const hookLogDir = join(claude, "tmp");
    mkdirSync(join(claude, "projects", "-p"), { recursive: true });
    mkdirSync(meterDir);
    mkdirSync(hookLogDir);
    return { claude, meterDir, hookLogDir, paths: { claudeDir: claude, meterDir, hookLogDir } };
  }

  test("reads all three, trims what the screen does not use, and counts lines it could not parse", () => {
    const w = world();
    const long = "x".repeat(TOOL_RESULT_MAX_CHARS + 50);
    writeFileSync(join(w.claude, "projects", "-p", `${SID}.jsonl`), [
      JSON.stringify({ type: "user", timestamp: at(0), cwd: "/p", message: { role: "user", content: "go" } }),
      JSON.stringify({ type: "assistant", timestamp: at(1), message: { content: [{ type: "thinking", thinking: "secret" }, { type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } }] } }),
      JSON.stringify({ type: "user", timestamp: at(2), message: { content: [{ type: "tool_result", tool_use_id: "t", content: long }, { type: "image", source: { data: "AAAA" } }] } }),
      JSON.stringify({ type: "assistant", isSidechain: true, timestamp: at(3), message: { content: [{ type: "text", text: "subagent" }] } }),
      JSON.stringify({ type: "attachment", timestamp: at(1), attachment: { type: "hook_additional_context", toolUseID: "t", content: ["ctx"] } }),
      JSON.stringify({ type: "attachment", timestamp: at(1), attachment: { type: "skill_listing", content: "big" } }),
      JSON.stringify({ type: "api-request-blob", timestamp: at(1) }),
      "{torn",
    ].join("\n"));
    writeFileSync(join(w.meterDir, `${SID}.jsonl`), `${JSON.stringify({ ts: at(1), sid: SID, hook: "a.js", event: "PreToolUse", bytes: 3, ms: 1, outcome: "informed" })}\n`);
    const r = readAgentSession(SID, w.paths);
    expect(r.transcript.status).toBe("partial");
    expect(r.transcript.skippedLines).toBe(1);
    expect(r.transcript.cwd).toBe("/p");
    expect(r.transcript.records.map((x) => x.type)).toEqual(["user", "assistant", "user", "attachment"]);
    const asst = r.transcript.records[1].message!.content as { type: string }[];
    expect(asst.map((b) => b.type)).toEqual(["tool_use"]);
    const res = r.transcript.records[2].message!.content as { type: string; content?: string; text?: string }[];
    expect(res[0].content!.length).toBeLessThan(long.length);
    expect(res[0].content).toContain(`[cut by AnviDeck: ${long.length} characters in all]`);
    expect(res[1]).toEqual({ type: "text", text: "[an image: left out by AnviDeck]" });
    expect(r.meter).toMatchObject({ status: "ok", count: 1 });
    expect(r.hookLog.status).toBe("not-found");
  });

  test("not found and unreadable are told apart, per source", () => {
    const w = world();
    expect(readAgentSession(SID, w.paths).transcript.status).toBe("not-found");
    const log = join(w.hookLogDir, `anvi-hook-${SID}.log`);
    writeFileSync(log, "{}\n");
    chmodSync(log, 0o000);
    try {
      const r = readAgentSession(SID, w.paths);
      // Running as root would read it anyway; then the control is meaningless and says so.
      if (process.getuid?.() !== 0) expect(r.hookLog.status).toBe("unreadable");
    } finally {
      chmodSync(log, 0o600);
    }
    expect(readAgentSession(SID, { ...w.paths, claudeDir: join(w.claude, "nope") }).transcript.status).toBe("not-found");
  });

  test("only the newest records are sent, with the total; older hook rows are left out and counted", () => {
    const w = world();
    const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ type: "assistant", timestamp: at(i * 100), message: { content: [{ type: "text", text: `m${i}` }] } }));
    writeFileSync(join(w.claude, "projects", "-p", `${SID}.jsonl`), lines.join("\n"));
    writeFileSync(join(w.meterDir, `${SID}.jsonl`), [at(0), at(850), at(950)].map((ts) => JSON.stringify({ ts, hook: "h.js", event: "PreToolUse", outcome: "silent", bytes: 0 })).join("\n"));
    const r = readAgentSession(SID, w.paths, { tail: 2 });
    expect(r.transcript.records.map((x) => (x.message!.content as { text: string }[])[0].text)).toEqual(["m8", "m9"]);
    expect([r.transcript.count, r.transcript.total]).toEqual([2, 10]);
    expect([r.meter.count, r.meter.total, r.meter.beforeWindow]).toEqual([2, 3, 1]);
  });

  test("trimRecord keeps hook attachments of every hook_ type and drops other attachments", () => {
    expect(trimRecord({ type: "attachment", attachment: { type: "hook_blocking_error" } }, 1)?.type).toBe("attachment");
    expect(trimRecord({ type: "attachment", attachment: { type: "date" } }, 1)).toBeNull();
  });

  test("the route refuses a session id that could name a path, and answers JSON for a good one", async () => {
    const w = world();
    const app = agentsScreenRoutes(w.paths);
    expect((await app.request("/session/...")).status).toBe(400);
    expect((await app.request("/session/a%2Fb")).status).toBe(400);
    const ok = await app.request(`/session/${SID}`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { transcript: { status: string } }).transcript.status).toBe("not-found");
  });
});

// ── the screen's wiring (read from source: the page has no DOM test harness) ────────────────

describe("the screen acts only through the shared pieces", () => {
  const screen = readFileSync(join(ROOT, "ui/components/AgentsScreen.ts"), "utf8");
  const app = readFileSync(join(ROOT, "ui/app.ts"), "utf8");

  test("each card carries its permission requests with the same component as Home", () => {
    expect(screen).toMatch(/import \{[^}]*\bagentRequests\b[^}]*\} from "\.\/PermissionRequests"/);
    expect(screen).toContain("agentRequests(a as unknown as AskingAgent)");
  });

  test("every write goes through write(); a refused message is read by type, not by a cast", () => {
    expect(screen).not.toMatch(/fetch\([^)]*,\s*\{\s*method/);
    expect(screen).toMatch(/e instanceof WriteError && e\.status === 409 && e\.body\.resumable === true/);
  });

  test("app.ts routes #agents to this screen, keeps the replay view, and feeds it live lines and agents", () => {
    expect(app).toContain("AgentsScreen({");
    expect(app).toMatch(/id === "agents" && !parseAgentsScreenParams\(route\.params\)\.replay/);
    expect(app).toContain("agentsScreenLine(m.id, m.line)");
    expect(app.match(/agentsScreenAgents\(hostAgents\)/g)?.length).toBe(2);
  });
});
