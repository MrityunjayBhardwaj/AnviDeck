import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentHost, HostError, type QueryFn } from "../server/agents/host";
import { AgentRegistry, ownerProcessAlive, RegistryLockedError, type AgentOwner, type AgentRecord } from "../server/agents/registry";
import { loginOnlyEnv, type ClaudeBinary } from "../server/agents/login";
import { agentRoutes, createAgentHost } from "../server/routes/agents";

/**
 * #104: several AnviDeck servers share one agent registry. Each agent names the server that
 * runs it; a write changes only its own records; a starting server leaves another live server's
 * agents alone and marks stopped only those whose server is gone.
 */

const dirs: string[] = [];
const scratch = (p = "agent-owners-") => {
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
const result = { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, num_turns: 1, duration_ms: 1, duration_api_ms: 1, stop_reason: null, usage: {}, modelUsage: {}, session_id: "s", uuid: "r" } as unknown as SDKMessage;

/** Keeps working until aborted, like a long agent. */
const longJob: QueryFn = ({ options }) =>
  (async function* () {
    yield init(`sess-${options.cwd}`);
    await new Promise((_, rej) => (options as Options).abortController!.signal.addEventListener("abort", () => rej(new Error("aborted"))));
  })();
const quickJob: QueryFn = () =>
  (async function* () {
    yield init("sess-quick");
    yield result;
  })();

/** Which servers are alive, by instance: the test's stand-in for process.kill(pid, 0). */
const alive = new Set<string>();

function server(dir: string, port: number, query: QueryFn = longJob) {
  const owner: Partial<AgentOwner> = { pid: 90000 + port, port, instance: `srv-${port}-${Math.random().toString(36).slice(2)}` };
  alive.add(owner.instance!);
  const host = new AgentHost({
    registry: new AgentRegistry(dir),
    query,
    resolveClaude: () => CLAUDE,
    env: () => loginOnlyEnv({ PATH: "/usr/bin" }),
    owner,
    ownerAlive: (o) => alive.has(o.instance),
  });
  /** The server process goes away without stopping anything (crash, kill, restart). */
  const die = () => alive.delete(owner.instance!);
  return { host, die, owner };
}

const onDisk = (dir: string): AgentRecord[] => JSON.parse(readFileSync(join(dir, "agents.json"), "utf8")).agents;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await tick();
  }
}

