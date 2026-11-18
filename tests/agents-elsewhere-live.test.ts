import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentHost, type HostEvent, type QueryFn } from "../server/agents/host";
import { AgentRegistry, type AgentOwner } from "../server/agents/registry";
import { loginOnlyEnv, type ClaudeBinary } from "../server/agents/login";
import { createAgentHost } from "../server/routes/agents";

/**
 * #223: an agent another AnviDeck server runs changes only on disk (registry and transcript);
 * that server pushes its changes only to its own pages. This server reads them and pushes
 * them to its pages too, so its screens follow the agent without a reload.
 */

const dirs: string[] = [];
const scratch = (p = "agents-elsewhere-") => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const CLAUDE: ClaudeBinary = { path: "/fake/bin/claude", realPath: "/fake/lib/claude", fileId: "1:1:1" };
const init = (session_id: string) =>
  ({ type: "system", subtype: "init", apiKeySource: "none", session_id, claude_code_version: "2", model: "m", cwd: "/x", tools: [], mcp_servers: [], permissionMode: "default", slash_commands: [], output_style: "default", uuid: "u" }) as unknown as SDKMessage;

/** Keeps working until aborted, like a long agent. */
const longJob: QueryFn = ({ options }) =>
  (async function* () {
    yield init(`sess-${options.cwd}`);
    await new Promise((_, rej) => (options as Options).abortController!.signal.addEventListener("abort", () => rej(new Error("aborted"))));
  })();

const alive = new Set<string>();

function server(dir: string, port: number) {
  const owner: Partial<AgentOwner> = { pid: 91000 + port, port, instance: `srv-${port}-${Math.random().toString(36).slice(2)}` };
  alive.add(owner.instance!);
  const events: HostEvent[] = [];
  const host = new AgentHost({
    registry: new AgentRegistry(dir),
    query: longJob,
    resolveClaude: () => CLAUDE,
    env: () => loginOnlyEnv({ PATH: "/usr/bin" }),
    owner,
    ownerAlive: (o) => alive.has(o.instance),
    emit: (e) => events.push(e),
  });
  return { host, events, die: () => alive.delete(owner.instance!) };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await tick();
  }
}
const agentEvents = (ev: HostEvent[], id: string) => ev.filter((e) => e.type === "agent" && e.data.id === id).map((e) => e.data as { status: string; runsElsewhere?: unknown });
const lineSeqs = (ev: HostEvent[], id: string) => ev.flatMap((e) => (e.type === "agent-message" && e.data.id === id ? [e.data.line.seq] : []));

