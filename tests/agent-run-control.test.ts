// Interrupting an agent mid-turn (#304) and choosing how it runs (#305): the model, effort and
// extra folders at start and resume, the model changed while it runs, the list of models Claude
// Code offers, and extra folders counting as the agent's wherever AnviDeck asks who works where.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Options, PermissionResult, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentHost, type QueryFn } from "../server/agents/host";
import { AgentRegistry } from "../server/agents/registry";
import { loginOnlyEnv } from "../server/agents/login";
import { AgentTurns } from "../server/agents/turns";
import { CheckpointStore } from "../server/agents/checkpoints";
import { touching, type AgentFact } from "../server/code-touch";
import { agentRoutes } from "../server/routes/agents";
import { installGuard } from "../server/guard";
import { dispatch, isFromApp } from "../server/desktop";
import { ActionLog, type ActionRecord } from "../server/action-log";
import { modeCapFrom } from "../shared/agent-modes";
import { checkRunOptions, readModels, runOptionsLine, type ModelList } from "../shared/agent-run-options";
import { activityCounts } from "../ui/shell/activity";
import { buildTimeline, type ToolCall } from "../ui/components/agents-model";

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "runctl-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
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

/** As this login's Claude Code listed them (a real supportedModels() answer, trimmed). */
const MODELS_RAW = [
  { value: "default", displayName: "Default (recommended)", description: "d", resolvedModel: "claude-opus-5-5", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "sonnet", displayName: "Sonnet 5.5", description: "s", resolvedModel: "claude-sonnet-5-5", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "haiku", displayName: "Haiku 5.5", description: "h", resolvedModel: "claude-haiku-5-5", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "old", resolvedModel: "claude-haiku-4-5-20251001" },
  { value: "claude-opus-4-6", displayName: "Opus 4.6", description: "o", supportedEffortLevels: ["low", "medium", "high", "max"] },
];

const init = (model = "claude-opus-5-5") =>
  ({ type: "system", subtype: "init", apiKeySource: "none", session_id: "s1", claude_code_version: "2", model, cwd: "/x", tools: [], mcp_servers: [], permissionMode: "default", slash_commands: [], output_style: "default", uuid: "u" }) as unknown as SDKMessage;
const ok = { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, num_turns: 1, duration_ms: 1, duration_api_ms: 1, stop_reason: "end_turn", terminal_reason: "completed", usage: {}, modelUsage: {}, session_id: "s1", uuid: "r" } as unknown as SDKMessage;
// What real Claude Code sent when interrupted mid-turn (observed 2026-11-20 on 0.3.318).
const cutShort = { type: "result", subtype: "error_during_execution", is_error: true, errors: ["[ede_diagnostic] result_type=user"], total_cost_usd: 0, num_turns: 1, duration_ms: 1, duration_api_ms: 1, stop_reason: "tool_use", terminal_reason: "aborted_tools", usage: {}, modelUsage: {}, session_id: "s1", uuid: "r2" } as unknown as SDKMessage;
const interruptedNote = { type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }, parent_tool_use_id: null, session_id: "s1" } as unknown as SDKMessage;
const lifecycle = (command_uuid: string) => ({ type: "command_lifecycle", command_uuid, state: "started" }) as unknown as SDKMessage;

/**
 * A fake Claude Code. Its first turn runs a long tool call that ends only when it is interrupted
 * (or, with `finishFirst`, ends by itself before the interrupt lands); with `ask`, the tool call
 * first asks permission. Each later message is a turn of its own, reported as taken in. It reads
 * the prompt stream as Claude Code does, so it ends when the host closes it.
 */
