import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentHost, HostError, deliveryIn, type HostEvent, type QueryFn } from "../server/agents/host";
import { AgentRegistry } from "../server/agents/registry";
import { loginOnlyEnv, type ClaudeBinary } from "../server/agents/login";
import { agentRoutes } from "../server/routes/agents";
import { messagesIn, parseMessageRequest, renderForAgent } from "../shared/agent-messages";

/** Talking to a running agent (#79): messages, line comments, delivery, refusal. */

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "agent-msg-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const CLAUDE: ClaudeBinary = { path: "/fake/bin/claude", realPath: "/fake/lib/claude-2.1.318", fileId: "1:100:1" };
const init = () =>
  ({ type: "system", subtype: "init", apiKeySource: "none", session_id: "sess-1", claude_code_version: "2.1.318", model: "m", uuid: "u" }) as unknown as SDKMessage;
const assistant = (text: string) =>
  ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: "sess-1", uuid: "u2" }) as unknown as SDKMessage;
const result = (extra: Record<string, unknown> = {}) =>
  ({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.01, num_turns: 1, session_id: "sess-1", uuid: "u3", ...extra }) as unknown as SDKMessage;
/** Claude Code's frame for a queued message's state (seen from claude 2.1.318). */
const lifecycle = (command_uuid: string, state: string) => ({ type: "command_lifecycle", command_uuid, state }) as unknown as SDKMessage;

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await tick();
  }
}

/** A fake query(): the script can read further user messages from the prompt stream. */
type Script = (o: Options, next: () => Promise<SDKUserMessage | undefined>) => AsyncGenerator<SDKMessage>;
function makeHost(script: Script, dir = scratch()) {
  const events: HostEvent[] = [];
  const received: SDKUserMessage[] = [];
  let streamDone = false;
  const query: QueryFn = ({ prompt, options }) => {
    const it = prompt[Symbol.asyncIterator]();
    const next = async () => {
      const r = await it.next();
      if (r.done) {
        streamDone = true;
        return undefined;
      }
      received.push(r.value);
      return r.value;
    };
    return (async function* () {
      await next();
      yield* script(options, next);
    })();
  };
  const host = new AgentHost({
    registry: new AgentRegistry(dir),
    query,
    resolveClaude: () => CLAUDE,
    env: () => loginOnlyEnv({ PATH: "/usr/bin" }),
    cap: 3,
    emit: (e) => events.push(e),
  });
  return { host, events, received, dir, streamDone: () => streamDone };
}

const hostEvents = (host: AgentHost, id: string) =>
  host.transcript(id).lines.filter((l) => l.from === "host").map((l) => l.message as Record<string, unknown>);

describe("message requests", () => {
  test("text or a line comment, never both or neither; bad fields are named", () => {
    expect(parseMessageRequest({ text: "  skip c.txt " })).toEqual({ kind: "text", text: "skip c.txt" });
    expect(parseMessageRequest({ comment: { file: "a.ts", line: 3, lineText: "  x();", text: "why?" } })).toEqual({
      kind: "comment",
      comment: { file: "a.ts", line: 3, lineText: "  x();", text: "why?" },
    });
    expect(parseMessageRequest({})).toHaveProperty("error");
    expect(parseMessageRequest({ text: "a", comment: { file: "a", line: 1, lineText: "", text: "b" } })).toHaveProperty("error");
    expect(parseMessageRequest({ text: "   " })).toEqual({ error: "message is empty" });
    expect(parseMessageRequest({ comment: { file: "a.ts", line: 0, lineText: "", text: "b" } })).toEqual({ error: "comment.line must be a positive whole number" });
    expect(parseMessageRequest({ comment: { file: "a.ts", line: 1.5, lineText: "", text: "b" } })).toHaveProperty("error");
    expect(parseMessageRequest({ comment: { file: " ", line: 1, lineText: "", text: "b" } })).toEqual({ error: "comment.file is empty" });
    expect(parseMessageRequest({ comment: { file: "a.ts", line: 1, text: "b" } })).toHaveProperty("error");
    expect(parseMessageRequest({ comment: { file: "a.ts", line: 1, lineText: "", text: "" } })).toEqual({ error: "comment.text is empty" });
    expect(parseMessageRequest({ text: "x".repeat(20_001) })).toHaveProperty("error");
  });

  test("a line comment reaches the agent as plain words with its file, line and the line's text", () => {
    const t = renderForAgent({ kind: "comment", comment: { file: "server/x.ts", line: 42, lineText: "return count;", text: "say what was counted" } });
    expect(t).toContain("server/x.ts line 42");
    expect(t).toContain("    return count;");
    expect(t).toContain("say what was counted");
    expect(renderForAgent({ kind: "text", text: "hi" })).toBe("hi");
  });

  test("Claude Code's delivery reports are read from lifecycle frames and from user_message_uuid(s)", () => {
    expect(deliveryIn(lifecycle("m1", "started"))).toEqual({ delivered: ["m1"], refused: [] });
    expect(deliveryIn(lifecycle("m1", "queued"))).toEqual({ delivered: [], refused: [] });
    expect(deliveryIn(lifecycle("m1", "discarded"))).toEqual({ delivered: [], refused: [{ uuid: "m1", state: "discarded" }] });
    expect(deliveryIn(result({ user_message_uuid: "a", user_message_uuids: ["a", "b"] })).delivered).toEqual(["a", "a", "b"]);
    expect(deliveryIn(null)).toEqual({ delivered: [], refused: [] });
  });
});