describe("another server's agent, on this server's pages (#223)", () => {
  test("a status change and the lines it wrote are pushed once each, after the first read", async () => {
    const dir = scratch();
    const A = server(dir, 4301);
    const B = server(dir, 4302);
    const a = A.host.start({ cwd: scratch(), prompt: "A's job" });
    await until(() => A.host.get(a.id).status === "working");
    B.host.pollOthers();
    // The first read only notes where things stand: the pages read the list themselves.
    expect(B.events).toEqual([]);
    const before = new AgentRegistry(dir).readTranscript(a.id).lines.length;

    A.host.stop(a.id);
    B.host.pollOthers();
    // Stopped at once; its Claude Code process may still be exiting on A, so A still holds it.
    expect(agentEvents(B.events, a.id).map((v) => v.status)).toEqual(["stopped"]);
    await until(() => !new AgentRegistry(dir).load().find((r) => r.id === a.id)!.processAlive);
    B.host.pollOthers();
    const pushed = agentEvents(B.events, a.id);
    expect(pushed.every((v) => v.status === "stopped")).toBe(true);
    expect(pushed.at(-1)!.runsElsewhere).toBeUndefined();
    // Exactly the lines A wrote after the first read, in order.
    const all = new AgentRegistry(dir).readTranscript(a.id).lines;
    expect(all.length).toBeGreaterThan(before);
    expect(lineSeqs(B.events, a.id)).toEqual(all.slice(before).map((l) => l.seq));

    // Nothing changed since: nothing is pushed again.
    B.events.length = 0;
    B.host.pollOthers();
    expect(B.events).toEqual([]);
  });

  test("while it runs, the row says it runs elsewhere; a server that dies without writing is shown stopped", async () => {
    const dir = scratch();
    const A = server(dir, 4303);
    const B = server(dir, 4304);
    B.host.pollOthers();
    const a = A.host.start({ cwd: scratch(), prompt: "A's job" });
    await until(() => A.host.get(a.id).status === "working");
    B.host.pollOthers();
    // New since the first read: pushed with its lines so far.
    const seen = agentEvents(B.events, a.id);
    expect(seen.at(-1)!.status).toBe("working");
    expect(seen.at(-1)!.runsElsewhere).toEqual({ pid: 91000 + 4303, port: 4303 });
    expect(lineSeqs(B.events, a.id)).toEqual(new AgentRegistry(dir).readTranscript(a.id).lines.map((l) => l.seq));

    B.events.length = 0;
    A.die(); // no write: the file still says working
    B.host.pollOthers();
    const after = agentEvents(B.events, a.id);
    expect(after.length).toBe(1);
    expect(after[0].status).toBe("stopped");
    expect(after[0].runsElsewhere).toBeUndefined();
  });

  test("a line still being written is pushed only once it is whole", async () => {
    const dir = scratch();
    const A = server(dir, 4305);
    const B = server(dir, 4306);
    const a = A.host.start({ cwd: scratch(), prompt: "A's job" });
    await until(() => A.host.get(a.id).status === "working");
    B.host.pollOthers();
    const reg = new AgentRegistry(dir);
    const next = reg.readTranscript(a.id).lines.at(-1)!.seq + 1;
    const line = JSON.stringify({ seq: next, at: new Date().toISOString(), from: "sdk", message: { type: "assistant", text: "héllo, wörld" } });
    appendFileSync(reg.transcriptPath(a.id), line.slice(0, 20));
    B.host.pollOthers();
    expect(lineSeqs(B.events, a.id)).toEqual([]);
    appendFileSync(reg.transcriptPath(a.id), line.slice(20) + "\n");
    B.host.pollOthers();
    expect(lineSeqs(B.events, a.id)).toEqual([next]);
    B.host.pollOthers();
    expect(lineSeqs(B.events, a.id)).toEqual([next]);
    A.host.stop(a.id);
  });

  test("this server's own running agent is not pushed again by the read", async () => {
    const dir = scratch();
    const B = server(dir, 4308);
    B.host.pollOthers();
    const b = B.host.start({ cwd: scratch(), prompt: "B's job" });
    await until(() => B.host.get(b.id).status === "working");
    B.events.length = 0;
    B.host.pollOthers();
    expect(B.events).toEqual([]);
    B.host.stop(b.id);
    // Its stop was pushed as it happened; the next read finds it new and stopped, and adds nothing the pages lack.
    B.events.length = 0;
    B.host.pollOthers();
    expect(lineSeqs(B.events, b.id)).toEqual([]);
  });

  test("an unreadable registry pushes no agent, tells the pages once (#297), and the read resumes once it is fixed", async () => {
    const dir = scratch();
    const A = server(dir, 4309);
    const B = server(dir, 4310);
    const a = A.host.start({ cwd: scratch(), prompt: "A's job" });
    await until(() => A.host.get(a.id).status === "working");
    const before = Date.now();
    B.host.pollOthers();
    const good = new AgentRegistry(dir).load();
    writeFileSync(join(dir, "agents.json"), "{ not json");
    expect(() => B.host.pollOthers()).not.toThrow();
    B.host.pollOthers(); // still unreadable: said once, not on every read
    const watch = B.events.filter((e) => e.type === "agents-watch");
    expect(watch).toHaveLength(1);
    expect(B.events.filter((e) => e.type !== "agents-watch")).toEqual([]);
    const w = watch[0].data as { unread: string | null; since?: string };
    expect(w.unread).toContain("the agent registry could not be read");
    // `since` is the last good read: the one before the file broke.
    expect(Date.parse(w.since!)).toBeGreaterThanOrEqual(before - 5);
    expect(Date.parse(w.since!)).toBeLessThanOrEqual(Date.now());
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: good.map((r) => (r.id === a.id ? { ...r, status: "done" } : r)) }));
    B.host.pollOthers();
    expect(B.events.filter((e) => e.type === "agents-watch").map((e) => e.data)).toEqual([w, { unread: null }]);
    expect(agentEvents(B.events, a.id).map((v) => v.status)).toEqual(["done"]);
    B.host.pollOthers();
    expect(B.events.filter((e) => e.type === "agents-watch")).toHaveLength(2);
    A.host.stop(a.id);
  });

  test("a registry unreadable from the watch's first read is said without a since", () => {
    const dir = scratch();
    const B = server(dir, 4311);
    writeFileSync(join(dir, "agents.json"), "{ not json");
    B.host.pollOthers();
    expect(B.events.map((e) => e.type)).toEqual(["agents-watch"]);
    expect((B.events[0].data as { since?: string }).since).toBeUndefined();
  });
});

describe("the real server watches (#223)", () => {
  test("createAgentHost starts the read, and a change made by another server reaches this server's WebSocket", async () => {
    const dir = scratch();
    const A = server(dir, 4311);
    const a = A.host.start({ cwd: scratch(), prompt: "A's job" });
    await until(() => A.host.get(a.id).status === "working");
    const sent: string[] = [];
    const broadcast = (m: string) => void sent.push(m);
    const B = createAgentHost(broadcast, () => new AgentHost({
      registry: new AgentRegistry(dir),
      emit: (e) => broadcast(JSON.stringify(e)),
      query: longJob,
      resolveClaude: () => CLAUDE,
      env: () => loginOnlyEnv({ PATH: "/usr/bin" }),
      owner: { pid: 91000 + 4312, port: 4312, instance: "srv-4312-watch" },
      ownerAlive: (o) => alive.has(o.instance) || o.instance === "srv-4312-watch",
    }));
    try {
      A.host.stop(a.id);
      await until(() => sent.some((m) => { const e = JSON.parse(m); return e.type === "agent" && e.data.id === a.id && e.data.status === "stopped"; }), 5000);
    } finally {
      B.stopAll("test over");
    }
  });
});