describe("two servers sharing one agent registry (#104)", () => {
  test("a write by one server does not drop the other's agents", async () => {
    const dir = scratch();
    const A = server(dir, 4135);
    const B = server(dir, 4136);
    const a = A.host.start({ cwd: scratch(), prompt: "A's job" });
    const b = B.host.start({ cwd: scratch(), prompt: "B's job" });
    await until(() => A.host.get(a.id).status === "working" && B.host.get(b.id).status === "working");
    // A writes again after B's start (a status change): B's agent must still be in the file.
    A.host.stop(a.id);
    const ids = onDisk(dir).map((r) => r.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
    // Each record names the server that runs it.
    expect(onDisk(dir).find((r) => r.id === b.id)!.owner!.port).toBe(4136);
    // Both servers list both agents; each sees the other's as running elsewhere.
    const fromA = A.host.get(b.id);
    expect(fromA.status).toBe("working");
    expect(fromA.running).toBe(false);
    expect(fromA.runsElsewhere).toEqual({ pid: 94136, port: 4136 });
    expect(B.host.list().map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(B.host.get(b.id).runsElsewhere).toBeUndefined();
    B.host.stopAll("test over");
  });

  test("a server that restarts leaves the other live server's agent working, in both servers", async () => {
    const dir = scratch();
    const A = server(dir, 4135);
    const B = server(dir, 4136);
    const a = A.host.start({ cwd: scratch(), prompt: "long" });
    await until(() => A.host.get(a.id).status === "working");
    B.die();
    const B2 = server(dir, 4136); // B restarted
    expect(onDisk(dir).find((r) => r.id === a.id)!.status).toBe("working");
    expect(B2.host.get(a.id).status).toBe("working");
    expect(B2.host.get(a.id).runsElsewhere?.port).toBe(4135);
    expect(A.host.get(a.id).status).toBe("working");
    expect(A.host.get(a.id).running).toBe(true);
    // Only its own server can act on it; the others say where it is.
    for (const act of [() => B2.host.stop(a.id), () => B2.host.resume(a.id, "go"), () => B2.host.message(a.id, { text: "hi" }), () => B2.host.answer(a.id, "r1", { decision: "allow" })]) {
      let err: unknown;
      try {
        act();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(HostError);
      expect((err as HostError).status).toBe(409);
      expect((err as HostError).message).toContain("another AnviDeck server (port 4135");
      expect((err as HostError).detail?.runsElsewhere).toEqual({ pid: 94135, port: 4135 });
    }
    A.host.stopAll("test over");
  });

  test("an agent whose server is gone IS marked stopped, with that server named, and can be resumed elsewhere", async () => {
    const dir = scratch();
    const A = server(dir, 4135);
    const a = A.host.start({ cwd: scratch(), prompt: "long" });
    await until(() => A.host.get(a.id).status === "working" && A.host.get(a.id).sessionId !== undefined);
    A.die();
    const B = server(dir, 4136, quickJob);
    const rec = onDisk(dir).find((r) => r.id === a.id)!;
    expect(rec.status).toBe("stopped");
    expect(rec.reason).toContain("port 4135");
    expect(rec.reason).toContain("stopped or restarted");
    expect(B.host.get(a.id).status).toBe("stopped");
    // Resuming it makes this server its owner.
    B.host.resume(a.id, "carry on");
    await until(() => B.host.get(a.id).status === "done");
    expect(onDisk(dir).find((r) => r.id === a.id)!.owner!.port).toBe(4136);
    A.host.stopAll("test over");
  });

  test("a server that dies after the other started is shown as stopped at once, without a write", async () => {
    const dir = scratch();
    const A = server(dir, 4135);
    const B = server(dir, 4136);
    const a = A.host.start({ cwd: scratch(), prompt: "long" });
    await until(() => A.host.get(a.id).status === "working");
    A.die();
    const before = readFileSync(join(dir, "agents.json"), "utf8");
    const seen = B.host.get(a.id);
    expect(seen.status).toBe("stopped");
    expect(seen.runsElsewhere).toBeUndefined();
    // Reading is not writing: the GET path leaves the file as it was.
    expect(readFileSync(join(dir, "agents.json"), "utf8")).toBe(before);
    A.host.stopAll("test over");
  });

  test("a record written before owners were recorded is treated as from a gone server", () => {
    const dir = scratch();
    const now = new Date().toISOString();
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ version: 1, agents: [{ id: "old1", cwd: "/x", prompt: "p", status: "working", createdAt: now, updatedAt: now, runs: 1, messageCount: 0 }] }));
    const B = server(dir, 4136);
    expect(onDisk(dir)[0]!.status).toBe("stopped");
    expect(B.host.get("old1").reason).toContain("names no server");
  });
});

describe("a registry that becomes unreadable while a server runs", () => {
  test("GET /api/agents says it could not read the file and lists only this server's agents, never as all there are", async () => {
    const dir = scratch();
    const A = server(dir, 4135);
    const a = A.host.start({ cwd: scratch(), prompt: "long" });
    await until(() => A.host.get(a.id).status === "working");
    writeFileSync(join(dir, "agents.json"), "{ torn");
    const app = agentRoutes(A.host, async () => ({ ok: true, loggedIn: true }) as never);
    const j = (await (await app.request("/")).json()) as { registryUnread?: string; agents: { id: string }[]; server: { port: number } };
    expect(j.registryUnread).toContain("could not be read");
    expect(j.agents.map((x) => x.id)).toEqual([a.id]);
    expect(j.server.port).toBe(4135);
    A.host.stopAll("test over");
  });
});

