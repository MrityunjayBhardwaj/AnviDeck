import type { PermissionResult, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { QueryFn } from "./host";

/**
 * Recorded agent runs, played back into the real agent host (#242).
 *
 * A check that involves an agent used to either feed the host hand-written SDK messages, which
 * can drift from what Claude Code really sends, or run a real agent, which costs plan usage. A
 * recording is what one real `query()` call did, step by step:
 *
 *   input   the SDK took the next user message from the host (a turn's prompt)
 *   sdk     the SDK yielded this message
 *   ask     Claude Code asked the host's permission callback (canUseTool) about a tool call
 *   answer  the callback answered (allow / deny)
 *   end     the stream ended, normally or with an error (its message)
 *
 * replayQuery() is a QueryFn: it plays those steps against the real host. Only the Claude Code
 * process is replaced. The registry, the permission callback, the events and the screens all run
 * for real. When the host answers a permission differently from the recording, the replay
 * stops with ReplayDiverged instead of inventing what Claude Code would have done.
 */

export type ReplayStep =
  | { k: "meta"; name: string; recordedAt: string; claudeCode: string | null; sdk: string | null; prompt: string }
  | { k: "input" }
  | { k: "sdk"; m: SDKMessage }
  | { k: "ask"; toolName: string; input: Record<string, unknown>; decisionReason?: string; blockedPath?: string; toolUseID?: string; agentID?: string }
  | { k: "answer"; behavior: "allow" | "deny" | "none" }
  | { k: "end"; error?: string };

/** Placeholders a recording carries instead of this machine's folders. */
export const CWD = "<cwd>";
export const HOME = "<home>";

export class ReplayDiverged extends Error {}

/** One recording per query() call; a resume is a second call. */
export type Recording = ReplayStep[];

/** Parse a recording file (one JSON step per line). */
export function parseRecording(text: string): Recording {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l) as ReplayStep;
      } catch (e) {
        throw new Error(`recording line ${i + 1} is not JSON: ${(e as Error).message}`);
      }
    });
}

/** Swap every occurrence of `from` for `to` in a JSON-shaped value. */
function swap<T>(v: T, pairs: [string, string][]): T {
  let s = JSON.stringify(v);
  for (const [from, to] of pairs) if (from) s = s.split(from).join(to);
  return JSON.parse(s) as T;
}

/**
 * Wrap the real query() so each call is written down. `sink` gets every step as it happens;
 * the recorder never changes what passes through.
 */