describe("talking to a running agent", () => {
  test("a message sent mid-turn reaches the agent with its uuid and is marked delivered when Claude Code starts it", async () => {
    let gate!: () => void;
    const opened = new Promise<void>((r) => (gate = r));
    const { host, received, streamDone } = makeHost(async function* (_o, next) {
      yield init();
      yield assistant("writing a.txt");
      await opened;
      const m = await next();
      yield lifecycle(String(m?.uuid), "started");
      yield assistant("ok, d.txt instead");
      yield result();
      await next(); // the host closes the stream once nothing is left undelivered
    });
    const a = host.start({ cwd: scratch(), prompt: "make files" });
    await until(() => host.get(a.id).status === "working");
    const r = host.message(a.id, { text: "skip c.txt and write d.txt instead" });
    expect(r.message.state).toBe("queued");
    expect(messagesIn(host.transcript(a.id).lines).map((s) => s.state)).toEqual(["queued"]);
    gate();
    await until(() => host.get(a.id).status === "done" && !host.get(a.id).running);
    expect(received.map((m) => m.message.content)).toEqual(["make files", "skip c.txt and write d.txt instead"]);
    expect(received[1].uuid).toBe(r.message.messageId as typeof received[1]["uuid"]);
    const sent = messagesIn(host.transcript(a.id).lines);
    expect(sent).toEqual([expect.objectContaining({ messageId: r.message.messageId, state: "delivered", by: "started" })]);
    expect(streamDone()).toBe(true);
  });

  test("a message still waiting when the turn's result arrives keeps the agent working until its own turn ends", async () => {
    let sentId = "";
    let afterFirst!: () => void;
    const firstResultSeen = new Promise<void>((r) => (afterFirst = r));
    let sendNow!: () => void;
    const messageSent = new Promise<void>((r) => (sendNow = r));
    let startSecond!: () => void;
    const secondTurn = new Promise<void>((r) => (startSecond = r));
    const { host, streamDone } = makeHost(async function* (_o, next) {
      yield init();
      await messageSent;
      yield result();
      afterFirst();
      await secondTurn;
      const m = await next(); // Claude Code takes the queued message as its next turn
      sentId = String(m?.uuid);
      yield lifecycle(sentId, "started");
      yield assistant("second turn");
      yield result({ user_message_uuids: [sentId] });
      await next();
    });
    const a = host.start({ cwd: scratch(), prompt: "go" });
    await until(() => host.get(a.id).status === "working");
    // Sent before the first result: it is not part of that turn.
    const r = host.message(a.id, { text: "and then this" });
    sendNow();
    await firstResultSeen;
    await tick();
    // The first result did not end the run: the message is still owed a turn.
    expect(host.get(a.id).status).toBe("working");
    expect(host.get(a.id).running).toBe(true);
    expect(streamDone()).toBe(false);
    startSecond();
    await until(() => !host.get(a.id).running);
    expect(host.get(a.id).status).toBe("done");
    expect(sentId).toBe(r.message.messageId);
    expect(messagesIn(host.transcript(a.id).lines)[0].state).toBe("delivered");
    expect(streamDone()).toBe(true);
  });

  test("a message named only in the result's user_message_uuids is delivered", async () => {
    const { host } = makeHost(async function* (_o, next) {
      yield init();
      const m = await next();
      yield result({ user_message_uuids: ["other", String(m?.uuid)] });
      await next();
    });
    const a = host.start({ cwd: scratch(), prompt: "go" });
    await until(() => host.get(a.id).status === "working");
    host.message(a.id, { text: "hello" });
    await until(() => !host.get(a.id).running);
    expect(messagesIn(host.transcript(a.id).lines).map((s) => [s.state, s.by])).toEqual([["delivered", "result"]]);
    expect(host.get(a.id).status).toBe("done");
  });

  test("a message Claude Code turns away is shown as not delivered, with why, and the turn then ends", async () => {
    const { host } = makeHost(async function* (_o, next) {
      yield init();
      const m = await next();
      yield result();
      yield lifecycle(String(m?.uuid), "discarded");
      await next();
    });
    const a = host.start({ cwd: scratch(), prompt: "go" });
    await until(() => host.get(a.id).status === "working");
    host.message(a.id, { text: "hello" });
    await until(() => !host.get(a.id).running);
    const [s] = messagesIn(host.transcript(a.id).lines);
    expect(s.state).toBe("not-delivered");
    expect(s.reason).toContain("discarded");
    expect(host.get(a.id).status).toBe("done");
  });

  test("a line comment arrives with its file, line and the line's text; the transcript keeps the comment's fields", async () => {
    const { host, received } = makeHost(async function* (_o, next) {
      yield init();
      const m = await next();
      yield lifecycle(String(m?.uuid), "started");
      yield result();
      await next();
    });
    const a = host.start({ cwd: scratch(), prompt: "go" });
    await until(() => host.get(a.id).status === "working");
    host.message(a.id, { comment: { file: "b.txt", line: 1, lineText: "beta", text: "make this uppercase" } });
    await until(() => !host.get(a.id).running);
    const body = String(received[1].message.content);
    expect(body).toContain("b.txt line 1");
    expect(body).toContain("beta");
    expect(body).toContain("make this uppercase");
    const [s] = messagesIn(host.transcript(a.id).lines);
    expect(s.comment).toEqual({ file: "b.txt", line: 1, lineText: "beta" });
    expect(s.said).toBe("make this uppercase");
    expect(s.state).toBe("delivered");
  });

  test("a run that ends before reading a message says it was not delivered", async () => {
    const { host } = makeHost(async function* (o) {
      yield init();
      await new Promise<never>((_, rej) => o.abortController!.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    });
    const a = host.start({ cwd: scratch(), prompt: "go" });
    await until(() => host.get(a.id).status === "working");
    host.message(a.id, { text: "hello" });
    host.stop(a.id);
    await until(() => !host.get(a.id).running);
    const [s] = messagesIn(host.transcript(a.id).lines);
    expect(s.state).toBe("not-delivered");
    expect(s.reason).toBe("stopped by you");
  });

  test("a message to a stopped agent is refused with 409 and resumable, never dropped; to an unknown one 404", async () => {
    const { host } = makeHost(async function* () {
      yield init();
      yield result();
    });
    const a = host.start({ cwd: scratch(), prompt: "go" });
    await until(() => !host.get(a.id).running);
    let err: HostError | undefined;
    try {
      host.message(a.id, { text: "more" });
    } catch (e) {
      err = e as HostError;
    }
    expect(err?.status).toBe(409);
    expect(err?.detail).toEqual({ resumable: true, status: "done" });
    expect(err?.message).toContain("Resume");
    expect(hostEvents(host, a.id).some((m) => m.event === "message-sent")).toBe(false);
    expect(() => host.message("nope", { text: "x" })).toThrow("no agent nope");
    // Bad bodies are refused before anything is checked about the run.
    expect(() => host.message(a.id, { text: "" })).toThrow("message is empty");
  });

  test("a message in the moment between a finished turn and the process exiting is refused, not lost", async () => {
    let exit!: () => void;
    const exited = new Promise<void>((r) => (exit = r));
    const { host } = makeHost(async function* () {
      yield init();
      yield result();
      await exited; // Claude Code is still shutting down
    });
    const a = host.start({ cwd: scratch(), prompt: "go" });
    await until(() => host.get(a.id).status === "done");
    expect(host.get(a.id).running).toBe(true);
    let err: HostError | undefined;
    try {
      host.message(a.id, { text: "late" });
    } catch (e) {
      err = e as HostError;
    }
    expect(err?.status).toBe(409);
    expect(err?.message).toContain("finished its turn");
    expect(err?.detail?.resumable).toBe(true);
    expect(hostEvents(host, a.id).some((m) => m.event === "message-sent")).toBe(false);
    exit();
    await until(() => !host.get(a.id).running);
  });

  test("an agent that never reached Claude Code is not resumable", async () => {
    const { host } = makeHost(async function* () {
      throw new Error("spawn failed");
    });
    const a = host.start({ cwd: scratch(), prompt: "go" });
    await until(() => !host.get(a.id).running);
    try {
      host.message(a.id, { text: "more" });
      throw new Error("not refused");
    } catch (e) {
      expect((e as HostError).status).toBe(409);
      expect((e as HostError).detail?.resumable).toBe(false);
    }
  });

  test("after a restart a message that was still queued is recorded as not delivered", async () => {
    const dir = scratch();
    const first = makeHost(async function* (o) {
      yield init();
      await new Promise<never>((_, rej) => o.abortController!.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    }, dir);
    const a = first.host.start({ cwd: scratch(), prompt: "go" });
    await until(() => first.host.get(a.id).status === "working");
    first.host.message(a.id, { text: "hello" });
    // The server goes away here: no stop, no finish.
    const second = makeHost(async function* () {}, dir);
    const [s] = messagesIn(second.host.transcript(a.id).lines);
    expect(s.state).toBe("not-delivered");
    expect(s.reason).toContain("restarted");
    first.host.stopAll("test over");
  });
});

describe("POST /api/agents/:id/message", () => {
  test("202 with the queued message from this server's page; 409 carries resumable; 400 names the bad field", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { host } = makeHost(async function* (_o, next) {
      yield init();
      await hold;
      const m = await next();
      yield lifecycle(String(m?.uuid), "started");
      yield result();
      await next();
    });
    const app = new Hono();
    app.route("/api/agents", agentRoutes(host, async () => ({ ok: true })));
    const post = (path: string, body: unknown, origin = "http://localhost:4475") =>
      app.request(`http://localhost:4475/api/agents${path}`, {
        method: "POST",
        headers: { host: "localhost:4475", origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const a = host.start({ cwd: scratch(), prompt: "go" });
    await until(() => host.get(a.id).status === "working");

    const bad = await post(`/${a.id}/message`, { comment: { file: "a", line: -1, lineText: "", text: "x" } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("comment.line");

    expect((await post(`/${a.id}/message`, { text: "hi" }, "https://evil.example")).status).toBe(403);

    const ok = await post(`/${a.id}/message`, { text: "hi" });
    expect(ok.status).toBe(202);
    const j = (await ok.json()) as { message: { state: string; text: string }; agent: { id: string } };
    expect(j.message).toMatchObject({ state: "queued", text: "hi" });
    expect(j.agent.id).toBe(a.id);

    release();
    await until(() => !host.get(a.id).running);
    const refused = await post(`/${a.id}/message`, { text: "again" });
    expect(refused.status).toBe(409);
    const rj = (await refused.json()) as { error: string; resumable: boolean; status: string };
    expect(rj.resumable).toBe(true);
    expect(rj.status).toBe("done");
    expect(rj.error).toContain("not running");
  });
});