describe("the registry's lock", () => {
  test("two processes writing at once each keep the other's records", async () => {
    const dir = scratch();
    const reg = join(import.meta.dir, "..", "server", "agents", "registry.ts");
    const script = `
      const { AgentRegistry } = await import(${JSON.stringify(reg)});
      const r = new AgentRegistry(process.argv[2]);
      const now = new Date().toISOString();
      for (let i = 0; i < 40; i++) r.upsert({ id: process.argv[3] + i, cwd: "/x", prompt: "p", status: "done", createdAt: now, updatedAt: now, runs: 1, messageCount: 0 });
    `;
    const child = join(scratch("agent-owners-child-"), "child.ts");
    writeFileSync(child, script);
    const procs = ["p", "q", "r"].map((tag) => Bun.spawn(["bun", child, dir, tag], { stdout: "pipe", stderr: "pipe" }));
    const codes = await Promise.all(procs.map((p) => p.exited));
    const errs = await Promise.all(procs.map((p) => new Response(p.stderr).text()));
    expect(errs.join("")).toBe("");
    expect(codes).toEqual([0, 0, 0]);
    expect(onDisk(dir).length).toBe(120);
    expect(existsSync(join(dir, "agents.json.lock"))).toBe(false);
  });

  test("a lock left by a dead process is taken over; a live holder's lock is waited for, then reported", () => {
    const dir = scratch();
    const r = new AgentRegistry(dir);
    const now = new Date().toISOString();
    const rec = (id: string): AgentRecord => ({ id, cwd: "/x", prompt: "p", status: "done", createdAt: now, updatedAt: now, runs: 1, messageCount: 0 });
    r.upsert(rec("one"));
    // pid 2^22+7 is beyond macOS's pid range: never a live process.
    writeFileSync(join(dir, "agents.json.lock"), `${4194311} ${Date.now()} x`);
    r.upsert(rec("two"));
    expect(onDisk(dir).map((a) => a.id)).toEqual(["one", "two"]);
    // A live holder (pid 1, launchd/init: always alive) with a fresh lock is not overridden.
    writeFileSync(join(dir, "agents.json.lock"), `1 ${Date.now()} x`);
    const t0 = Date.now();
    expect(() => r.upsert(rec("three"))).toThrow("locked by AnviDeck process 1");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2900);
    expect(onDisk(dir).map((a) => a.id)).toEqual(["one", "two"]);
  });
});

describe("the registry's lock, under contention (review of #226)", () => {
  test("a lock file that exists but is empty (a writer between create and write) is waited for, never taken over", () => {
    const dir = scratch();
    const r = new AgentRegistry(dir, { lockWaitMs: 300 });
    const now = new Date().toISOString();
    const rec = (id: string): AgentRecord => ({ id, cwd: "/x", prompt: "p", status: "done", createdAt: now, updatedAt: now, runs: 1, messageCount: 0 });
    r.upsert(rec("one"));
    const lock = join(dir, "agents.json.lock");
    writeFileSync(lock, "");
    expect(() => r.upsert(rec("two"))).toThrow(RegistryLockedError);
    expect(existsSync(lock)).toBe(true);
    expect(onDisk(dir).map((a) => a.id)).toEqual(["one"]);
    // Once it is older than any real write could take, it is a crashed writer's: taken over.
    const old = new Date(Date.now() - 11_000);
    utimesSync(lock, old, old);
    r.upsert(rec("two"));
    expect(onDisk(dir).map((a) => a.id)).toEqual(["one", "two"]);
    expect(existsSync(lock)).toBe(false);
  });

  test("ten processes writing 150 records each at once keep every record", async () => {
    const dir = scratch();
    const reg = join(import.meta.dir, "..", "server", "agents", "registry.ts");
    const script = `
      const { AgentRegistry } = await import(${JSON.stringify(reg)});
      const r = new AgentRegistry(process.argv[2]);
      const now = new Date().toISOString();
      for (let i = 0; i < 150; i++) r.upsert({ id: process.argv[3] + "_" + i, cwd: "/x", prompt: "p", status: "done", createdAt: now, updatedAt: now, runs: 1, messageCount: 0 });
    `;
    const child = join(scratch("agent-owners-child-"), "child.ts");
    writeFileSync(child, script);
    const procs = Array.from({ length: 10 }, (_, i) => Bun.spawn(["bun", child, dir, `w${i}`], { stdout: "pipe", stderr: "pipe" }));
    const codes = await Promise.all(procs.map((p) => p.exited));
    const errs = await Promise.all(procs.map((p) => new Response(p.stderr).text()));
    expect(errs.join("")).toBe("");
    expect(codes).toEqual(Array(10).fill(0));
    expect(new Set(onDisk(dir).map((a) => a.id)).size).toBe(1500);
    expect(readdirSync(dir).filter((f) => f.includes(".lock"))).toEqual([]);
  }, 60_000);
});

