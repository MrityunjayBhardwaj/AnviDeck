import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "../server/agents/host";
import { AgentRegistry } from "../server/agents/registry";
import { loginOnlyEnv } from "../server/agents/login";
import { parseRecording, replayQuery, replayShape, type Recording } from "../server/agents/replay";
import { cleanRecording } from "../server/agents/replay-clean";
import { SCENARIOS } from "../server/agents/replay-scenarios";

/**
 * #242: real agent runs, recorded once (scripts/record-agent-replays.ts) and played back into
 * the real agent host. Each scenario is driven through the same steps it was recorded with.
 * No Claude Code process runs and no plan usage is spent.
 */

const FIXTURES = join(import.meta.dir, "fixtures", "replays");
const dirs: string[] = [];
const scratch = (p = "agent-replays-") => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function recordings(name: string): Recording[] {
  const files = readdirSync(FIXTURES).filter((f) => f === `${name}.jsonl` || (f.startsWith(`${name}.`) && /\.\d+\.jsonl$/.test(f))).sort();
  if (!files.length) throw new Error(`no recording named ${name} in ${FIXTURES}`);
  return files.map((f) => parseRecording(readFileSync(join(FIXTURES, f), "utf8")));
}

function hostFor(name: string) {
  const q = replayQuery(recordings(name));
  const host = new AgentHost({
    registry: new AgentRegistry(scratch()),
    query: q,
    resolveClaude: () => ({ path: "/fake/claude", realPath: "/fake/claude-2", fileId: "1:1:1" }),
    env: () => loginOnlyEnv({ PATH: "/usr/bin" }),
    emit: () => {},
  });
  return { host, q };
}

const scenario = (name: string) => SCENARIOS.find((s) => s.name === name)!;
const events = (host: AgentHost, id: string) =>
  host.transcript(id).lines.filter((l) => l.from === "host").map((l) => (l.message as { event?: string }).event);
const transcriptText = (host: AgentHost, id: string) => JSON.stringify(host.transcript(id).lines);

describe("replayed agent runs, through the real agent host (#242)", () => {
  test("plain: the run ends done, on the login (apiKeySource none), with the recorded model", async () => {
    const { host, q } = hostFor("plain");
    const a = await scenario("plain").drive(host, scratch(), { timeoutMs: 5000 });
    expect(a.status).toBe("done");
    expect(a.apiKeySource).toBe("none");
    expect(a.model).toBeTruthy();
    expect(q.calls).toBe(1);
  });

  test("allow: the Write request waits on you; Allow lets it run and the agent finishes", async () => {
    const { host } = hostFor("allow");
    const a = await scenario("allow").drive(host, scratch(), { timeoutMs: 5000 });
    expect(a.status).toBe("done");
    expect(events(host, a.id)).toContain("permission-asked");
    expect(transcriptText(host, a.id)).toContain("File created successfully");
  });

  test("deny: Deny with a message reaches the agent, which finishes without the file", async () => {
    const { host } = hostFor("deny");
    const a = await scenario("deny").drive(host, scratch(), { timeoutMs: 5000 });
    expect(a.status).toBe("done");
    expect(transcriptText(host, a.id)).toContain("not now");
  });

  test("stop-resume: stopping withdraws the waiting request; a resume runs a second time and ends done", async () => {
    const { host, q } = hostFor("stop-resume");
    const a = await scenario("stop-resume").drive(host, scratch(), { timeoutMs: 5000 });
    expect(a.status).toBe("done");
    expect(a.runs).toBe(2);
    expect(q.calls).toBe(2);
    expect(events(host, a.id)).toEqual(expect.arrayContaining(["started", "permission-asked", "resumed"]));
  });

  test("an answer the recording did not give stops the replay with the reason, never a made-up run", async () => {
    const { host } = hostFor("allow");
    // Drive the allow recording, but answer Deny.
    const a = await scenario("deny").drive(host, scratch(), { timeoutMs: 5000 });
    expect(a.status).toBe("failed");
    expect(a.reason).toContain("the recording answered Write with allow; the host answered deny");
  });
});

