import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type {
  Options,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AgentRegistry, LIVE_STATUSES, type AgentRecord, type AgentStatus, type TranscriptLine } from "./registry";
import { explainStartFailure, loginOnlyEnv, resolveClaude, type AgentEnv, type ClaudeBinary } from "./login";

/**
 * The agent host (#75): the only code in AnviDeck that runs agents. Each agent is a Claude Code
 * session driven through the Agent SDK's query(), on the installed `claude` and its login.
 *
 * Seams left for the issues that build on this:
 *  - permissions (#77): canUseTool parks every request the owner's own rules did not settle in
 *    `pending`; the agent shows "waiting" until answerPermission() settles it.
 *  - talking to an agent (#79): the prompt is a message stream (MessageQueue); send() adds to it
 *    while a turn is running. Today the stream is closed when a turn's result arrives, so the
 *    Claude Code process exits and the agent is resumed for its next turn.
 *  - guarding and logging actions (#76): the routes refuse other pages' writes; the token and the
 *    action log are #76's.
 */

export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncIterable<SDKMessage> & { close?: () => void };

export class HostError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 429 | 503, message: string) {
    super(message);
  }
}

/** A prompt stream: user messages pushed in arrive at the agent in order; end() closes it. */
export class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private ended = false;

  get open(): boolean {
    return !this.ended;
  }

  push(text: string): boolean {
    if (this.ended) return false;
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    };
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: msg, done: false });
    } else this.items.push(msg);
    return true;
  }

  end(): void {
    this.ended = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  decisionReason?: string;
  blockedPath?: string;
  askedAt: string;
}

interface Live {
  input: MessageQueue;
  abort: AbortController;
  close?: () => void;
  claude: ClaudeBinary;
  sawInit: boolean;
  sawResult: boolean;
  /** Set when the host itself ends the run: the status and reason the agent ends with. */
  ending?: { status: "stopped" | "failed"; reason: string };
  pending: Map<string, PendingPermission & { resolve: (r: PermissionResult) => void }>;
  stderrTail: string;
}

export type HostEvent =
  | { type: "agent"; data: AgentView }
  | { type: "agent-message"; data: { id: string; line: TranscriptLine } };

/** `running`: a Claude Code process is alive for it (a "done" agent can still be exiting). */
export type AgentView = AgentRecord & { running: boolean; pendingPermissions: PendingPermission[] };

export interface HostDeps {
  registry?: AgentRegistry;
  query?: QueryFn;
  resolveClaude?: () => ClaudeBinary | null;
  env?: () => AgentEnv;
  /** How many agents may run at once. */
  cap?: number;
  emit?: (e: HostEvent) => void;
}

export const DEFAULT_CAP = 3;

export function capFromEnv(v: string | undefined = process.env.ANVIDECK_AGENT_CAP): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CAP;
}

export class AgentHost {
  readonly registry: AgentRegistry;
  readonly cap: number;
  private readonly queryFn: QueryFn;
  private readonly resolve: () => ClaudeBinary | null;
  private readonly envFn: () => AgentEnv;
  private emitFn: (e: HostEvent) => void;
  private readonly agents = new Map<string, AgentRecord>();
  private readonly live = new Map<string, Live>();
  private readonly seq = new Map<string, number>();

  constructor(deps: HostDeps & { query: QueryFn }) {
    this.registry = deps.registry ?? new AgentRegistry();
    this.queryFn = deps.query;
    this.resolve = deps.resolveClaude ?? (() => resolveClaude());
    this.envFn = deps.env ?? (() => loginOnlyEnv());
    this.cap = deps.cap ?? capFromEnv();
    this.emitFn = deps.emit ?? (() => {});
    for (const a of this.registry.load()) {
      this.agents.set(a.id, a);
      // The transcript is the truth for numbering: messageCount is only saved on status changes.
      const lines = this.registry.readTranscript(a.id).lines;
      const last = lines.length ? lines[lines.length - 1].seq : 0;
      a.messageCount = Math.max(a.messageCount, last);
      this.seq.set(a.id, a.messageCount);
    }
    // Agents that were live before a restart are now stopped: write that down.
    if (this.agents.size) this.persist();
  }