export function recordingQuery(real: QueryFn, sink: (step: ReplayStep) => void): QueryFn {
  return ({ prompt, options }) => {
    async function* inputs(): AsyncGenerator<SDKUserMessage> {
      for await (const m of prompt) {
        sink({ k: "input" });
        yield m;
      }
    }
    const canUseTool = options.canUseTool;
    const wrapped = {
      ...options,
      ...(canUseTool
        ? {
            canUseTool: async (toolName: string, input: Record<string, unknown>, o: Parameters<NonNullable<typeof canUseTool>>[2]) => {
              sink({ k: "ask", toolName, input, decisionReason: o.decisionReason, blockedPath: o.blockedPath, toolUseID: o.toolUseID, ...(o.agentID ? { agentID: o.agentID } : {}) });
              const r = await canUseTool(toolName, input, o);
              sink({ k: "answer", behavior: r?.behavior ?? "none" });
              return r;
            },
          }
        : {}),
    };
    const q = real({ prompt: inputs(), options: wrapped });
    async function* out(): AsyncGenerator<SDKMessage> {
      try {
        for await (const m of q) {
          sink({ k: "sdk", m });
          yield m;
        }
        sink({ k: "end" });
      } catch (e) {
        sink({ k: "end", error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    }
    const it = out() as AsyncGenerator<SDKMessage> & { close?: () => void };
    it.close = q.close?.bind(q);
    return it;
  };
}

/**
 * A QueryFn that plays recordings: the first call plays recordings[0], the next recordings[1]
 * (a resume), and so on. `paceMs` waits between yielded messages, so a screen can show the
 * agent working; 0 in unit tests.
 */
export function replayQuery(recordings: Recording[], opts: { paceMs?: number } = {}): QueryFn & { calls: number } {
  let call = 0;
  const fn = (({ prompt, options }: Parameters<QueryFn>[0]) => {
    const rec = recordings[call++];
    if (!rec) throw new ReplayDiverged(`no recording for query() call ${call}: only ${recordings.length} recorded`);
    const pairs: [string, string][] = [[CWD, options.cwd ?? ""], [HOME, process.env.HOME ?? ""]];
    const steps = swap(rec, pairs);
    const abort = options.abortController?.signal;
    const promptIt = prompt[Symbol.asyncIterator]();
    const aborted = () => new Promise<never>((_, rej) => {
      if (abort?.aborted) rej(new Error("aborted"));
      abort?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
    });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    async function* play(): AsyncGenerator<SDKMessage> {
      const end = steps.find((s) => s.k === "end") as Extract<ReplayStep, { k: "end" }> | undefined;
      try {
        for (let i = 0; i < steps.length; i++) {
          const s = steps[i];
          if (abort?.aborted) break;
          if (s.k === "input") {
            const next = await Promise.race([promptIt.next(), aborted()]);
            if (next.done) return;
          } else if (s.k === "sdk") {
            if (opts.paceMs) await Promise.race([sleep(opts.paceMs), aborted()]);
            yield s.m;
          } else if (s.k === "ask") {
            const want = steps[i + 1];
            if (!options.canUseTool) throw new ReplayDiverged(`the recording asks about ${s.toolName}, but the host gave no permission callback`);
            const ctl = new AbortController();
            abort?.addEventListener("abort", () => ctl.abort(), { once: true });
            const r: PermissionResult | null = await Promise.race([
              options.canUseTool(s.toolName, s.input, {
                signal: ctl.signal, decisionReason: s.decisionReason, blockedPath: s.blockedPath,
                // Recordings made before #267 have neither id: the ask then plays as the agent's own.
                ...(s.toolUseID ? { toolUseID: s.toolUseID } : {}),
                ...(s.agentID ? { agentID: s.agentID } : {}),
              } as Parameters<NonNullable<typeof options.canUseTool>>[2]),
              aborted(),
            ]);
            const got = r?.behavior ?? "none";
            if (want?.k === "answer" && want.behavior !== got) {
              throw new ReplayDiverged(`the recording answered ${s.toolName} with ${want.behavior}; the host answered ${got}`);
            }
            i++; // the answer step
          } else if (s.k === "end") {
            if (s.error) throw new Error(s.error);
            return;
          }
        }
      } catch (e) {
        if (e instanceof ReplayDiverged) throw e;
        // Stopped by the host: end the way the recorded run ended, if it was stopped too.
        if (abort?.aborted) throw new Error(end?.error ?? "aborted");
        throw e;
      }
      if (abort?.aborted) throw new Error(end?.error ?? "aborted");
    }
    const it = play() as AsyncGenerator<SDKMessage> & { close?: () => void };
    it.close = () => void it.return(undefined);
    return it;
  }) as unknown as QueryFn & { calls: number };
  Object.defineProperty(fn, "calls", { get: () => call });
  return fn;
}

/** System messages whose number varies from run to run (commands reloaded, thinking ticks, hooks). */
const NOISE = new Set(["commands_changed", "thinking_tokens", "hook_started", "hook_response", "hook_progress", "background_tasks_changed", "task_started", "task_notification"]);
/** What the agent host reads off these messages; a recording missing one would replay a different run. */
const READ_FIELDS: Record<string, string[]> = { "system:init": ["session_id", "apiKeySource", "model", "claude_code_version"], result: ["subtype", "is_error"] };

/**
 * The shape of a recording that must not drift: the order of turns, asks, answers and results,
 * and that the fields the host reads are there. Used by `record-agent-replays.ts --check` to
 * compare a fresh real run with the recording in the repo.
 */
export function replayShape(rec: Recording): string[] {
  const out: string[] = [];
  for (const s of rec) {
    if (s.k === "meta") continue;
    if (s.k !== "sdk") {
      out.push(s.k === "ask" ? `ask ${s.toolName}${s.agentID ? " (subagent)" : ""}` : s.k === "answer" ? `answer ${s.behavior}` : s.k === "end" ? `end${s.error ? " (error)" : ""}` : s.k);
      continue;
    }
    const m = s.m as unknown as Record<string, unknown>;
    if (m.type === "system" && NOISE.has(String(m.subtype))) continue;
    if (m.type === "rate_limit_event") continue;
    const key = m.type === "system" ? `system:${m.subtype}` : String(m.type);
    const missing = (READ_FIELDS[key] ?? []).filter((f) => !(f in m));
    // Consecutive assistant messages are one reply split in parts; their number varies.
    if (key === "assistant" && out[out.length - 1] === "assistant") continue;
    out.push(missing.length ? `${key} (missing ${missing.join(", ")})` : key);
  }
  return out;
}

/**
 * Replay mode for the desktop checks (#242): ANVIDECK_AGENT_REPLAY names the recordings to
 * play, in order ("allow,deny,stop-resume"), from ANVIDECK_AGENT_REPLAY_DIR. Every agent the
 * server starts then plays the next recording instead of running Claude Code: nothing runs on
 * disk and no plan usage is spent. Null when replay mode is off (the normal case).
 */
export function replayFromEnv(env: Record<string, string | undefined> = process.env): { query: QueryFn; names: string[] } | null {
  const list = env.ANVIDECK_AGENT_REPLAY?.trim();
  if (!list) return null;
  const dir = env.ANVIDECK_AGENT_REPLAY_DIR;
  if (!dir) throw new Error("ANVIDECK_AGENT_REPLAY is set but ANVIDECK_AGENT_REPLAY_DIR is not");
  const names: string[] = [];
  const recs: Recording[] = [];
  for (const name of list.split(",").map((s) => s.trim()).filter(Boolean)) {
    const files = readdirSync(dir).filter((f) => f === `${name}.jsonl` || new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+\\.jsonl$`).test(f)).sort();
    if (!files.length) throw new Error(`no recording named ${name} in ${dir}`);
    for (const f of files) {
      names.push(f);
      recs.push(parseRecording(readFileSync(join(dir, f), "utf8")));
    }
  }
  return { query: replayQuery(recs, { paceMs: Number(env.ANVIDECK_AGENT_REPLAY_PACE_MS ?? 150) }), names };
}
