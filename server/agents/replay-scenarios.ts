import type { AgentHost, AgentView } from "./host";

/**
 * What each recorded run does, in one place (#242). scripts/record-agent-replays.ts drives a
 * real agent through these; the replay tests and the desktop checks drive the replayed agent
 * through the very same steps, so a replay is always used the way it was recorded.
 */
export interface Scenario {
  name: string;
  /** The first turn's prompt (kept tiny: recording one costs plan usage). */
  prompt: string;
  /** Drive the host the way a person would on the screens; resolves when the scenario is over. */
  drive(host: AgentHost, cwd: string, opts?: { timeoutMs?: number }): Promise<AgentView>;
}

const ENDED = new Set(["done", "failed", "stopped"]);

async function until(host: AgentHost, id: string, pred: (a: AgentView) => boolean, what: string, timeoutMs: number, endedIsFine = false): Promise<AgentView> {
  const t0 = Date.now();
  for (;;) {
    const a = host.get(id);
    if (pred(a)) return a;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what} (status ${a.status})`);
    if (!endedIsFine && ENDED.has(a.status) && !pred(a)) throw new Error(`the agent ended (${a.status}: ${a.reason ?? "no reason"}) before ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const WRITE_PROMPT = "Use the Write tool to create a file named hello.txt in the current folder containing the single word hi. Then reply with the single word: done.";

/** Start, wait for the permission request, answer it, wait for the end. */
function answered(name: string, decision: "allow" | "deny"): Scenario {
  return {
    name,
    prompt: WRITE_PROMPT,
    async drive(host, cwd, opts) {
      const t = opts?.timeoutMs ?? 120_000;
      const { id } = host.start({ cwd, prompt: WRITE_PROMPT });
      const asked = await until(host, id, (a) => a.pendingPermissions.length > 0, "a permission request", t);
      const req = asked.pendingPermissions[0];
      host.answer(id, req.requestId, decision === "allow" ? { decision: "allow" } : { decision: "deny", message: "not now" });
      return until(host, id, (a) => ENDED.has(a.status), "the end of the run", t);
    },
  };
}

export const SCENARIOS: Scenario[] = [
  {
    name: "plain",
    prompt: "Reply with the single word: ok. Do not use any tools.",
    async drive(host, cwd, opts) {
      const { id } = host.start({ cwd, prompt: this.prompt });
      return until(host, id, (a) => ENDED.has(a.status), "the end of the run", opts?.timeoutMs ?? 120_000);
    },
  },
  answered("allow", "allow"),
  answered("deny", "deny"),
  {
    name: "stop-resume",
    prompt: WRITE_PROMPT,
    async drive(host, cwd, opts) {
      const t = opts?.timeoutMs ?? 120_000;
      const { id } = host.start({ cwd, prompt: WRITE_PROMPT });
      // Stopped while it waits on you: the request is withdrawn and the run ends.
      await until(host, id, (a) => a.pendingPermissions.length > 0, "a permission request", t);
      host.stop(id);
      // The status is "stopped" at once; the Claude Code process takes a moment to exit.
      await until(host, id, (a) => a.status === "stopped" && !a.running, "the stop", t, true);
      host.resume(id, "Do not create the file. Reply with the single word: resumed. Do not use any tools.");
      return until(host, id, (a) => ENDED.has(a.status) && a.runs === 2, "the end of the resumed run", t);
    },
  },
];