  onEvent(fn: (e: HostEvent) => void): void {
    this.emitFn = fn;
  }

  /** How many Claude Code processes the host is running right now. */
  get running(): number {
    return this.live.size;
  }

  list(): AgentView[] {
    return [...this.agents.values()]
      .map((a) => this.view(a))
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt));
  }

  get(id: string): AgentView {
    const a = this.agents.get(id);
    if (!a) throw new HostError(404, `no agent ${id}`);
    return this.view(a);
  }

  transcript(id: string) {
    this.get(id);
    return this.registry.readTranscript(id);
  }

  /** Start an agent in `cwd` with `prompt`. Refused, not queued, when the cap is reached. */
  start(req: { cwd: unknown; prompt: unknown; issue?: unknown }): AgentView {
    const cwd = typeof req.cwd === "string" ? req.cwd.trim() : "";
    const prompt = typeof req.prompt === "string" ? req.prompt.trim() : "";
    if (!cwd || !isAbsolute(cwd)) throw new HostError(400, "folder must be an absolute path");
    let isDir = false;
    try {
      isDir = statSync(cwd).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new HostError(400, `folder ${cwd} does not exist or is not a folder`);
    if (!prompt) throw new HostError(400, "prompt is empty");
    let issue: number | undefined;
    if (req.issue !== undefined && req.issue !== null && req.issue !== "") {
      issue = Number(req.issue);
      if (!Number.isInteger(issue) || issue <= 0) throw new HostError(400, "issue must be a positive whole number");
    }
    this.checkCap();
    const claude = this.requireClaude();
    const now = new Date().toISOString();
    const rec: AgentRecord = {
      id: `a${Date.now().toString(36)}${randomUUID().slice(0, 6)}`,
      cwd,
      prompt,
      issue,
      status: "starting",
      createdAt: now,
      updatedAt: now,
      runs: 0,
      messageCount: 0,
    };
    this.agents.set(rec.id, rec);
    this.seq.set(rec.id, 0);
    this.launch(rec, prompt, claude, undefined);
    return this.view(rec);
  }

  /** Resume a finished, failed or stopped agent's session with a new prompt. */
  resume(id: string, promptIn: unknown): AgentView {
    const rec = this.agents.get(id);
    if (!rec) throw new HostError(404, `no agent ${id}`);
    if (this.live.has(id)) throw new HostError(409, "agent is still running");
    if (!rec.sessionId) throw new HostError(409, "agent never reached Claude Code, so there is no session to resume; start a new one");
    const prompt = typeof promptIn === "string" && promptIn.trim() ? promptIn.trim() : "Continue.";
    this.checkCap();
    const claude = this.requireClaude();
    this.launch(rec, prompt, claude, rec.sessionId);
    return this.view(rec);
  }

  /** Stop a running agent at once. */
  stop(id: string, reason = "stopped by you"): AgentView {
    const rec = this.agents.get(id);
    if (!rec) throw new HostError(404, `no agent ${id}`);
    const live = this.live.get(id);
    if (!live) throw new HostError(409, `agent is not running (${rec.status})`);
    this.endRun(id, live, { status: "stopped", reason });
    return this.view(rec);
  }

  /** Add a message to a running turn (#79 builds on this). False when no turn is open. */
  send(id: string, text: string): boolean {
    const live = this.live.get(id);
    return live ? live.input.push(text) : false;
  }

  /** Settle a parked permission request (#77 builds on this). */
  answerPermission(id: string, requestId: string, result: PermissionResult): boolean {
    const live = this.live.get(id);
    const p = live?.pending.get(requestId);
    if (!live || !p) return false;
    live.pending.delete(requestId);
    this.record(id, "host", { event: "permission-answered", requestId, behavior: result.behavior });
    p.resolve(result);
    const rec = this.agents.get(id)!;
    if (live.pending.size === 0 && rec.status === "waiting") this.setStatus(rec, "working");
    else this.changed(rec);
    return true;
  }

  /** Stop every running agent (server shutdown). */
  stopAll(reason: string): void {
    for (const [id, live] of [...this.live]) this.endRun(id, live, { status: "stopped", reason });
  }

  // ---------------------------------------------------------------------------------------

  private checkCap(): void {
    if (this.live.size >= this.cap) {
      throw new HostError(429, `${this.live.size} agents are running, the most allowed at once is ${this.cap}; stop one first`);
    }
  }

  private requireClaude(): ClaudeBinary {
    const c = this.resolve();
    if (!c) throw new HostError(503, "Claude Code (claude) is not on PATH, so no agent can start. If Claude Code is updating itself, try again in a minute");
    return c;
  }

  private view(a: AgentRecord): AgentView {
    const live = this.live.get(a.id);
    const pendingPermissions = live
      ? [...live.pending.values()].map(({ resolve: _r, ...p }) => p)
      : [];
    return { ...a, running: live !== undefined, pendingPermissions };
  }

  private launch(rec: AgentRecord, prompt: string, claude: ClaudeBinary, resumeId: string | undefined): void {
    const { env, stripped } = this.envFn();
    const input = new MessageQueue();
    input.push(prompt);
    const abort = new AbortController();
    const live: Live = {
      input,
      abort,
      claude,
      sawInit: false,
      sawResult: false,
      pending: new Map(),
      stderrTail: "",
    };
    // Registered before any await, so two starts in one tick cannot both pass the cap.
    this.live.set(rec.id, live);
    rec.runs += 1;
    rec.status = "starting";
    rec.reason = undefined;
    rec.apiKeySource = undefined;
    rec.claudePath = claude.path;
    rec.claudeRealPath = claude.realPath;
    rec.strippedEnv = stripped;
    this.record(rec.id, "host", {
      event: resumeId ? "resumed" : "started",
      prompt,
      claudePath: claude.path,
      claudeRealPath: claude.realPath,
      strippedEnv: stripped,
    });
    this.setStatus(rec, "starting");

    const options: Options = {
      cwd: rec.cwd,
      pathToClaudeCodeExecutable: claude.path,
      env,
      abortController: abort,
      resume: resumeId,
      canUseTool: (toolName, toolInput, opts) => this.park(rec.id, live, toolName, toolInput, opts),
      stderr: (d) => {
        live.stderrTail = (live.stderrTail + d).slice(-2000);
      },
    };
    let q: ReturnType<QueryFn>;
    try {
      q = this.queryFn({ prompt: input, options });
    } catch (e) {
      this.finish(rec, live, e);
      return;
    }
    live.close = q.close?.bind(q);
    void this.consume(rec, live, q);
  }

  private async consume(rec: AgentRecord, live: Live, q: AsyncIterable<SDKMessage>): Promise<void> {
    let error: unknown;
    try {
      for await (const m of q) {
        if (live.ending) break;
        this.record(rec.id, "sdk", m);
        this.ingest(rec, live, m);
      }
    } catch (e) {
      error = e;
    }
    this.finish(rec, live, error);
  }

  /** What each SDK message means for the agent's status. */
  private ingest(rec: AgentRecord, live: Live, m: SDKMessage): void {
    if (m.type === "system" && m.subtype === "init") {
      live.sawInit = true;
      rec.sessionId = m.session_id;
      rec.apiKeySource = m.apiKeySource;
      rec.claudeCodeVersion = m.claude_code_version;
      rec.model = m.model;
      if (m.apiKeySource !== "none") {
        this.endRun(rec.id, live, {
          status: "failed",
          reason: `Stopped at once: Claude Code reported credential source "${m.apiKeySource}", not the claude.ai login (apiKeySource must be "none")`,
        });
        return;
      }
      if (rec.status === "starting") this.setStatus(rec, "working");
      else this.changed(rec);
      return;
    }
    if (m.type === "result") {
      live.sawResult = true;
      rec.costEstimateUsd = m.total_cost_usd;
      // The turn is over: close the prompt stream so the process exits (see header).
      live.input.end();
      if (!live.sawInit) {
        rec.status = "failed";
        rec.reason = "Claude Code ended before it said which login it was using";
      } else if (m.subtype === "success" && !m.is_error) {
        rec.status = "done";
        rec.reason = undefined;
      } else {
        rec.status = "failed";
        const detail = m.subtype === "success" ? m.result : (m.errors ?? []).join("; ");
        rec.reason = `Claude Code reported ${m.subtype}${detail ? `: ${String(detail).slice(0, 300)}` : ""}`;
      }
      this.changed(rec);
    }
  }

  private park(
    id: string,
    live: Live,
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; decisionReason?: string; blockedPath?: string },
  ): Promise<PermissionResult> {
    if (live.ending) return Promise.resolve({ behavior: "deny", message: live.ending.reason, interrupt: true });
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const p = {
        requestId,
        toolName,
        input,
        decisionReason: opts.decisionReason,
        blockedPath: opts.blockedPath,
        askedAt: new Date().toISOString(),
        resolve,
      };
      live.pending.set(requestId, p);
      opts.signal.addEventListener("abort", () => {
        if (live.pending.delete(requestId)) {
          resolve({ behavior: "deny", message: "request cancelled" });
          const rec = this.agents.get(id)!;
          if (live.pending.size === 0 && rec.status === "waiting") this.setStatus(rec, "working");
        }
      });
      this.record(id, "host", { event: "permission-asked", requestId, toolName, input, decisionReason: opts.decisionReason });
      this.setStatus(this.agents.get(id)!, "waiting");
    });
  }

  /** The host ends a run itself (stop, wrong credential, shutdown). Status is set now, not when the process exits. */
  private endRun(id: string, live: Live, ending: { status: "stopped" | "failed"; reason: string }): void {
    if (live.ending) return;
    live.ending = ending;
    for (const p of live.pending.values()) p.resolve({ behavior: "deny", message: ending.reason, interrupt: true });
    live.pending.clear();
    live.input.end();
    const rec = this.agents.get(id)!;
    rec.status = ending.status;
    rec.reason = ending.reason;
    this.record(id, "host", { event: ending.status, reason: ending.reason });
    this.changed(rec);
    live.abort.abort();
    try {
      live.close?.();
    } catch {
      /* already closed */
    }
  }

  private finish(rec: AgentRecord, live: Live, error: unknown): void {
    if (this.live.get(rec.id) !== live) return;
    this.live.delete(rec.id);
    for (const p of live.pending.values()) p.resolve({ behavior: "deny", message: "agent ended", interrupt: true });
    live.pending.clear();
    live.input.end();
    if (live.ending) {
      rec.status = live.ending.status;
      rec.reason = live.ending.reason;
    } else if (error !== undefined || !live.sawResult) {
      const msg = error instanceof Error ? error.message : error !== undefined ? String(error) : "Claude Code exited without a result";
      const detail = live.stderrTail.trim() ? `${msg} | ${live.stderrTail.trim().slice(-300)}` : msg;
      rec.status = "failed";
      rec.reason = live.sawInit
        ? `Claude Code stopped with an error: ${detail}`
        : explainStartFailure(live.claude, this.resolve(), detail);
      this.record(rec.id, "host", { event: "failed", reason: rec.reason });
    }
    // A run that ended while still "starting"/"working"/"waiting" must not stay live-looking.
    if (LIVE_STATUSES.has(rec.status)) {
      rec.status = "failed";
      rec.reason = rec.reason ?? "Claude Code exited without a result";
    }
    this.changed(rec);
  }

  private setStatus(rec: AgentRecord, s: AgentStatus): void {
    rec.status = s;
    this.changed(rec);
  }

  private changed(rec: AgentRecord): void {
    rec.updatedAt = new Date().toISOString();
    this.persist();
    this.emitFn({ type: "agent", data: this.view(rec) });
  }

  private persist(): void {
    try {
      this.registry.save([...this.agents.values()]);
    } catch (e) {
      console.error(`[agents] could not write the registry: ${(e as Error).message}`);
    }
  }

  private record(id: string, from: "sdk" | "host", message: unknown): void {
    const seq = (this.seq.get(id) ?? 0) + 1;
    this.seq.set(id, seq);
    const rec = this.agents.get(id);
    if (rec) rec.messageCount = seq;
    const line: TranscriptLine = { seq, at: new Date().toISOString(), from, message };
    try {
      this.registry.append(id, line);
    } catch (e) {
      console.error(`[agents] could not write transcript for ${id}: ${(e as Error).message}`);
    }
    this.emitFn({ type: "agent-message", data: { id, line } });
  }
}