function fakeClaude(opts: { ask?: boolean; finishFirst?: boolean; interruptFails?: boolean; setModelFails?: boolean; modelsFail?: boolean; deaf?: boolean } = {}) {
  const launched: Options[] = [];
  const calls = { interrupt: 0, setModel: [] as (string | undefined)[], supportedModels: 0, closed: 0 };
  const asked: PermissionResult[] = [];
  let release: (() => void) | undefined;
  let model = "claude-opus-5-5";
  const query: QueryFn = ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    launched.push(options);
    if (options.model === "haiku") model = "claude-haiku-5-5";
    const it = prompt[Symbol.asyncIterator]();
    let interrupted = false;
    const gen = (async function* () {
      const first = await it.next();
      if (first.done) return;
      yield init(model);
      if (opts.ask) {
        const r = await options.canUseTool!("Bash", { command: "make" }, { signal: new AbortController().signal, toolUseID: "t1" } as never);
        asked.push(r);
      }
      if (!opts.finishFirst && !interrupted) await new Promise<void>((r) => (release = r));
      if (interrupted) {
        yield interruptedNote;
        yield cutShort;
      } else yield ok;
      // `deaf`: after its first turn it takes no message in, until it is ended.
      if (opts.deaf) {
        await new Promise<void>((r) => options.abortController?.signal.addEventListener("abort", () => r()));
        return;
      }
      for (;;) {
        const next = await it.next();
        if (next.done) return;
        const u = (next.value as { uuid?: string }).uuid;
        if (u) yield lifecycle(u);
        yield init(model);
        yield ok;
      }
    })();
    return Object.assign(gen, {
      setPermissionMode: async () => {},
      interrupt: async () => {
        calls.interrupt++;
        if (opts.interruptFails) throw new Error("not now");
        interrupted = true;
        release?.();
        return { still_queued: [] };
      },
      setModel: async (m?: string) => {
        calls.setModel.push(m);
        if (opts.setModelFails) throw new Error("no such model here");
        model = m === "haiku" ? "claude-haiku-5-5" : (m ?? "claude-opus-5-5");
      },
      supportedModels: async () => {
        calls.supportedModels++;
        if (opts.modelsFail) throw new Error("cannot list");
        return MODELS_RAW;
      },
      close: () => {
        calls.closed++;
      },
    }) as unknown as ReturnType<QueryFn>;
  };
  return { query, launched, calls, asked, finish: () => release?.() };
}

