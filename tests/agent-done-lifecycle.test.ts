import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentHost, HostError, type QueryFn } from "../server/agents/host";
import { AgentRegistry } from "../server/agents/registry";
import { loginOnlyEnv, type ClaudeBinary } from "../server/agents/login";

/**
 * After an agent's result: the result stands (#114), its Claude Code process never holds a run
 * slot for long (#105), a message sent at the end of a turn never keeps it working forever
 * (#124), and Resume works while the process is still exiting (#126).
 */

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "agent-done-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const CLAUDE: ClaudeBinary = { path: "/fake/bin/claude", realPath: "/fake/lib/claude", fileId: "1:1:1" };
const init = (session_id = "sess-1") =>
  ({ type: "system", subtype: "init", apiKeySource: "none", session_id, claude_code_version: "2", model: "m", cwd: "/x", tools: [], mcp_servers: [], permissionMode: "default", slash_commands: [], output_style: "default", uuid: "u" }) as unknown as SDKMessage;
const result = { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, num_turns: 1, duration_ms: 1, duration_api_ms: 1, stop_reason: null, usage: {}, modelUsage: {}, session_id: "sess-1", uuid: "r" } as unknown as SDKMessage;
const aborted = (o: Options) => new Promise<never>((_, rej) => o.abortController!.signal.addEventListener("abort", () => rej(new Error("aborted"))));

type Script = (o: Options, n: number) => AsyncGenerator<SDKMessage>;

/** A fake Claude Code: `script` gets the run's options and which call this is (0, 1, ...). */
function host(script: Script, timing: { exitGraceMs?: number; messageWaitMs?: number; handoffWaitMs?: number } = {}) {
  const calls: Options[] = [];
  const query: QueryFn = ({ prompt, options }) => {
    const n = calls.push(options) - 1;
    return (async function* () {
      await (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]().next();
      yield* script(options, n);
    })();
  };
  const h = new AgentHost({
    registry: new AgentRegistry(scratch()),
    query,
    resolveClaude: () => CLAUDE,
    env: () => loginOnlyEnv({ PATH: "/usr/bin" }),
    exitGraceMs: timing.exitGraceMs ?? 60_000,
    messageWaitMs: timing.messageWaitMs ?? 60_000,
    handoffWaitMs: timing.handoffWaitMs ?? 60_000,
  });
  const events = (id: string) => h.transcript(id).lines.filter((l) => l.from === "host").map((l) => (l.message as { event: string }).event);
  return { h, calls, events };
}

/** Replies, then keeps running (a background task) until it is ended. */
const lingers: Script = async function* (o) {
  yield init();
  yield result;
  await aborted(o);
};

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await tick();
  }
}
const refusal = (f: () => unknown): HostError => {
  try {
    f();
  } catch (e) {
    return e as HostError;
  }
  throw new Error("not refused");
};

describe("a finished agent's result stands (#114)", () => {
  test("Stop on a done agent whose process is exiting answers 409 already done, and changes nothing", async () => {
    const { h, events } = host(lingers);
    const a = h.start({ cwd: scratch(), prompt: "go" });
    await until(() => h.get(a.id).status === "done");
    const v = h.get(a.id);
    expect(v.running).toBe(true);
    expect(v.exiting).toBeDefined();
    const e = refusal(() => h.stop(a.id));
    expect(e.status).toBe(409);
    expect(e.message).toContain("already done");
    expect(h.get(a.id).status).toBe("done");
    expect(h.get(a.id).reason).toBeUndefined();
    expect(events(a.id)).not.toContain("stopped");
  });

  test("an error after the result leaves it done, and the error is recorded", async () => {
    const { h, events } = host(async function* () {
      yield init();
      yield result;
      await tick(20);
      throw new Error("exit code 1");
    });
    const a = h.start({ cwd: scratch(), prompt: "go" });
    await until(() => !h.get(a.id).running);
    expect(h.get(a.id).status).toBe("done");
    expect(h.get(a.id).reason).toBeUndefined();
    expect(events(a.id)).toContain("exited-with-error-after-result");
    expect(events(a.id)).not.toContain("failed");
  });

  test("a server shutdown while it exits ends the process and leaves it done", async () => {
    const { h, events } = host(lingers);
    const a = h.start({ cwd: scratch(), prompt: "go" });
    await until(() => h.get(a.id).status === "done");
    h.stopAll("AnviDeck is shutting down");
    await until(() => !h.get(a.id).running);
    expect(h.get(a.id).status).toBe("done");
    expect(events(a.id)).toContain("process-ended");
  });

  test("an error before any result still fails the agent", async () => {
    const { h } = host(async function* () {
      yield init();
      throw new Error("crashed mid-turn");
    });
    const a = h.start({ cwd: scratch(), prompt: "go" });
    await until(() => !h.get(a.id).running);
    expect(h.get(a.id).status).toBe("failed");
  });
});