describe("a finished agent whose process is still exiting (review of #226)", () => {
  /** Says done, then takes until `release()` to exit, as Claude Code does after its result. */
  function slowExit() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const query: QueryFn = () =>
      (async function* () {
        yield init("sess-slow");
        yield result;
        await gate;
      })();
    return { query, release };
  }

  test("another server cannot resume it until the process has exited", async () => {
    const dir = scratch();
    const slow = slowExit();
    const A = server(dir, 4135, slow.query);
    const B = server(dir, 4136, quickJob);
    const a = A.host.start({ cwd: scratch(), prompt: "job" });
    await until(() => A.host.get(a.id).status === "done");
    expect(A.host.get(a.id).running).toBe(true);
    expect(B.host.get(a.id).runsElsewhere).toEqual({ pid: 94135, port: 4135 });
    let err: unknown;
    try {
      B.host.resume(a.id, "go on");
    } catch (e) {
      err = e;
    }
    expect((err as HostError).status).toBe(409);
    expect((err as HostError).message).toContain("another AnviDeck server (port 4135");
    slow.release();
    await until(() => !A.host.get(a.id).running);
    expect(onDisk(dir).find((r) => r.id === a.id)!.processAlive).toBeUndefined();
    expect(B.host.get(a.id).runsElsewhere).toBeUndefined();
    B.host.resume(a.id, "go on");
    await until(() => B.host.get(a.id).status === "done");
    expect(onDisk(dir).find((r) => r.id === a.id)!.owner!.port).toBe(4136);
  });

  test("a late write from the old owner never puts back its stale record over another server's claim", async () => {
    const dir = scratch();
    const slow = slowExit();
    const A = server(dir, 4135, slow.query);
    const a = A.host.start({ cwd: scratch(), prompt: "job" });
    await until(() => A.host.get(a.id).status === "done");
    // Another server claims it meanwhile (one that predates the exiting check, or a claim that raced it).
    const claimer: AgentOwner = { pid: 94137, port: 4137, instance: "srv-4137-claim", startedAt: new Date().toISOString() };
    alive.add(claimer.instance);
    new AgentRegistry(dir).update((agents) => ({
      agents: agents.map((r) => (r.id === a.id ? { ...r, owner: claimer, status: "working" as const, processAlive: true } : r)),
      out: undefined,
    }));
    slow.release();
    await until(() => A.host.get(a.id).runsElsewhere !== undefined);
    await tick(30);
    const rec = onDisk(dir).find((r) => r.id === a.id)!;
    expect(rec.owner!.port).toBe(4137);
    expect(rec.status).toBe("working");
    expect(A.host.get(a.id).runsElsewhere).toEqual({ pid: 94137, port: 4137 });
    alive.delete(claimer.instance);
  });
});