describe("the recordings in the repo", () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".jsonl"));

  test("every scenario has its recordings, and each names the Claude Code and SDK it came from", () => {
    for (const s of SCENARIOS) expect(recordings(s.name).length).toBeGreaterThan(0);
    for (const f of files) {
      const meta = parseRecording(readFileSync(join(FIXTURES, f), "utf8"))[0];
      expect(meta.k).toBe("meta");
      if (meta.k === "meta") {
        expect(meta.claudeCode).toMatch(/^\d+\.\d+\.\d+/);
        expect(meta.sdk).toMatch(/^\d+\.\d+\.\d+/);
      }
    }
  });

  test("carry nothing about the machine they were recorded on (the cleaner's own leak check passes again)", () => {
    for (const f of files) {
      const steps = parseRecording(readFileSync(join(FIXTURES, f), "utf8"));
      expect(() => cleanRecording(steps, { cwd: "", home: process.env.HOME ?? "" })).not.toThrow();
      const text = JSON.stringify(steps);
      expect(text).not.toMatch(/mcp__|"skills":\[[^\]]|"plugins":\[[^\]]|credential_expires_at/);
    }
  });

  test("the cleaner refuses a recording that still names a home folder or an email", () => {
    // The recorder's own home is swapped for a placeholder; what is left over is refused.
    const name: Recording = [{ k: "meta", name: "x", recordedAt: "t", claudeCode: "1.0.0", sdk: "1.0.0", prompt: "ask someone about it" }];
    expect(() => cleanRecording(name, { cwd: "", home: "/Users/someone" })).toThrow('the user name "someone"');
    const other: Recording = [{ k: "meta", name: "x", recordedAt: "t", claudeCode: "1.0.0", sdk: "1.0.0", prompt: "see /Users/another/x" }];
    expect(() => cleanRecording(other, { cwd: "", home: "/Users/someone" })).toThrow("a home folder path");
    const mail: Recording = [{ k: "meta", name: "x", recordedAt: "t", claudeCode: "1.0.0", sdk: "1.0.0", prompt: "mail a@b.co" }];
    expect(() => cleanRecording(mail, { cwd: "", home: "/h/x" })).toThrow("an email address");
  });
});

describe("the drift check's shape (record-agent-replays.ts --check)", () => {
  test("names the turns, asks and results, and ignores messages whose number varies", () => {
    expect(replayShape(recordings("allow")[0])).toEqual(["input", "system:init", "assistant", "ask Write", "answer allow", "user", "assistant", "result"]);
  });

  test("a field the host reads gone from init, or a permission request no longer asked, is a different shape", () => {
    const rec = recordings("allow")[0];
    const noKeySource = rec.map((st) => (st.k === "sdk" && (st.m as { subtype?: string }).subtype === "init" ? { ...st, m: { ...st.m, apiKeySource: undefined } as typeof st.m } : st))
      .map((st) => (st.k === "sdk" ? { ...st, m: JSON.parse(JSON.stringify(st.m)) } : st));
    expect(replayShape(noKeySource)).toContain("system:init (missing apiKeySource)");
    const noAsk = rec.filter((st) => st.k !== "ask" && st.k !== "answer");
    expect(replayShape(noAsk)).not.toEqual(replayShape(rec));
  });
});

describe("replay mode for the desktop checks (ANVIDECK_AGENT_REPLAY)", () => {
  test("off unless asked; when asked, plays the named recordings in order, a resume's second run included", async () => {
    const { replayFromEnv } = await import("../server/agents/replay");
    expect(replayFromEnv({})).toBeNull();
    const r = replayFromEnv({ ANVIDECK_AGENT_REPLAY: "plain,stop-resume", ANVIDECK_AGENT_REPLAY_DIR: FIXTURES, ANVIDECK_AGENT_REPLAY_PACE_MS: "0" })!;
    expect(r.names).toEqual(["plain.jsonl", "stop-resume.1.jsonl", "stop-resume.2.jsonl"]);
    expect(() => replayFromEnv({ ANVIDECK_AGENT_REPLAY: "nope", ANVIDECK_AGENT_REPLAY_DIR: FIXTURES })).toThrow("no recording named nope");
    expect(() => replayFromEnv({ ANVIDECK_AGENT_REPLAY: "plain" })).toThrow("ANVIDECK_AGENT_REPLAY_DIR");
  });
});