const captures: { id: string; when: string }[] = [];
function makeHost(f: ReturnType<typeof fakeClaude>, o: { registry?: AgentRegistry; checkpoints?: CheckpointStore | null } = {}) {
  const host = new AgentHost({
    registry: o.registry ?? new AgentRegistry(scratch()),
    query: f.query,
    resolveClaude: () => ({ path: "/fake/claude", realPath: "/fake/claude-2", fileId: "1:1:1" }),
    env: () => loginOnlyEnv({ PATH: "/usr/bin" }),
    emit: () => {},
    modeCap: modeCapFrom("acceptEdits"),
    messageWaitMs: 200,
    checkpoints: o.checkpoints ?? null,
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

/** A host whose model list is known, as after an agent's first run. */
async function hostWithModels(f: ReturnType<typeof fakeClaude>, o: Parameters<typeof makeHost>[1] = {}) {
  const h = makeHost(f, o);
  await h.host.lookupModels(scratch());
  return h;
}

describe("Interrupt (#304)", () => {
  test("a fake agent in a long tool call is interrupted: it stays running, takes the next message without a resume, and the transcript shows it", async () => {
    const f = fakeClaude();
    const { host, events } = makeHost(f);
    const a = host.start({ cwd: scratch(), prompt: "build" });
    await until(() => host.get(a.id).status === "working");
    const sent = host.interrupt(a.id);
    expect(sent.interrupting).toBeDefined();
    expect(f.calls.interrupt).toBe(1);
    await until(() => host.get(a.id).interrupted !== undefined);
    const v = host.get(a.id);
    expect(v.running).toBe(true);
    expect(v.status).toBe("waiting");
    expect(v.interrupting).toBeUndefined();
    expect(events(a.id).map((e) => e.event)).toEqual(expect.arrayContaining(["interrupt-sent", "interrupted"]));
    expect(events(a.id).find((e) => e.event === "interrupted")).toMatchObject({ result: "error_during_execution", terminalReason: "aborted_tools" });
    // It does not end, as a finished turn would: still open well after the message wait.
    await tick(300);
    expect(host.get(a.id).running).toBe(true);
    expect(host.get(a.id).status).toBe("waiting");
    // The next message runs on the same Claude Code process: no second launch, no resume.
    const { message } = host.message(a.id, { text: "not that file, this one" });
    await until(() => host.get(a.id).status === "done");
    expect(f.launched.length).toBe(1);
    expect(events(a.id).find((e) => e.event === "message-delivered")).toMatchObject({ messageId: message.messageId });
    expect(events(a.id).some((e) => e.event === "message-not-delivered")).toBe(false);
    expect(host.get(a.id).interrupted).toBeUndefined();
  });

  test("a request the agent had parked is withdrawn, with the reason, and answered deny", async () => {
    const f = fakeClaude({ ask: true });
    const { host, events } = makeHost(f);
    const a = host.start({ cwd: scratch(), prompt: "build" });
    await until(() => host.get(a.id).pendingPermissions.length === 1);
    expect(host.get(a.id).status).toBe("waiting");
    host.interrupt(a.id);
    expect(host.get(a.id).pendingPermissions).toEqual([]);
    expect(events(a.id).find((e) => e.event === "permission-withdrawn")).toMatchObject({ reason: "interrupted by you" });
    expect(events(a.id).find((e) => e.event === "interrupt-sent")).toMatchObject({ withdrawn: 1 });
    await until(() => f.asked.length === 1);
    expect(f.asked[0]).toMatchObject({ behavior: "deny", message: "interrupted by you" });
    await until(() => host.get(a.id).interrupted !== undefined);
  });

  test("the interrupted turn gets its checkpoint, and the next turn its own (#248)", async () => {
    const f = fakeClaude();
    const calls: { when: string; run: number }[] = [];
    const store = {
      capture: (_id: string, _cwd: string, meta: { when: string; run: number }) => {
        calls.push(meta);
        return Promise.resolve();
      },
      kept: () => false,
    } as unknown as CheckpointStore;
    const { host } = makeHost(f, { checkpoints: store });
    const a = host.start({ cwd: scratch(), prompt: "build" });
    await until(() => host.get(a.id).status === "working");
    host.interrupt(a.id);
    await until(() => host.get(a.id).interrupted !== undefined);
    expect(calls.map((c) => c.when)).toEqual(["before-run", "after-turn"]);
    host.message(a.id, { text: "go on" });
    await until(() => host.get(a.id).status === "done");
    expect(calls.map((c) => c.when)).toEqual(["before-run", "after-turn", "after-turn"]);
  });

  test("offered only while a turn is under way", async () => {
    const f = fakeClaude();
    const { host } = makeHost(f);
    expect(refusal(() => host.interrupt("nope")).status).toBe(404);
    const a = host.start({ cwd: scratch(), prompt: "build" });
    await until(() => host.get(a.id).status === "working");
    host.interrupt(a.id);
    expect(refusal(() => host.interrupt(a.id)).message).toMatch(/already on its way/);
    await until(() => host.get(a.id).interrupted !== undefined);
    expect(refusal(() => host.interrupt(a.id)).message).toMatch(/already interrupted/);
    host.message(a.id, { text: "go on" });
    await until(() => host.get(a.id).status === "done");
    // Done and exiting: nothing to interrupt.
    expect(refusal(() => host.interrupt(a.id))).toMatchObject({ status: 409 });
  });

  test("Stop ends an interrupted agent; a resume is refused while it waits, saying to message it", async () => {
    const f = fakeClaude();
    const { host, events } = makeHost(f);
    const a = host.start({ cwd: scratch(), prompt: "build" });
    await until(() => host.get(a.id).status === "working");
    host.interrupt(a.id);
    await until(() => host.get(a.id).interrupted !== undefined);
    expect(refusal(() => host.resume(a.id, "again")).message).toMatch(/interrupted and still running: send it a message/);
    const stopped = host.stop(a.id);
    expect(stopped.status).toBe("stopped");
    await until(() => !host.get(a.id).running);
    expect(host.get(a.id).status).toBe("stopped");
    expect(events(a.id).some((e) => e.event === "stopped")).toBe(true);
  });

  test("a turn that finished before the interrupt landed ends as usual", async () => {
    const f = fakeClaude();
    const { host, events } = makeHost(f);
    const a = host.start({ cwd: scratch(), prompt: "build" });
    await until(() => host.get(a.id).status === "working");
    // The fake ends its turn normally; the interrupt reaches Claude Code too late to cut it short.
    (host as unknown as { live: Map<string, { query: { interrupt: () => Promise<unknown> } }> }).live.get(a.id)!.query.interrupt = async () => {
      f.finish();
      return { still_queued: [] };
    };
    host.interrupt(a.id);
    await until(() => host.get(a.id).status === "done");
    expect(events(a.id).some((e) => e.event === "interrupt-too-late")).toBe(true);
    expect(host.get(a.id).interrupted).toBeUndefined();
  });

  test("an interrupted agent counts as waiting on you, beside the strip's working count", () => {
    const base = { cwd: "/w", prompt: "p", pendingPermissions: [] as unknown[] };
    expect(activityCounts([{ ...base, id: "a", status: "waiting", interrupted: "t" }, { ...base, id: "b", status: "working" }])).toEqual({ total: 2, working: 1, waiting: 1, elsewhere: 0 });
    expect(activityCounts([{ ...base, id: "a", status: "waiting" }])).toMatchObject({ waiting: 0 });
  });

  test("a message Claude Code does not take in while it is interrupted is recorded, and it stays interrupted, not ended", async () => {
    const f = fakeClaude({ deaf: true });
    const { host, events } = makeHost(f);
    const a = host.start({ cwd: scratch(), prompt: "build" });
    await until(() => host.get(a.id).status === "working");
    host.interrupt(a.id);
    await until(() => host.get(a.id).interrupted !== undefined);
    host.message(a.id, { text: "go on" });
    await until(() => events(a.id).some((e) => e.event === "message-not-delivered"));
    await tick(50);
    expect(host.get(a.id)).toMatchObject({ running: true, status: "waiting" });
    expect(host.get(a.id).interrupted).toBeDefined();
    host.stop(a.id);
  });

  test("not offered once the turn's result is in, while a message sent at its end waits to be taken in", async () => {
    const f = fakeClaude({ deaf: true });
    const { host } = makeHost(f);
    const a = host.start({ cwd: scratch(), prompt: "build" });
    await until(() => host.get(a.id).status === "working");
    host.message(a.id, { text: "and then this" });
    f.finish();
    await until(() => host.transcript(a.id).lines.some((l) => l.from === "sdk" && (l.message as { type?: string }).type === "result"));
    expect(host.get(a.id).running).toBe(true);
    expect(refusal(() => host.interrupt(a.id)).message).toMatch(/turn is already over/);
    await until(() => host.get(a.id).status === "done");
  });

  test("the timeline says the turn was cut short by your interrupt, and the call it cut off, not \"no result\"", async () => {
    const f = fakeClaude();
    const { host } = makeHost(f);
    const a = host.start({ cwd: scratch(), prompt: "build" });
    await until(() => host.get(a.id).status === "working");
    // The fake's long call, as Claude Code reports it.
    const lines = () => host.transcript(a.id).lines;
    host.interrupt(a.id);
    await until(() => host.get(a.id).interrupted !== undefined);
    const withCall = [
      ...lines().slice(0, 2),
      { seq: 99, at: lines()[1]!.at, from: "sdk" as const, message: { type: "assistant", message: { content: [{ type: "tool_use", id: "t9", name: "Bash", input: { command: "make all" } }] } } },
      ...lines().slice(2),
    ];
    const tl = buildTimeline({ lines: withCall as never, live: false });
    const events = tl.items.filter((i) => i.kind === "event").map((i) => (i as { text: string }).text);
    expect(events).toContain("you interrupted it");
    expect(events).toContain("turn cut short by your interrupt: your next message goes on from here");
    expect(events.some((t) => t.startsWith("turn ended"))).toBe(false);
    expect((tl.items.find((i) => i.kind === "tool") as ToolCall).state).toBe("interrupted");
    host.stop(a.id);
  });

  test("an interrupt Claude Code refuses is recorded, and the agent works on", async () => {
    const f = fakeClaude({ interruptFails: true });
    const { host, events } = makeHost(f);
    const a = host.start({ cwd: scratch(), prompt: "build" });
    await until(() => host.get(a.id).status === "working");
    host.interrupt(a.id);
    await until(() => events(a.id).some((e) => e.event === "interrupt-failed"));
    expect(host.get(a.id).interrupting).toBeUndefined();
    expect(host.get(a.id).status).toBe("working");
    f.finish();
    await until(() => host.get(a.id).status === "done");
  });
});

describe("the models Claude Code offers (#305)", () => {
  test("read as the SDK lists them; rows without a value are left out", () => {
    const ms = readModels([...MODELS_RAW, { displayName: "no value" }, null]);
    expect(ms.map((m) => m.value)).toEqual(["default", "sonnet", "haiku", "claude-haiku-4-5-20251001", "claude-opus-4-6"]);
    expect(ms[3]!.efforts).toBeUndefined();
    expect(ms[4]!.efforts).toEqual(["low", "medium", "high", "max"]);
  });

  test("model and effort are checked against the list; extra folders against their shape", () => {
    const list: ModelList = { models: readModels(MODELS_RAW), at: "t", from: "x" };
    expect(checkRunOptions({ model: "sonnet", effort: "high" }, list)).toEqual({ ok: true, options: { model: "sonnet", effort: "high" } });
    expect(checkRunOptions({ model: "default", effort: "max" }, list)).toEqual({ ok: true, options: { effort: "max" } });
    expect(checkRunOptions({ model: "gpt" }, list)).toMatchObject({ ok: false, status: 400 });
    expect(checkRunOptions({ model: "sonnet" }, null)).toMatchObject({ ok: false, status: 409 });
    expect(checkRunOptions({}, null)).toEqual({ ok: true, options: {} });
    expect(checkRunOptions({ effort: "high" }, null)).toEqual({ ok: true, options: { effort: "high" } });
    expect(checkRunOptions({ model: "claude-haiku-4-5-20251001", effort: "low" }, list)).toMatchObject({ ok: false, error: "Haiku 4.5 takes no effort level" });
    expect(checkRunOptions({ model: "claude-opus-4-6", effort: "xhigh" }, list)).toMatchObject({ ok: false, error: "Opus 4.6 takes effort low, medium, high, max, not xhigh" });
    expect(checkRunOptions({ effort: "huge" }, list)).toMatchObject({ ok: false, status: 400 });
    expect(checkRunOptions({ extraDirs: ["rel/path"] }, list)).toMatchObject({ ok: false, status: 400 });
    expect(checkRunOptions({ extraDirs: ["/a/", "/a", "/b"] }, list)).toEqual({ ok: true, options: { extraDirs: ["/a", "/b"] } });
    expect(checkRunOptions({ extraDirs: ["/w"] }, list, "/w")).toMatchObject({ ok: false, status: 400 });
    expect(runOptionsLine({ requestedModel: "sonnet", effort: "high", extraDirs: ["/a"] }, list)).toBe("Sonnet 5.5 (sonnet) · effort high · also works in /a");
    expect(runOptionsLine({})).toBe("Claude Code's default model · default effort");
  });

  test("Read models starts Claude Code without a prompt, keeps the list, ends it; a new host on the same folder has it", async () => {
    const f = fakeClaude();
    const registry = new AgentRegistry(scratch());
    const { host } = makeHost(f, { registry });
    expect(host.models()).toBeNull();
    const where = scratch();
    const list = await host.lookupModels(where);
    expect(list.from).toBe(`Read models in ${where}`);
    expect(list.models.map((m) => m.value)).toContain("sonnet");
    expect(f.calls.closed).toBe(1);
    expect(f.launched[0]!.cwd).toBe(where);
    expect(existsSync(join(registry.dir, "models.json"))).toBe(true);
    const again = makeHost(fakeClaude(), { registry: new AgentRegistry(registry.dir) }).host;
    expect(again.models()?.models.map((m) => m.value)).toEqual(list.models.map((m) => m.value));
    await expect(host.lookupModels("relative")).rejects.toMatchObject({ status: 400 });
    const bad = makeHost(fakeClaude({ modelsFail: true })).host;
    await expect(bad.lookupModels(scratch())).rejects.toMatchObject({ status: 502 });
  });

  test("each run's list is kept once Claude Code has started (asked once per run)", async () => {
    const f = fakeClaude({ finishFirst: true });
    const { host } = makeHost(f);
    const a = host.start({ cwd: scratch(), prompt: "hi" });
    await until(() => host.models() !== null);
    expect(host.models()!.from).toBe(`agent ${a.id}'s Claude Code`);
    await until(() => host.get(a.id).status === "done");
    expect(f.calls.supportedModels).toBe(1);
  });
});

describe("model, effort and extra folders at start and resume (#305)", () => {
  test("a fake agent started with a model, an effort and extra folders sends them to query(); a resume keeps them", async () => {
    const f = fakeClaude({ finishFirst: true });
    const { host, events } = await hostWithModels(f);
    const extra = scratch();
    const a = host.start({ cwd: scratch(), prompt: "hi", model: "haiku", effort: "low", extraDirs: [extra] });
    expect(a).toMatchObject({ requestedModel: "haiku", effort: "low", extraDirs: [extra] });
    await until(() => host.get(a.id).status === "done" && !host.get(a.id).running, 4000);
    const opts = f.launched[1]!;
    expect(opts).toMatchObject({ model: "haiku", effort: "low", additionalDirectories: [extra] });
    // The card shows what Claude Code reports, not what was asked.
    expect(host.get(a.id).model).toBe("claude-haiku-5-5");
    expect(events(a.id).find((e) => e.event === "started")).toMatchObject({ model: "haiku", effort: "low", extraDirs: [extra] });
    host.resume(a.id, "again");
    await until(() => f.launched.length === 3);
    expect(f.launched[2]).toMatchObject({ model: "haiku", effort: "low", additionalDirectories: [extra] });
    await until(() => host.get(a.id).status === "done" && !host.get(a.id).running, 4000);
    // A resume can choose again: Claude Code's default, no effort, no extra folder.
    host.resume(a.id, "again", { model: "", effort: "", extraDirs: [] });
    await until(() => f.launched.length === 4);
    const last = f.launched[3]!;
    expect(last.model).toBeUndefined();
    expect(last.effort).toBeUndefined();
    expect(last.additionalDirectories).toBeUndefined();
  });

  test("a start with nothing chosen sends nothing, so Claude Code uses its defaults", async () => {
    const f = fakeClaude({ finishFirst: true });
    const { host } = makeHost(f);
    host.start({ cwd: scratch(), prompt: "hi" });
    await until(() => f.launched.length === 1);
    expect("model" in f.launched[0]!).toBe(false);
    expect("effort" in f.launched[0]!).toBe(false);
    expect("additionalDirectories" in f.launched[0]!).toBe(false);
  });

  test("refused before anything runs: a model not offered, no list yet, an effort the model lacks, a folder that is not there", async () => {
    const f = fakeClaude({ finishFirst: true });
    const { host: bare } = makeHost(f);
    expect(refusal(() => bare.start({ cwd: scratch(), prompt: "hi", model: "sonnet" }))).toMatchObject({ status: 409 });
    const { host } = await hostWithModels(f);
    expect(refusal(() => host.start({ cwd: scratch(), prompt: "hi", model: "gpt-9" }))).toMatchObject({ status: 400 });
    expect(refusal(() => host.start({ cwd: scratch(), prompt: "hi", model: "claude-haiku-4-5-20251001", effort: "high" }))).toMatchObject({ status: 400 });
    expect(refusal(() => host.start({ cwd: scratch(), prompt: "hi", extraDirs: [join(scratch(), "missing")] })).message).toMatch(/does not exist/);
    expect(f.launched.length).toBe(1); // only Read models
  });

  test("a resume keeps its model even where the list was never read", async () => {
    const f = fakeClaude({ finishFirst: true });
    const registry = new AgentRegistry(scratch());
    const { host } = await hostWithModels(f, { registry });
    const a = host.start({ cwd: scratch(), prompt: "hi", model: "sonnet", effort: "high" });
    await until(() => host.get(a.id).status === "done" && !host.get(a.id).running, 4000);
    rmSync(join(registry.dir, "models.json"));
    const g = fakeClaude({ finishFirst: true });
    const other = makeHost(g, { registry: new AgentRegistry(registry.dir) }).host;
    expect(other.models()).toBeNull();
    other.resume(a.id, "again");
    await until(() => g.launched.length === 1);
    expect(g.launched[0]).toMatchObject({ model: "sonnet", effort: "high" });
  });
});

describe("changing the model while it runs (#305)", () => {
  test("setModel reaches the live query, is recorded, and a resume keeps it", async () => {
    const f = fakeClaude();
    const { host, events } = await hostWithModels(f);
    const a = host.start({ cwd: scratch(), prompt: "build" });
    await until(() => host.get(a.id).status === "working");
    const v = host.setModel(a.id, { model: "haiku" });
    expect(v.requestedModel).toBe("haiku");
    await until(() => events(a.id).some((e) => e.event === "model-confirmed"));
    expect(f.calls.setModel).toEqual(["haiku"]);
    expect(events(a.id).find((e) => e.event === "model-changed")).toMatchObject({ from: "default", to: "haiku" });
    // It applies from the next turn: the card then shows what Claude Code reports.
    host.interrupt(a.id);
    await until(() => host.get(a.id).interrupted !== undefined);
    host.message(a.id, { text: "go on" });
    await until(() => host.get(a.id).status === "done");
    expect(host.get(a.id).model).toBe("claude-haiku-5-5");
    await until(() => !host.get(a.id).running, 4000);
    host.resume(a.id, "again");
    await until(() => f.launched.length === 3);
    expect(f.launched[2]!.model).toBe("haiku");
  });

  test("a model not offered, and one sent while another lands, are refused; one Claude Code refuses is put back", async () => {
    const f = fakeClaude({ setModelFails: true });
    const { host, events } = await hostWithModels(f);
    const a = host.start({ cwd: scratch(), prompt: "build", model: "sonnet" });
    await until(() => host.get(a.id).status === "working");
    expect(refusal(() => host.setModel(a.id, { model: "gpt-9" })).status).toBe(400);
    host.setModel(a.id, { model: "haiku" });
    expect(refusal(() => host.setModel(a.id, { model: "default" })).message).toMatch(/still on its way/);
    await until(() => events(a.id).some((e) => e.event === "model-change-failed"));
    expect(host.get(a.id).requestedModel).toBe("sonnet");
    f.finish();
  });

  test("refused when the agent is not running", async () => {
    const f = fakeClaude({ finishFirst: true });
    const { host } = await hostWithModels(f);
    const a = host.start({ cwd: scratch(), prompt: "hi" });
    await until(() => host.get(a.id).status === "done" && !host.get(a.id).running, 4000);
    expect(refusal(() => host.setModel(a.id, { model: "haiku" }))).toMatchObject({ status: 409 });
  });
});

describe("extra folders count as the agent's (#305)", () => {
  test("Undo is refused while another agent works in one of an agent's extra folders", async () => {
    const f = fakeClaude({ finishFirst: true });
    const registry = new AgentRegistry(scratch());
    const store = new CheckpointStore(registry.dir);
    const { host } = makeHost(f, { registry, checkpoints: store });
    const mine = scratch();
    const a = host.start({ cwd: mine, prompt: "hi" });
    await until(() => host.get(a.id).status === "done" && !host.get(a.id).running, 6000);
    const g = fakeClaude();
    // B runs in a folder of its own, with A's folder as an extra one.
    (host as unknown as { queryFn: QueryFn }).queryFn = g.query;
    const b = host.start({ cwd: scratch(), prompt: "work", extraDirs: [mine] });
    await until(() => host.get(b.id).status === "working");
    const turns = new AgentTurns(host, { sessions: () => ({ sessions: [], report: { status: "ok", errors: [] } }) as never, edits: () => ({ edits: [] }) as never });
    const l = turns.list(a.id);
    expect(l.undo).toMatchObject({ ok: false });
    expect((l.undo as { why: string }).why).toBe(`agent ${b.id} is working with ${mine} as an extra folder`);
    host.stop(b.id);
  });

  test("Undo of an agent with extra folders says they are not in its checkpoints", async () => {
    const f = fakeClaude({ finishFirst: true });
    const registry = new AgentRegistry(scratch());
    const { host } = makeHost(f, { registry, checkpoints: new CheckpointStore(registry.dir) });
    const extra = scratch();
    const a = host.start({ cwd: scratch(), prompt: "hi", extraDirs: [extra] });
    await until(() => host.get(a.id).status === "done" && !host.get(a.id).running, 6000);
    const turns = new AgentTurns(host, { sessions: () => ({ sessions: [], report: { status: "ok", errors: [] } }) as never, edits: () => ({ edits: [] }) as never });
    const l = turns.list(a.id);
    expect(l.undo).toMatchObject({ ok: true });
    expect((l.undo as { warnings: string[] }).warnings.join(" ")).toContain(`its extra folders (${extra}) are not in its checkpoints`);
  });

  test("a Code edit is refused for a file in a running agent's extra folder", () => {
    const extra = scratch();
    mkdirSync(join(extra, "src"));
    writeFileSync(join(extra, "src", "x.ts"), "x");
    const facts: AgentFact[] = [{ id: "b1", status: "working", running: true, cwd: scratch(), extraDirs: [extra], prompt: "p", edits: [] }];
    const t = touching(join(extra, "src", "x.ts"), facts, () => null);
    expect(t).toEqual([{ id: "b1", status: "working", why: "works in this folder", detail: `agent b1 (working) works in ${extra} (one of its extra folders), which holds this file` }]);
    expect(touching(join(scratch(), "y.ts"), facts, () => null)).toEqual([]);
  });

  test("a start whose extra folder is held by an Undo is refused", async () => {
    const f = fakeClaude({ finishFirst: true });
    const { host } = makeHost(f);
    const held = scratch();
    host.hold("other", held, "Undo to checkpoint 1 is putting its folder back");
    expect(refusal(() => host.start({ cwd: scratch(), prompt: "hi", extraDirs: [held] })).message).toMatch(/busy: Undo/);
    host.release("other");
  });
});

describe("routes and the action log", () => {
  const HOST = "localhost:4476";
  function server(f: ReturnType<typeof fakeClaude>) {
    const h = makeHost(f);
    const log = new ActionLog(scratch());
    const app = new Hono();
    installGuard(app, { bind: "127.0.0.1", log, isFromApp });
    app.route("/api/agents", agentRoutes(h.host, async () => ({ ok: true }) as never));
    const viaApp = async (path: string, body?: unknown) => dispatch(app, { method: "POST", path, body: body ?? {} }, HOST);
    const lines = (): ActionRecord[] => readFileSync(log.file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const get = async (path: string) => (await app.request(`http://${HOST}${path}`, { headers: { host: HOST } })).json() as Promise<Record<string, unknown>>;
    return { ...h, viaApp, lines, get };
  }

  test("Read models, a start with choices, a model change and an interrupt are each a guarded write, logged with what was chosen", async () => {
    const f = fakeClaude();
    const s = server(f);
    expect((await s.viaApp("/api/agents/models/read", { cwd: scratch() })).status).toBe(200);
    const extra = scratch();
    const started = await s.viaApp("/api/agents", { cwd: scratch(), prompt: "build", model: "sonnet", effort: "high", extraDirs: [extra] });
    expect(started.status).toBe(201);
    const id = (started.body as { id: string }).id;
    await until(() => s.host.get(id).status === "working");
    expect((await s.viaApp(`/api/agents/${id}/model`, { model: "haiku" })).status).toBe(200);
    expect((await s.viaApp(`/api/agents/${id}/interrupt`)).status).toBe(200);
    await until(() => s.host.get(id).interrupted !== undefined);
    expect((await s.viaApp(`/api/agents/${id}/interrupt`)).status).toBe(409);
    const log = s.lines();
    const at = (path: string) => log.filter((l) => l.path === path).map((l) => [l.status, l.result, l.detail]);
    expect(at("/api/agents/models/read")).toEqual([[200, "accepted", undefined]]);
    expect(at("/api/agents")).toEqual([[201, "accepted", { model: "sonnet", effort: "high", extraDirs: extra }]]);
    expect(at(`/api/agents/${id}/model`)).toEqual([[200, "accepted", { from: "sonnet", to: "haiku" }]]);
    expect(at(`/api/agents/${id}/interrupt`).map((x) => x.slice(0, 2))).toEqual([[200, "accepted"], [409, "failed"]]);
    s.host.stop(id);
  });

  test("GET /api/agents carries the model list, null until read", async () => {
    const s = server(fakeClaude());
    expect((await s.get("/api/agents")).models).toBeNull();
    await s.viaApp("/api/agents/models/read", { cwd: scratch() });
    expect(((await s.get("/api/agents")).models as ModelList).models.map((m) => m.value)).toContain("haiku");
  });
});