describe("an owner whose pid now belongs to another process (#224)", () => {
  test("a pid alive but started after the owner recorded itself is not that owner", async () => {
    const child = Bun.spawn(["sleep", "30"]);
    try {
      await tick(50);
      const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
      const inAMinute = new Date(Date.now() + 60_000).toISOString();
      expect(ownerProcessAlive({ pid: child.pid, startedAt: hourAgo })).toBe(false);
      expect(ownerProcessAlive({ pid: child.pid, startedAt: inAMinute })).toBe(true);
      // ps could not say: the pid alone decides, as before.
      expect(ownerProcessAlive({ pid: child.pid, startedAt: hourAgo }, () => undefined)).toBe(true);
      // A dead pid is never alive, whatever the times say.
      expect(ownerProcessAlive({ pid: 4194311, startedAt: inAMinute })).toBe(false);
    } finally {
      child.kill();
    }
  });

  test("its agent is listed as stopped and can be resumed, with the default liveness check", async () => {
    const child = Bun.spawn(["sleep", "30"]);
    try {
      const dir = scratch();
      const now = new Date().toISOString();
      const deadOwner: AgentOwner = { pid: child.pid, port: 4199, instance: "gone-server", startedAt: new Date(Date.now() - 3_600_000).toISOString() };
      writeFileSync(
        join(dir, "agents.json"),
        JSON.stringify({ version: 1, agents: [{ id: "reused1", owner: deadOwner, sessionId: "S9", cwd: scratch(), prompt: "p", status: "working", createdAt: now, updatedAt: now, runs: 1, messageCount: 0 }] }),
      );
      // No ownerAlive given: the host's own check (pid + start time) decides.
      const host = new AgentHost({ registry: new AgentRegistry(dir), query: quickJob, resolveClaude: () => CLAUDE, env: () => loginOnlyEnv({ PATH: "/usr/bin" }) });
      const seen = host.get("reused1");
      expect(seen.runsElsewhere).toBeUndefined();
      expect(seen.status).toBe("stopped");
      expect(seen.reason).toContain("port 4199");
      host.resume("reused1", "go on");
      await until(() => host.get("reused1").status === "done");
    } finally {
      child.kill();
    }
  });
});

describe("a registry lock held at start-up or at a status write (review of #226)", () => {
  test("the host stays on, never calls the file unreadable, and sweeps once the lock is free", async () => {
    const dir = scratch();
    const now = new Date().toISOString();
    const gone: AgentOwner = { pid: 94190, port: 4190, instance: "gone-at-start", startedAt: now };
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ version: 1, agents: [{ id: "g1", owner: gone, cwd: "/x", prompt: "p", status: "working", createdAt: now, updatedAt: now, runs: 1, messageCount: 0 }] }));
    const lock = join(dir, "agents.json.lock");
    writeFileSync(lock, `1 ${Date.now()} other`); // pid 1 is always alive: a live holder
    const made = createAgentHost(
      () => {},
      () =>
        new AgentHost({
          registry: new AgentRegistry(dir),
          query: quickJob,
          resolveClaude: () => CLAUDE,
          env: () => loginOnlyEnv({ PATH: "/usr/bin" }),
          owner: { pid: 94191, port: 4191, instance: "starter" },
          ownerAlive: (o) => o.instance === "starter",
          retryMs: 50,
        }),
    );
    expect(made.host).not.toBeNull();
    const res = await made.api.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: { id: string; status: string }[] };
    // Not yet written, but already shown as stopped.
    expect(body.agents.find((a) => a.id === "g1")!.status).toBe("stopped");
    expect(onDisk(dir)[0]!.status).toBe("working");
    rmSync(lock);
    await until(() => onDisk(dir)[0]!.status === "stopped", 3000);
  });

  test("a status write that finds the lock held is written once it is free, never dropped", async () => {
    const dir = scratch();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const query: QueryFn = () =>
      (async function* () {
        yield init("sess-held");
        await gate;
        yield result;
      })();
    const host = new AgentHost({
      registry: new AgentRegistry(dir),
      query,
      resolveClaude: () => CLAUDE,
      env: () => loginOnlyEnv({ PATH: "/usr/bin" }),
      owner: { pid: 94192, port: 4192, instance: "w" },
      ownerAlive: (o) => o.instance === "w",
      retryMs: 50,
    });
    const a = host.start({ cwd: scratch(), prompt: "p" });
    await until(() => onDisk(dir).find((r) => r.id === a.id)?.status === "working");
    const lock = join(dir, "agents.json.lock");
    writeFileSync(lock, `1 ${Date.now()} other`);
    release();
    await until(() => host.get(a.id).status === "done" && !host.get(a.id).running, 5000);
    expect(onDisk(dir).find((r) => r.id === a.id)!.status).toBe("working");
    rmSync(lock);
    await until(() => onDisk(dir).find((r) => r.id === a.id)?.status === "done", 3000);
    expect(onDisk(dir).find((r) => r.id === a.id)!.processAlive).toBeUndefined();
  });
});