describe("a done agent's lingering process (#105)", () => {
  test("is ended once the grace is over: it stops holding a slot, the record says why, the result stands", async () => {
    const { h, events } = host(lingers, { exitGraceMs: 80 });
    const a = h.start({ cwd: scratch(), prompt: "go" });
    await until(() => h.get(a.id).status === "done");
    // While it exits: shown as exiting, still a running process.
    const v = h.get(a.id);
    expect(v.running).toBe(true);
    expect(Date.parse(v.exiting!.endsBy) - Date.parse(v.exiting!.since)).toBe(80);
    await until(() => !h.get(a.id).running, 2000);
    expect(h.get(a.id).status).toBe("done");
    expect(h.get(a.id).exiting).toBeUndefined();
    const ended = h.transcript(a.id).lines.find((l) => (l.message as { event?: string }).event === "process-ended");
    expect(String((ended!.message as { reason: string }).reason)).toContain("still running");
    expect(events(a.id)).not.toContain("exited-with-error-after-result");
  });

  test("a process that exits on its own within the grace is not ended", async () => {
    const { h, events } = host(async function* () {
      yield init();
      yield result;
    }, { exitGraceMs: 80 });
    const a = h.start({ cwd: scratch(), prompt: "go" });
    await until(() => !h.get(a.id).running);
    await tick(150);
    expect(events(a.id)).not.toContain("process-ended");
    expect(h.get(a.id).status).toBe("done");
  });
});

describe("a message sent at the end of a turn (#124)", () => {
  /** The turn ends while a message waits, and Claude Code never says what became of it. */
  function silentAfterMessage() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const script: Script = async function* (o) {
      yield init();
      await gate;
      yield result;
      await aborted(o);
    };
    return { script, release };
  }

  test("is recorded not delivered after the wait, and the result applies", async () => {
    const s = silentAfterMessage();
    const { h, events } = host(s.script, { messageWaitMs: 80 });
    const a = h.start({ cwd: scratch(), prompt: "go" });
    await until(() => h.get(a.id).status === "working");
    h.message(a.id, { text: "one more thing" });
    s.release();
    await until(() => events(a.id).includes("message-not-delivered"), 2000);
    expect(h.get(a.id).status).toBe("done");
    const nd = h.transcript(a.id).lines.find((l) => (l.message as { event?: string }).event === "message-not-delivered")!;
    expect(String((nd.message as { reason: string }).reason)).toContain("did not take it in");
    expect(h.get(a.id).exiting).toBeDefined();
  });

  test("while it waits the agent is still working; Stop then keeps the result and ends the process", async () => {
    const s = silentAfterMessage();
    const { h, events } = host(s.script);
    const a = h.start({ cwd: scratch(), prompt: "go" });
    await until(() => h.get(a.id).status === "working");
    h.message(a.id, { text: "one more thing" });
    s.release();
    await until(() => events(a.id).filter((e) => e === "message-sent").length === 1 && h.transcript(a.id).lines.some((l) => (l.message as { type?: string }).type === "result"));
    expect(h.get(a.id).status).toBe("working");
    h.stop(a.id);
    await until(() => !h.get(a.id).running);
    expect(h.get(a.id).status).toBe("done");
    expect(events(a.id)).toContain("message-not-delivered");
    expect(events(a.id)).toContain("process-ended");
    expect(events(a.id)).not.toContain("stopped");
  });
});

describe("Resume while the finished agent's process is still exiting (#126)", () => {
  test("ends that process, then resumes the session with the message", async () => {
    const { h, calls, events } = host(async function* (o, n) {
      yield init();
      yield result;
      if (n === 0) await aborted(o);
    });
    const a = h.start({ cwd: scratch(), prompt: "go" });
    await until(() => h.get(a.id).status === "done" && h.get(a.id).exiting !== undefined);
    const v = h.resume(a.id, "and this");
    expect(v.status).toBe("starting");
    expect(v.exiting).toBeUndefined();
    await until(() => calls.length === 2 && !h.get(a.id).running);
    expect(calls[1].resume).toBe("sess-1");
    expect(h.get(a.id).status).toBe("done");
    expect(h.get(a.id).runs).toBe(2);
    const ev = events(a.id);
    expect(ev.indexOf("process-ended")).toBeLessThan(ev.indexOf("resumed"));
    // The resume's prompt is the one given.
    const resumed = h.transcript(a.id).lines.find((l) => (l.message as { event?: string }).event === "resumed")!;
    expect((resumed.message as { prompt: string }).prompt).toBe("and this");
  });

  test("never runs two processes on one session: if the old one does not exit, the resume does not start", async () => {
    const { h, calls, events } = host(async function* () {
      yield init();
      yield result;
      await new Promise(() => {}); // ignores the abort
    }, { handoffWaitMs: 80 });
    const a = h.start({ cwd: scratch(), prompt: "go" });
    await until(() => h.get(a.id).exiting !== undefined);
    h.resume(a.id, "and this");
    expect(refusal(() => h.resume(a.id, "again")).message).toContain("already being resumed");
    await until(() => events(a.id).includes("resume-not-started"), 2000);
    expect(calls.length).toBe(1);
    expect(h.get(a.id).status).toBe("done");
  });

  test("an agent still in its turn is not resumed", async () => {
    const { h } = host(async function* (o) {
      yield init();
      await aborted(o);
    });
    const a = h.start({ cwd: scratch(), prompt: "go" });
    await until(() => h.get(a.id).status === "working");
    expect(refusal(() => h.resume(a.id, "x")).message).toContain("still running");
    h.stop(a.id);
  });
});
