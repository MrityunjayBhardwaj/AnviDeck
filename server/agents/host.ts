import { randomUUID, type UUID } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type {
  Options,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AgentRegistry, LIVE_STATUSES, ownerProcessAlive, RegistryLockedError, type AgentOwner, type AgentRecord, type AgentStatus, type TranscriptLine } from "./registry";
import { explainStartFailure, loginOnlyEnv, resolveClaude, type AgentEnv, type ClaudeBinary } from "./login";
import { messagesIn, parseMessageRequest, renderForAgent, type SentMessage } from "../../shared/agent-messages";
import { parsePermissionAnswer, type PendingPermission } from "../../shared/permission-requests";
import { elsewhereText, type RunsElsewhere } from "../../shared/agent-elsewhere";
import { checkMode, DEFAULT_MODE, FULL_ACCESS_CONFIRM, fullAccessGithubChanged, isAgentMode, MODE_CAP_ENV, modeCapFrom, modeInfo, rank, type AgentMode, type ModeCap } from "../../shared/agent-modes";
import { githubAccessInfo, unavailable, type GithubAccess, type GithubAccessRead } from "../../shared/github-access";
import { emptyGhConfigDir, readGithubAccess, withGithubAccess } from "./github-access";
import type { CheckpointStore } from "./checkpoints";

export type { PendingPermission };

/**
 * The agent host (#75): the only code in AnviDeck that runs agents. Each agent is a Claude Code
 * session driven through the Agent SDK's query(), on the installed `claude` and its login.
 *
 * Seams left for the issues that build on this:
 *  - permissions (#77): canUseTool parks every request the owner's own rules did not settle in
 *    `pending`; the agent shows "waiting" until answer() settles it. Nothing else settles a
 *    request except the run ending (stop, failure, exit) or Claude Code cancelling the call:
 *    both withdraw it as a deny. There is no timeout (see shared/permission-requests.ts).
 *  - talking to an agent (#79): the prompt is a message stream (MessageQueue); message() adds to
 *    it while the agent runs, each message carrying its own uuid so Claude Code's reports name it
 *    (see deliveryIn). The stream is closed once a turn's result has arrived AND every message
 *    sent has been taken in, so the Claude Code process exits and the agent is resumed for its
 *    next turn. A message to an agent with no open stream is refused (409, resumable), never dropped.
 *  - guarding and logging actions (#76): the routes refuse other pages' writes; the token and the
 *    action log are #76's.
 */

export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncIterable<SDKMessage> & { close?: () => void };

export class HostError extends Error {
  /** `detail` is sent beside `error` in the response body (e.g. `resumable` on a refused message). */
  constructor(readonly status: 400 | 403 | 404 | 409 | 429 | 502 | 503, message: string, readonly detail?: Record<string, unknown>) {
    super(message);
  }
}

/**
 * What a frame from Claude Code says about a message AnviDeck sent with `uuid`.
 * Two sources, both read off the frame as Claude Code wrote it:
 *  - `command_lifecycle` frames ({ command_uuid, state }): Claude Code 2.1.318 emits one per
 *    state change of a queued message that carried a uuid; "started" means a turn took it in
 *    (mid-turn, between tool calls, or as the next turn). Not in the SDK's SDKMessage union, so
 *    read loosely; the states are those of the CLI's own schema for the frame.
 *  - `user_message_uuid` / `user_message_uuids` on assistant and result frames (sdk.d.ts: "client
 *    uuids of every user message whose prompt this turn consumed"), the documented fallback.
 */
export function deliveryIn(m: unknown): { delivered: string[]; refused: { uuid: string; state: string }[] } {
  const delivered: string[] = [];
  const refused: { uuid: string; state: string }[] = [];
  if (!m || typeof m !== "object") return { delivered, refused };
  const f = m as Record<string, unknown>;
  if (f.type === "command_lifecycle" && typeof f.command_uuid === "string") {
    if (f.state === "started" || f.state === "completed") delivered.push(f.command_uuid);
    else if (f.state === "cancelled" || f.state === "discarded" || f.state === "refused") refused.push({ uuid: f.command_uuid, state: f.state });
  }
  if (typeof f.user_message_uuid === "string") delivered.push(f.user_message_uuid);
  if (Array.isArray(f.user_message_uuids)) for (const u of f.user_message_uuids) if (typeof u === "string") delivered.push(u);
  return { delivered, refused };
}

/** A prompt stream: user messages pushed in arrive at the agent in order; end() closes it. */
export class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private ended = false;

  get open(): boolean {
    return !this.ended;
  }

  /** `uuid` lets Claude Code report the message's delivery by name (see deliveryIn). */
  push(text: string, uuid?: UUID): boolean {
    if (this.ended) return false;
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      ...(uuid ? { uuid } : {}),
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
  /** Messages sent to this run that Claude Code has not yet taken in (their uuids). */
  undelivered: Set<string>;
  /**
   * The last turn's result, while it waits for undelivered messages: the stream stays open
   * (Claude Code runs a queued message as its next turn) and the status is applied only once
   * nothing is left undelivered.
   */
  turnOver?: { status: "done" | "failed"; reason?: string };
  /** A turn has started and its result has not come yet: a checkpoint is owed when it ends (#248). */
  turnOpen: boolean;
  /** How many turns this run has started; a checkpoint compares it to see if the next began meanwhile. */
  turnsStarted: number;
  /**
   * The subagents this run has started, by id (#267): from each `task_started` message, and from
   * a subagent's own messages (their `agent_id`, `subagent_type`, `task_description`). A request a
   * subagent parks carries only this id; the card names it from here.
   */
  subagents: Map<string, { type?: string; description?: string }>;
  /**
   * When the turn's result was applied and the prompt stream closed: the agent is done (or
   * failed) and its Claude Code process is exiting. From here its result stands (#114).
   */
  exitingSince?: string;
  /** AnviDeck ended the process after its result (why): its exit, error or not, changes nothing. */
  cutOff?: string;
  /** A resume waits for this run's process to exit, then launches the next run (#126). */
  handoff?: () => void;
  /** Timers of this run (exit grace, message wait), cleared when it ends. */
  timers: Set<ReturnType<typeof setTimeout>>;
  messageWait?: ReturnType<typeof setTimeout>;
}

export type HostEvent =
  | { type: "agent"; data: AgentView }
  | { type: "agent-message"; data: { id: string; line: TranscriptLine } };

/**
 * `running`: a Claude Code process is alive for it in THIS server (a "done" agent can still be
 * exiting). `runsElsewhere`: another AnviDeck server that is still alive runs it (#104); only
 * that server can stop it, answer it or send it a message.
 */
export type AgentView = AgentRecord & {
  running: boolean;
  pendingPermissions: PendingPermission[];
  runsElsewhere?: RunsElsewhere;
  /**
   * Its result is in and its Claude Code process is exiting (#105, #114): nothing to stop, and a
   * resume ends that process first (#126). `endsBy`: when AnviDeck ends it at the latest.
   */
  exiting?: { since: string; endsBy: string };
};

export interface HostDeps {
  registry?: AgentRegistry;
  query?: QueryFn;
  resolveClaude?: () => ClaudeBinary | null;
  env?: () => AgentEnv;
  /** How many agents may run at once. */
  cap?: number;
  emit?: (e: HostEvent) => void;
  /** This server, as its agents name it. Default: this process, PORT (else 4000), a fresh instance id. */
  owner?: Partial<AgentOwner>;
  /** Is the server that owns an agent still alive? Default: see AgentHost.ownerAliveDefault. */
  ownerAlive?: (o: AgentOwner) => boolean;
  /** How soon a write that found the registry locked is retried (tests shorten it). */
  retryMs?: number;
  /** The highest permission mode an agent may start in (#249). Default: from ANVIDECK_AGENT_MODE_CAP. */
  modeCap?: ModeCap;
  /** Agent GitHub access (#147), read at each start and resume. Default: settings.json in the registry's folder. */
  githubAccess?: () => GithubAccessRead;
  /** Where the empty folders "none" points each agent's gh configuration at go (tests use their own). Default: emptyGhConfigDir. */
  ghConfigDir?: (agentId: string) => string;
  /**
   * Checkpoints per turn (#248): a snapshot of the agent's folder before each run and after each
   * turn, kept in AnviDeck's own folder. Off (null) unless given; the real app gives one.
   */
  checkpoints?: CheckpointStore | null;
  /** EXIT_GRACE_MS, MESSAGE_WAIT_MS, HANDOFF_WAIT_MS (tests shorten them). */
  exitGraceMs?: number;
  messageWaitMs?: number;
  handoffWaitMs?: number;
}

/**
 * How long Claude Code may keep running after the agent's result before AnviDeck ends it (#105).
 * It normally exits within seconds; one that keeps going is running a background task the agent
 * started, which nobody will read once the turn is over, and it would hold a run slot.
 */
export const EXIT_GRACE_MS = 30_000;
/**
 * How long a message sent at the end of a turn may wait for Claude Code to take it in as the
 * next turn (#124). After that it is recorded as not delivered and the turn's result applies.
 */
export const MESSAGE_WAIT_MS = 30_000;
/** How long a resume waits for the previous run's process to exit once it is ended (#126). */
export const HANDOFF_WAIT_MS = 10_000;

export const DEFAULT_CAP = 3;

/**
 * How long a status write waits for another server's registry lock. The wait blocks the event
 * loop, so it is short; a write that misses it is retried (see persist), never dropped.
 */
export const PERSIST_WAIT_MS = 500;
/** How soon a missed write, or a start-up sweep that found the registry locked, is tried again. */
export const RETRY_MS = 2000;
/**
 * How often a server reads the registry and transcripts for agents it does not run, to show
 * their changes on its own pages (#223): another server pushes them only to its own pages.
 */
export const WATCH_MS = 1500;

export function capFromEnv(v: string | undefined = process.env.ANVIDECK_AGENT_CAP): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CAP;
}

export class AgentHost {
  readonly registry: AgentRegistry;
  readonly cap: number;
  /** The highest permission mode an agent may start in on this machine, and where that came from (#249). */
  readonly modeCap: ModeCap;
  private readonly queryFn: QueryFn;
  private readonly githubAccessFn: () => GithubAccessRead;
  private readonly ghConfigDir: (agentId: string) => string;
  private readonly resolve: () => ClaudeBinary | null;
  private readonly envFn: () => AgentEnv;
  private emitFn: (e: HostEvent) => void;
  /** This server, as the agents it runs name it in the registry (#104). */
  readonly owner: AgentOwner;
  private readonly ownerAlive: (o: AgentOwner) => boolean;
  /**
   * Agents this host started or resumed. Every other agent in the registry (another server's,
   * or one from before a restart) is read from the file when asked for, never held here, so
   * this host never writes over a record it does not run.
   */
  private readonly agents = new Map<string, AgentRecord>();
  private readonly live = new Map<string, Live>();
  private readonly seq = new Map<string, number>();
  /** Records whose last write found the registry locked: written again on the next retry. */
  private readonly unsaved = new Set<string>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The start-up sweep found the registry locked and is still to be done. */
  private sweepPending = false;
  private readonly retryMs: number;
  private readonly exitGraceMs: number;
  private readonly messageWaitMs: number;
  private readonly handoffWaitMs: number;
  /** Checkpoints per turn (#248), or null when this host takes none. */
  readonly checkpoints: CheckpointStore | null;
  /** Agents an Undo is putting back right now (#248), with what: no resume or start in their folder until it is done. */
  private readonly holds = new Map<string, { cwd: string; what: string }>();
  /** Agents this host does not run, as last pushed to the pages, and how far their transcript was read (#223). */
  private readonly watched = new Map<string, { view: string; size: number }>();
  private watchedOnce = false;
  private watchUnread: string | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: HostDeps & { query: QueryFn }) {
    this.registry = deps.registry ?? new AgentRegistry();
    this.queryFn = deps.query;
    this.resolve = deps.resolveClaude ?? (() => resolveClaude());
    this.envFn = deps.env ?? (() => loginOnlyEnv());
    this.cap = deps.cap ?? capFromEnv();
    this.modeCap = deps.modeCap ?? modeCapFrom(process.env[MODE_CAP_ENV]);
    this.githubAccessFn = deps.githubAccess ?? (() => readGithubAccess(this.registry.dir));
    this.ghConfigDir = deps.ghConfigDir ?? emptyGhConfigDir;
    this.emitFn = deps.emit ?? (() => {});
    const port = Number.parseInt(process.env.PORT ?? "4000", 10);
    this.owner = {
      pid: process.pid,
      port: Number.isFinite(port) ? port : undefined,
      instance: randomUUID(),
      startedAt: new Date().toISOString(),
      ...deps.owner,
    };
    this.ownerAlive = deps.ownerAlive ?? ((o) => this.ownerAliveDefault(o));
    this.retryMs = deps.retryMs ?? RETRY_MS;
    this.exitGraceMs = deps.exitGraceMs ?? EXIT_GRACE_MS;
    this.messageWaitMs = deps.messageWaitMs ?? MESSAGE_WAIT_MS;
    this.handoffWaitMs = deps.handoffWaitMs ?? HANDOFF_WAIT_MS;
    this.checkpoints = deps.checkpoints ?? null;
    try {
      this.sweep();
    } catch (e) {
      // A lock another server holds a while is not a damaged file: the host stays on and sweeps
      // later. Agents of gone servers read as stopped meanwhile (see view). Anything else throws.
      if (!(e instanceof RegistryLockedError)) throw e;
      console.error(`[agents] start-up sweep postponed: ${e.message}`);
      this.sweepPending = true;
      this.scheduleRetry();
    }
    this.clearGoneFolders();
  }

  /**
   * Snapshots go with the agent's folder (#248): an agent whose folder no longer exists (its
   * worktree was removed) has its snapshots cleared, and the record says why. Its record is kept.
   */
  private clearGoneFolders(): void {
    const store = this.checkpoints;
    if (!store) return;
    let agents: AgentRecord[];
    try {
      agents = this.registry.load();
    } catch {
      return;
    }
    for (const a of agents) {
      if (LIVE_STATUSES.has(a.status) || !store.kept(a.id) || existsSync(a.cwd)) continue;
      void store.clear(a.id, `the agent's folder ${a.cwd} no longer exists (its worktree was removed)`).catch((e) =>
        console.error(`[checkpoints] ${a.id}: could not clear: ${(e as Error).message}`),
      );
    }
  }

  /**
   * Hold an agent while an Undo puts its folder back (#248): resume, and a start in the same folder,
   * are refused until `release`. Refused if it is held already.
   */
  hold(id: string, cwd: string, what: string): void {
    const held = this.holds.get(id);
    if (held) throw new HostError(409, `agent ${id} is busy: ${held.what}`, { refusal: "busy" });
    this.holds.set(id, { cwd, what });
  }

  release(id: string): void {
    this.holds.delete(id);
  }

  private refuseHeld(id: string | null, cwd: string): void {
    const real = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    };
    for (const [hid, h] of this.holds) {
      if (hid === id || real(h.cwd) === real(cwd)) throw new HostError(409, `${hid === id ? "this agent" : `agent ${hid}, in the same folder,`} is busy: ${h.what}; try again when it is done`, { refusal: "busy" });
    }
  }

  /**
   * Is the server that owns an agent alive? This host is; another host in this same process
   * is a predecessor (a process runs one host), so it is gone; any other pid is asked of the OS,
   * with its start time, so a pid the OS has handed to another process does not count (#224).
   */
  /**
   * The port this server actually listens on, once it is listening. PORT is only a request: the
   * desktop app asks for any free port (0), so the owner record would otherwise name a port
   * nobody serves (#240). Set before any agent can start, since starting one needs a request.
   */
  listeningOn(port: number): void {
    if (Number.isInteger(port) && port > 0) this.owner.port = port;
  }

  private ownerAliveDefault(o: AgentOwner): boolean {
    if (o.instance === this.owner.instance) return true;
    if (o.pid === process.pid) return false;
    return ownerProcessAlive(o);
  }

  /**
   * Another server that is still alive runs this agent, or its Claude Code process is still
   * exiting there after a finished turn: this host must not touch it.
   */
  private elsewhere(a: AgentRecord): { pid: number; port?: number } | undefined {
    if ((!LIVE_STATUSES.has(a.status) && !a.processAlive) || !a.owner || a.owner.instance === this.owner.instance) return undefined;
    return this.ownerAlive(a.owner) ? { pid: a.owner.pid, port: a.owner.port } : undefined;
  }

  /** Try the postponed sweep and the missed writes again, after RETRY_MS. */
  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.sweepPending) {
        try {
          this.sweep();
          this.sweepPending = false;
        } catch (e) {
          if (!(e instanceof RegistryLockedError)) console.error(`[agents] start-up sweep failed: ${(e as Error).message}`);
          else this.scheduleRetry();
        }
      }
      for (const id of [...this.unsaved]) {
        const rec = this.agents.get(id);
        this.unsaved.delete(id);
        if (rec) this.settle(rec, this.persist(rec));
      }
    }, this.retryMs);
    this.retryTimer.unref?.();
  }

  /** Why a live-looking agent whose server is gone is stopped. */
  private goneReason(a: AgentRecord): string {
    const who = a.owner
      ? `its AnviDeck server (${a.owner.port !== undefined ? `port ${a.owner.port}, ` : ""}pid ${a.owner.pid}) stopped or restarted`
      : "AnviDeck restarted (the record names no server; it was written before servers were recorded)";
    return `${who} while this agent was ${a.status}`;
  }

  /**
   * At start: agents whose server is gone are written down as stopped, and a message still
   * queued in one of their transcripts as not delivered. Agents run by another live server are
   * left exactly as they are (#104). Done under the registry's lock, so two servers starting at
   * once do not both record it.
   */
  private sweep(): void {
    this.registry.update((agents) => {
      let changed = false;
      const next = agents.map((a) => {
        if (a.owner && this.ownerAlive(a.owner)) return a;
        const out = { ...a };
        // The transcript is the truth for numbering: messageCount is only saved on status changes.
        const lines = this.registry.readTranscript(a.id).lines;
        let seq = Math.max(a.messageCount, lines.length ? lines[lines.length - 1].seq : 0);
        for (const s of messagesIn(lines)) {
          if (s.state !== "queued") continue;
          seq += 1;
          this.registry.append(a.id, {
            seq,
            at: new Date().toISOString(),
            from: "host",
            message: { event: "message-not-delivered", messageId: s.messageId, reason: "AnviDeck restarted before the agent read it" },
          });
        }
        if (seq !== a.messageCount) {
          out.messageCount = seq;
          changed = true;
        }
        if (LIVE_STATUSES.has(a.status)) {
          out.status = "stopped";
          out.reason = this.goneReason(a);
          out.updatedAt = new Date().toISOString();
          changed = true;
        }
        if (out.processAlive) {
          delete out.processAlive;
          changed = true;
        }
        return out;
      });
      return { agents: changed ? next : undefined, out: undefined };
    }, PERSIST_WAIT_MS);
  }

  onEvent(fn: (e: HostEvent) => void): void {
    this.emitFn = fn;
  }

  /**
   * Agents this host does not run change only on disk: another server writes their status to
   * the registry and their lines to their transcripts, and pushes both only to its own pages.
   * Every `ms` this host reads them and pushes what changed to its pages too (#223), as it does
   * for its own agents. The first read only notes where things stand: the pages read the list
   * themselves when they open.
   */
  watchOthers(ms: number = WATCH_MS): void {
    if (this.watchTimer) return;
    this.pollOthers();
    this.watchTimer = setInterval(() => this.pollOthers(), ms);
    this.watchTimer.unref?.();
  }

  stopWatching(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  /**
   * One read of the agents this host does not run: an agent whose view changed (status, owner,
   * its server gone) is pushed as an "agent" event; lines added to its transcript since the last
   * read are pushed as "agent-message" events, read from where the last read ended. Agents this
   * host runs are skipped: it pushes their changes as they happen.
   */
  pollOthers(): void {
    const snap = this.snapshot();
    if (snap.unread) {
      // Nothing is pushed: the pages keep what they last read, and their next list says why.
      if (this.watchUnread !== snap.unread) console.error(`[agents] could not read other servers' agents: ${snap.unread}`);
      this.watchUnread = snap.unread;
      return;
    }
    this.watchUnread = null;
    const first = !this.watchedOnce;
    this.watchedOnce = true;
    for (const v of snap.agents) {
      if (this.live.has(v.id)) {
        this.watched.delete(v.id);
        continue;
      }
      const key = JSON.stringify(v);
      const prev = this.watched.get(v.id);
      const size = this.transcriptSize(v.id);
      if (!prev) {
        this.watched.set(v.id, { view: key, size });
        // An agent first seen after the first read is new to the pages too.
        if (!first) {
          this.emitFn({ type: "agent", data: v });
          for (const line of this.transcriptFrom(v.id, 0, size).lines) this.emitFn({ type: "agent-message", data: { id: v.id, line } });
        }
        continue;
      }
      let at = prev.size;
      if (size < at) at = size; // the file was replaced: start again from its end
      else if (size > at) {
        const read = this.transcriptFrom(v.id, at, size);
        for (const line of read.lines) this.emitFn({ type: "agent-message", data: { id: v.id, line } });
        at = read.end;
      }
      if (prev.view !== key) this.emitFn({ type: "agent", data: v });
      this.watched.set(v.id, { view: key, size: at });
    }
  }

  private transcriptSize(id: string): number {
    try {
      return statSync(this.registry.transcriptPath(id)).size;
    } catch {
      return 0;
    }
  }

  /**
   * The whole lines of a transcript between two byte offsets, and where the last whole line
   * ends: a line still being written is read next time. A line that does not parse is skipped.
   */
  private transcriptFrom(id: string, from: number, to: number): { lines: TranscriptLine[]; end: number } {
    if (to <= from) return { lines: [], end: from };
    let text: string;
    try {
      const fd = openSync(this.registry.transcriptPath(id), "r");
      try {
        const buf = Buffer.alloc(to - from);
        const n = readSync(fd, buf, 0, buf.length, from);
        text = buf.subarray(0, n).toString("utf8");
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      console.error(`[agents] could not read the transcript of ${id}: ${(e as Error).message}`);
      return { lines: [], end: from };
    }
    const cut = text.lastIndexOf("\n");
    if (cut < 0) return { lines: [], end: from };
    const lines: TranscriptLine[] = [];
    for (const t of text.slice(0, cut).split("\n")) {
      if (!t.trim()) continue;
      try {
        lines.push(JSON.parse(t));
      } catch {
        /* a damaged line: the transcript read counts it */
      }
    }
    return { lines, end: from + Buffer.byteLength(text.slice(0, cut + 1), "utf8") };
  }

  /** How many Claude Code processes this host is running right now. */
  get running(): number {
    return this.live.size;
  }

  /**
   * Every agent in the registry, as the file says now, with this host's own running agents from
   * memory. `unread` names why the file could not be read; the agents listed are then only this
   * host's, never presented as all there are.
   */
  snapshot(): { agents: AgentView[]; unread?: string } {
    let disk: AgentRecord[] = [];
    let unread: string | undefined;
    try {
      disk = this.registry.load();
    } catch (e) {
      unread = `the agent registry could not be read: ${(e as Error).message}`;
    }
    const byId = new Map(disk.map((a) => [a.id, a]));
    for (const [id, mine] of this.agents) {
      const there = byId.get(id);
      // Ours unless another server has resumed it since (it then names itself the owner).
      if (this.live.has(id) || !there || !there.owner || there.owner.instance === this.owner.instance) byId.set(id, mine);
      else this.agents.delete(id);
    }
    const agents = [...byId.values()].map((a) => this.view(a)).sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    return unread ? { agents, unread } : { agents };
  }

  list(): AgentView[] {
    return this.snapshot().agents;
  }

  private find(id: string): AgentRecord | undefined {
    if (this.live.has(id)) return this.agents.get(id);
    let disk: AgentRecord | undefined;
    try {
      disk = this.registry.load().find((a) => a.id === id);
    } catch (e) {
      const mine = this.agents.get(id);
      if (mine) return mine;
      throw new HostError(503, `the agent registry could not be read: ${(e as Error).message}`);
    }
    const mine = this.agents.get(id);
    if (mine && (!disk || !disk.owner || disk.owner.instance === this.owner.instance)) return mine;
    return disk;
  }

  get(id: string): AgentView {
    const a = this.find(id);
    if (!a) throw new HostError(404, `no agent ${id}`);
    return this.view(a);
  }

  /** 409 for an agent another live server runs: name where it is. */
  private refuseElsewhere(a: AgentRecord, doing: string, detail: Record<string, unknown> = {}): void {
    const where = this.elsewhere(a);
    if (where) throw new HostError(409, `${elsewhereText(where)}; ${doing} there`, { runsElsewhere: where, status: a.status, ...detail });
  }

  transcript(id: string) {
    this.get(id);
    return this.registry.readTranscript(id);
  }

  /**
   * The permission mode a start asks for, checked against this machine's cap (#249): 400 for a
   * mode that is not one, or Full access without its confirmation; 403 for one above the cap; 409
   * for Full access confirmed for another Agent GitHub access than the setting now (#270).
   * Enforced here, on the server; the dialogs only show it.
   */
  checkStartMode(mode: unknown, confirm?: unknown, githubConfirmed?: unknown, when: "start" | "resume" = "start"): AgentMode {
    const c = checkMode(mode, this.modeCap, confirm);
    if (!c.ok) throw new HostError(c.status, c.error, { modeCap: this.modeCap.cap });
    // Full access is confirmed for one Agent GitHub access (#270): a run under any other is refused.
    if (c.mode === "bypassPermissions") {
      const now = this.requireGithubAccess();
      const changed = fullAccessGithubChanged(githubConfirmed, now, when);
      if (changed) throw new HostError(409, changed, { githubAccess: now });
    }
    return c.mode;
  }

  /** The Agent GitHub access setting as it reads now (#147). */
  githubAccess(): GithubAccessRead {
    return this.githubAccessFn();
  }

  /**
   * The GitHub access the next run gets. A setting that cannot be read refuses the run (503) rather
   * than guess: guessing "your login" would hand over the login you may have taken away.
   */
  private requireGithubAccess(): GithubAccess {
    const g = this.githubAccessFn();
    if (g.status !== "ok") throw new HostError(503, `the Agent GitHub access setting could not be read (${g.file}: ${g.reason}), so no agent starts until it is fixed or set again`);
    const why = unavailable(g.access);
    if (why) throw new HostError(409, `Agent GitHub access is ${githubAccessInfo(g.access).label}, which is ${why}`);
    return g.access;
  }

  /** Start an agent in `cwd` with `prompt`. Refused, not queued, when the cap is reached. */
  start(req: { cwd: unknown; prompt: unknown; issue?: unknown; mode?: unknown; confirm?: unknown; githubAccess?: unknown }): AgentView {
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
    const mode = this.checkStartMode(req.mode, req.confirm, req.githubAccess);
    this.refuseHeld(null, cwd);
    const github = this.requireGithubAccess();
    const claude = this.requireClaude();
    const now = new Date().toISOString();
    const rec: AgentRecord = {
      id: `a${Date.now().toString(36)}${randomUUID().slice(0, 6)}`,
      owner: this.owner,
      cwd,
      prompt,
      issue,
      mode,
      status: "starting",
      createdAt: now,
      updatedAt: now,
      runs: 0,
      messageCount: 0,
    };
    // Written under the registry's lock, after counting every server's running agents against the
    // cap, so two servers cannot both pass it (#225).
    this.claim("started", (agents) => {
      this.checkCap(agents);
      return { agents: [...agents, { ...rec }], out: undefined };
    });
    this.agents.set(rec.id, rec);
    this.seq.set(rec.id, 0);
    this.launch(rec, prompt, claude, undefined, github);
    return this.view(rec);
  }

  /** Resume a finished, failed or stopped agent's session with a new prompt. */
  resume(id: string, promptIn: unknown): AgentView {
    const found = this.find(id);
    if (!found) throw new HostError(404, `no agent ${id}`);
    // A finished agent whose process is still exiting can be resumed: that process is ended and
    // the resume starts once it has exited (#126). One still in its turn cannot.
    const exiting = this.live.get(id);
    if (exiting && !this.isExiting(exiting)) throw new HostError(409, exiting.handoff ? "agent is already being resumed" : "agent is still running");
    this.refuseElsewhere(found, "resume it");
    this.refuseHeld(id, found.cwd);
    if (!found.sessionId) throw new HostError(409, "agent never reached Claude Code, so there is no session to resume; start a new one");
    const prompt = typeof promptIn === "string" && promptIn.trim() ? promptIn.trim() : "Continue.";
    // A resume keeps the mode it was started in, and is refused if the cap has been lowered since.
    // Its Full access was confirmed when it started, for the GitHub access it started with (#270).
    this.checkStartMode(found.mode ?? DEFAULT_MODE, FULL_ACCESS_CONFIRM, found.githubAccess, "resume");
    // A resume gets the setting as it is now, not as it was when the agent started.
    const github = this.requireGithubAccess();
    const claude = this.requireClaude();
    // Claim it under the lock: if another server resumed it a moment ago, it now runs there. The
    // cap counts every server's running agents, read under the same lock (#225).
    const rec = this.claim("resumed", (agents) => {
      const i = agents.findIndex((a) => a.id === id);
      const now = i >= 0 ? agents[i]! : found;
      this.refuseElsewhere(now, "resume it");
      this.checkCap(agents, exiting ? id : undefined);
      const claimed: AgentRecord = { ...now, owner: this.owner, status: "starting", reason: undefined, updatedAt: new Date().toISOString() };
      const next = [...agents];
      if (i >= 0) next[i] = claimed;
      else next.push(claimed);
      return { agents: next, out: claimed };
    });
    this.agents.set(id, rec);
    // While the old process exits, its run and the new one share one record.
    const run = exiting ? Object.assign(this.agents.get(id) ?? found, rec) : rec;
    this.agents.set(id, run);
    const lines = this.registry.readTranscript(id).lines;
    run.messageCount = Math.max(run.messageCount, lines.length ? lines[lines.length - 1].seq : 0);
    this.seq.set(id, Math.max(run.messageCount, this.seq.get(id) ?? 0));
    if (!exiting) {
      this.launch(run, prompt, claude, run.sessionId, github);
      return this.view(run);
    }
    // Two Claude Code processes never run one session at once: the old one is ended, and the
    // next run starts when it has exited (finish calls handoff), or not at all if it does not.
    const final = run;
    const old = exiting.turnOver;
    const timer = setTimeout(() => {
      exiting.timers.delete(timer);
      if (!exiting.handoff) return;
      exiting.handoff = undefined;
      final.status = old?.status ?? "done";
      final.reason = old?.reason;
      this.record(id, "host", { event: "resume-not-started", reason: `its previous Claude Code process had not exited ${Math.round(this.handoffWaitMs / 1000)} s after AnviDeck ended it; resume again once it has` });
      this.changed(final);
    }, this.handoffWaitMs);
    timer.unref?.();
    exiting.timers.add(timer);
    exiting.handoff = () => {
      clearTimeout(timer);
      this.launch(final, prompt, claude, final.sessionId, github);
    };
    this.cutOff(id, exiting, "resumed while its Claude Code was still exiting after its result; AnviDeck ended it so the resume can start");
    this.changed(final);
    return this.view(final);
  }

  /** The turn's result is applied and the process is only exiting: nothing is left to stop (#114). */
  private isExiting(live: Live): boolean {
    return live.exitingSince !== undefined && !live.ending && !live.handoff;
  }

  /**
   * End a run's process after its result (#105, #114, #126): recorded with why, and its exit,
   * with an error or not, leaves the result as it is.
   */
  private cutOff(id: string, live: Live, why: string): void {
    if (live.cutOff) return;
    live.cutOff = why;
    this.record(id, "host", { event: "process-ended", reason: why });
    live.abort.abort();
    try {
      live.close?.();
    } catch {
      /* already closed */
    }
  }

  /** Stop a running agent at once. */
  stop(id: string, reason = "stopped by you"): AgentView {
    const live = this.live.get(id);
    const rec = live ? this.agents.get(id) : this.find(id);
    if (!rec) throw new HostError(404, `no agent ${id}`);
    if (!live) {
      this.refuseElsewhere(rec, "stop it");
      throw new HostError(409, `agent is not running (${this.view(rec).status})`);
    }
    if (live.handoff) throw new HostError(409, "the agent is being resumed; stop it once it has started", { status: rec.status });
    // Its result is in: Stop would only relabel it (#114). Its process is ended for it (#105).
    if (this.isExiting(live)) {
      throw new HostError(409, `agent is already ${rec.status}: its result stands, and its Claude Code process is exiting (AnviDeck ends it within ${Math.round(this.exitGraceMs / 1000)} s of the result)`, {
        status: rec.status,
        exiting: true,
      });
    }
    if (live.turnOver && !live.ending) {
      // The result is in, and the run waits only for a message sent at the end of the turn: that
      // message is not delivered, the result stands, and the process is ended now.
      for (const u of live.undelivered) this.record(id, "host", { event: "message-not-delivered", messageId: u, reason: `${reason} before Claude Code took it in` });
      live.undelivered.clear();
      this.maybeEndTurn(rec, live);
      this.cutOff(id, live, `${reason} after its result; the result stands`);
      return this.view(rec);
    }
    this.endRun(id, live, { status: "stopped", reason });
    return this.view(rec);
  }

  /**
   * Send a message or a line comment to a running agent (#79). It is queued on the agent's
   * prompt stream and arrives on its next turn (or mid-turn, between tool calls); the transcript
   * records it as sent, then delivered or not delivered. An agent with no open stream (finished,
   * failed, stopped, or ending) refuses with 409 and says whether it can be resumed instead.
   */
  message(id: string, body: Record<string, unknown>): { agent: AgentView; message: SentMessage } {
    const live = this.live.get(id);
    const rec = live ? this.agents.get(id) : this.find(id);
    if (!rec) throw new HostError(404, `no agent ${id}`);
    const req = parseMessageRequest(body);
    if ("error" in req) throw new HostError(400, req.error);
    if (!live) this.refuseElsewhere(rec, "the message was not sent; send it", { resumable: false });
    if (!live || live.ending || !live.input.open) {
      // A live-looking agent whose server is gone reads as stopped (see view).
      const shown = this.view(rec);
      const why = live?.ending
        ? `the agent is being ${live.ending.status === "stopped" ? "stopped" : "ended"} (${live.ending.reason})`
        : live
          ? `the agent has finished its turn (${rec.status}) and is exiting`
          : `the agent is not running (${shown.status}${shown.reason ? `: ${shown.reason}` : ""})`;
      const resumable = rec.sessionId !== undefined;
      throw new HostError(409, `${why}; the message was not sent${resumable ? ". Resume the agent with it instead" : ", and the agent never reached Claude Code, so it cannot be resumed"}`, {
        resumable,
        status: shown.status,
      });
    }
    const messageId = randomUUID();
    const text = renderForAgent(req);
    const said = req.kind === "text" ? req.text : req.comment.text;
    const comment = req.kind === "comment" ? { file: req.comment.file, line: req.comment.line, lineText: req.comment.lineText } : undefined;
    // Recorded before it is pushed: a fake (or very fast) Claude Code may report it at once.
    const line = this.record(id, "host", { event: "message-sent", messageId, said, comment, text });
    live.undelivered.add(messageId);
    live.input.push(text, messageId);
    // Sent after the result, while the run waits: it gets the whole wait from now (#124).
    if (live.turnOver) this.waitForMessages(rec, live);
    this.changed(rec);
    return { agent: this.view(rec), message: { messageId, said, comment, text, sentAt: line.at, state: "queued" } };
  }

  /**
   * Answer a parked permission request from the owner (#77): `{ decision: "allow" }` lets the
   * call run as asked; `{ decision: "deny", message? }` refuses it and the agent reads the message
   * (it is not interrupted, so it can reply to it). 409 when the request is no longer waiting.
   */
  answer(id: string, requestId: string, body: Record<string, unknown>): AgentView {
    const live = this.live.get(id);
    const rec = live ? this.agents.get(id) : this.find(id);
    if (!rec) throw new HostError(404, `no agent ${id}`);
    const a = parsePermissionAnswer(body);
    if ("error" in a) throw new HostError(400, a.error);
    if (!live) this.refuseElsewhere(rec, "answer it");
    const p = live?.pending.get(requestId);
    if (!p) {
      const status = this.view(rec).status;
      throw new HostError(409, `request ${requestId} is no longer waiting: it was answered already, or withdrawn because the agent stopped (${status})`, {
        status,
      });
    }
    const result: PermissionResult =
      a.decision === "allow" ? { behavior: "allow", updatedInput: p.input } : { behavior: "deny", message: a.message };
    this.answerPermission(id, requestId, result);
    return this.view(rec);
  }

  /** Settle a parked permission request. */
  answerPermission(id: string, requestId: string, result: PermissionResult): boolean {
    const live = this.live.get(id);
    const p = live?.pending.get(requestId);
    if (!live || !p) return false;
    live.pending.delete(requestId);
    this.record(id, "host", {
      event: "permission-answered",
      requestId,
      behavior: result.behavior,
      ...(result.behavior === "deny" ? { message: result.message } : {}),
    });
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

  /**
   * Agents running now, as counted against the cap (#225): this server's own, and those another
   * AnviDeck server that is still alive runs on the same registry (`agents`, as on disk).
   */
  private runningEverywhere(agents: AgentRecord[], replacing?: string): { here: number; elsewhere: AgentRecord[] } {
    // The resume of an exiting agent replaces its process: it needs no slot of its own (#126).
    const here = this.live.size - (replacing !== undefined && this.live.has(replacing) ? 1 : 0);
    return { here, elsewhere: agents.filter((a) => !this.live.has(a.id) && this.elsewhere(a) !== undefined) };
  }

  /** 429 when the agents running in every server on this registry reach this server's cap. */
  private checkCap(agents: AgentRecord[], replacing?: string): void {
    const { here, elsewhere } = this.runningEverywhere(agents, replacing);
    const total = here + elsewhere.length;
    if (total < this.cap) return;
    const servers = [...new Set(elsewhere.map((a) => (a.owner!.port !== undefined ? `port ${a.owner!.port}` : `pid ${a.owner!.pid}`)))];
    const split = elsewhere.length ? ` (${here} here, ${elsewhere.length} in another AnviDeck server: ${servers.join(", ")})` : "";
    throw new HostError(429, `${total} agent${total === 1 ? " is" : "s are"} running${split}, the most allowed at once is ${this.cap}; stop one first`, {
      running: { here, elsewhere: elsewhere.length },
      cap: this.cap,
    });
  }

  /**
   * The cap checked before anything is made (from-issue makes a worktree first), on the registry
   * as it reads now. The start checks again under the lock. A registry that cannot be read is
   * refused, never counted as empty.
   */
  precheckCap(): void {
    let agents: AgentRecord[];
    try {
      agents = this.registry.load();
    } catch (e) {
      throw new HostError(503, `the agent registry could not be read, so the agents running in other AnviDeck servers could not be counted against the cap: ${(e as Error).message}`);
    }
    this.checkCap(agents);
  }

  /** A read-modify-write of the registry under its lock for a start or resume; refusals thrown in `fn` pass through. */
  private claim<T>(doing: "started" | "resumed", fn: (agents: AgentRecord[]) => { agents?: AgentRecord[]; out: T }): T {
    try {
      return this.registry.update(fn, PERSIST_WAIT_MS);
    } catch (e) {
      if (e instanceof HostError) throw e;
      if (e instanceof RegistryLockedError) throw new HostError(503, `${e.message}; the agent was not ${doing}, try again in a moment`);
      throw new HostError(503, `the agent registry could not be read, so the agent was not ${doing}: ${(e as Error).message}`);
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
      ? [...live.pending.values()].map(({ resolve: _r, ...p }) => (p.subagent ? { ...p, subagent: { ...live.subagents.get(p.subagent.id), id: p.subagent.id } } : p))
      : [];
    if (!live) {
      const where = this.elsewhere(a);
      if (where) return { ...a, running: false, pendingPermissions, runsElsewhere: where };
      // No process of it runs anywhere that is still alive (a gone server's flag is stale).
      const { processAlive: _p, ...rest } = a;
      if (LIVE_STATUSES.has(a.status)) {
        // Its server is gone since this host started: shown as stopped (the next write records it).
        return { ...rest, status: "stopped", reason: this.goneReason(a), running: false, pendingPermissions };
      }
      return { ...rest, running: false, pendingPermissions };
    }
    if (this.isExiting(live)) {
      const endsBy = new Date(Date.parse(live.exitingSince!) + this.exitGraceMs).toISOString();
      return { ...a, running: true, pendingPermissions, exiting: { since: live.exitingSince!, endsBy } };
    }
    return { ...a, running: true, pendingPermissions };
  }

  private launch(rec: AgentRecord, prompt: string, claude: ClaudeBinary, resumeId: string | undefined, github: GithubAccess): void {
    const login = this.envFn();
    const stripped = login.stripped;
    const { env, removed } = withGithubAccess(login.env, github, this.ghConfigDir(rec.id));
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
      undelivered: new Set(),
      turnOpen: true,
      turnsStarted: 1,
      subagents: new Map(),
      timers: new Set(),
    };
    // Registered before any await, so two starts in one tick cannot both pass the cap.
    this.live.set(rec.id, live);
    rec.processAlive = true;
    rec.runs += 1;
    rec.status = "starting";
    rec.reason = undefined;
    rec.apiKeySource = undefined;
    rec.permissionMode = undefined;
    const mode = rec.mode ?? DEFAULT_MODE;
    rec.claudePath = claude.path;
    rec.claudeRealPath = claude.realPath;
    rec.strippedEnv = stripped;
    rec.githubAccess = github;
    rec.githubRemoved = removed;
    this.record(rec.id, "host", {
      event: resumeId ? "resumed" : "started",
      prompt,
      mode,
      githubAccess: github,
      githubRemoved: removed,
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
      // Always said, never left to the folder's settings, so the agent runs in the mode shown (#249).
      permissionMode: mode,
      // Under Full access Claude Code approves every call before any callback is asked (only deny
      // rules still stop one), so no permission callback is given: the SDK warns that it would never
      // be called (sdk.mjs, CLAUDE_SDK_CAN_USE_TOOL_SHADOWED), and nothing can come to you to answer.
      ...(mode === "bypassPermissions"
        ? { allowDangerouslySkipPermissions: true }
        : { canUseTool: (toolName: string, toolInput: Record<string, unknown>, opts: Parameters<NonNullable<Options["canUseTool"]>>[2]) => this.park(rec.id, live, toolName, toolInput, opts) }),
      stderr: (d) => {
        live.stderrTail = (live.stderrTail + d).slice(-2000);
      },
    };
    const go = () => {
      let q: ReturnType<QueryFn>;
      try {
        q = this.queryFn({ prompt: input, options });
      } catch (e) {
        this.finish(rec, live, e);
        return;
      }
      live.close = q.close?.bind(q);
      void this.consume(rec, live, q);
    };
    const store = this.checkpoints;
    if (!store) return go();
    // The checkpoint before the run is taken before Claude Code starts, so nothing the agent does
    // is in it (#248). A snapshot that fails is recorded as failed and the run starts anyway.
    void store.capture(rec.id, rec.cwd, { when: "before-run", run: rec.runs }).then(() => {
      // Stopped while the snapshot was taken: the run never starts.
      if (live.ending) this.finish(rec, live, undefined);
      else go();
    });
  }

  /** A turn ended: take its checkpoint (#248), noting if the next turn began before it was done. */
  private checkpointTurn(rec: AgentRecord, live: Live, when: "after-turn" | "run-ended"): void {
    const store = this.checkpoints;
    if (!store || !live.turnOpen) return;
    live.turnOpen = false;
    const started = live.turnsStarted;
    void store.capture(rec.id, rec.cwd, { when, run: rec.runs, ...(when === "run-ended" && rec.reason ? { reason: rec.reason } : {}) }, () =>
      live.turnsStarted !== started ? { mayIncludeNext: true } : {},
    );
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
    if (live.undelivered.size) this.noteDelivery(rec, live, m);
    if (this.noteSubagent(live, m) && live.pending.size) this.changed(rec);
    if (m.type === "system" && m.subtype === "init") {
      live.sawInit = true;
      rec.sessionId = m.session_id;
      rec.apiKeySource = m.apiKeySource;
      rec.claudeCodeVersion = m.claude_code_version;
      rec.model = m.model;
      rec.permissionMode = m.permissionMode;
      // A mode wider than the one chosen, or one this host does not know, never runs (#249). A
      // narrower one runs, and the card shows both (e.g. Full access that your settings turn off).
      const asked = rec.mode ?? DEFAULT_MODE;
      if (!isAgentMode(m.permissionMode) || rank(m.permissionMode) > rank(asked)) {
        this.endRun(rec.id, live, {
          status: "failed",
          reason:
            m.permissionMode === undefined
              ? `Stopped at once: Claude Code did not report its permission mode, so it could not be checked against the ${modeInfo(asked).label} it was started in`
              : `Stopped at once: Claude Code reported permission mode "${m.permissionMode}", wider than the ${modeInfo(asked).label} it was started in`,
        });
        return;
      }
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
      if (!live.sawInit) {
        live.turnOver = { status: "failed", reason: "Claude Code ended before it said which login it was using" };
      } else if (m.subtype === "success" && !m.is_error) {
        live.turnOver = { status: "done" };
      } else {
        const detail = m.subtype === "success" ? m.result : (m.errors ?? []).join("; ");
        live.turnOver = { status: "failed", reason: `Claude Code reported ${m.subtype}${detail ? `: ${String(detail).slice(0, 300)}` : ""}` };
      }
      this.checkpointTurn(rec, live, "after-turn");
      if (!this.maybeEndTurn(rec, live)) {
        if (live.undelivered.size) this.waitForMessages(rec, live);
        this.changed(rec);
      }
    }
  }

  /**
   * The turn's result is in and a message sent to the agent waits to run as its next turn. If
   * Claude Code neither takes it in nor turns it away within MESSAGE_WAIT_MS, it is recorded
   * as not delivered and the result applies (#124): the agent never stays working on it forever.
   */
  private waitForMessages(rec: AgentRecord, live: Live): void {
    if (live.messageWait) {
      clearTimeout(live.messageWait);
      live.timers.delete(live.messageWait);
    }
    const t = setTimeout(() => {
      live.timers.delete(t);
      live.messageWait = undefined;
      if (this.live.get(rec.id) !== live || live.ending || !live.turnOver || !live.undelivered.size) return;
      const s = Math.round(this.messageWaitMs / 1000);
      for (const u of live.undelivered) {
        this.record(rec.id, "host", { event: "message-not-delivered", messageId: u, reason: `Claude Code did not take it in within ${s} s after the agent's turn ended; resume the agent with it` });
      }
      live.undelivered.clear();
      if (!this.maybeEndTurn(rec, live)) this.changed(rec);
    }, this.messageWaitMs);
    t.unref?.();
    live.messageWait = t;
    live.timers.add(t);
  }

  /**
   * Learn a subagent's type and description (#267). True when something new was learnt. The
   * `task_started` message is the authority; a subagent's own message fills in only what is missing.
   */
  private noteSubagent(live: Live, m: SDKMessage): boolean {
    const o = m as unknown as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
    let id: string | undefined;
    let got: { type?: string; description?: string };
    if (o.type === "system" && o.subtype === "task_started") {
      id = text(o.task_id);
      got = { type: text(o.subagent_type), description: text(o.description) };
    } else if (o.type === "assistant" || o.type === "user") {
      id = text(o.agent_id);
      got = { type: text(o.subagent_type), description: text(o.task_description) };
    } else return false;
    if (!id || (!got.type && !got.description)) return false;
    const had = live.subagents.get(id) ?? {};
    const next = o.type === "system" ? { type: got.type ?? had.type, description: got.description ?? had.description } : { type: had.type ?? got.type, description: had.description ?? got.description };
    if (next.type === had.type && next.description === had.description) return false;
    live.subagents.set(id, next);
    return true;
  }

  /**
   * The turn is over and nothing sent is still waiting: close the prompt stream so the process
   * exits (see header), and take the turn's status. True when it did.
   */
  private maybeEndTurn(rec: AgentRecord, live: Live): boolean {
    if (!live.turnOver || live.undelivered.size || !live.input.open || live.ending) return false;
    live.input.end();
    rec.status = live.turnOver.status;
    rec.reason = live.turnOver.reason;
    live.exitingSince = new Date().toISOString();
    // Claude Code exits within seconds unless a background task keeps it going: past the grace
    // it is ended, so a finished agent never holds a run slot for long (#105).
    const t = setTimeout(() => {
      live.timers.delete(t);
      if (this.live.get(rec.id) !== live || !this.isExiting(live)) return;
      this.cutOff(rec.id, live, `Claude Code was still running ${Math.round(this.exitGraceMs / 1000)} s after the agent's result (a background task it started, for example); AnviDeck ended it so it no longer holds a run slot. The result stands`);
      this.changed(rec);
    }, this.exitGraceMs);
    t.unref?.();
    live.timers.add(t);
    this.changed(rec);
    return true;
  }

  /** Mark messages Claude Code reports as taken in (or turned away) by this frame. */
  private noteDelivery(rec: AgentRecord, live: Live, m: unknown): void {
    const { delivered, refused } = deliveryIn(m);
    let any = false;
    for (const u of delivered) {
      if (!live.undelivered.delete(u)) continue;
      any = true;
      const by = (m as { type?: string }).type === "command_lifecycle" ? "started" : String((m as { type?: string }).type);
      this.record(rec.id, "host", { event: "message-delivered", messageId: u, by });
      // A message that starts its own turn after the last result reopens the run.
      if (live.turnOver) {
        live.turnOpen = true;
        live.turnsStarted += 1;
      }
      live.turnOver = undefined;
    }
    for (const r of refused) {
      if (!live.undelivered.delete(r.uuid)) continue;
      any = true;
      this.record(rec.id, "host", { event: "message-not-delivered", messageId: r.uuid, reason: `Claude Code ${r.state} it before the agent read it` });
    }
    if (any && !this.maybeEndTurn(rec, live)) this.changed(rec);
  }

  private park(
    id: string,
    live: Live,
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; decisionReason?: string; blockedPath?: string; toolUseID?: string; agentID?: string },
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
        ...(opts.toolUseID ? { toolUseId: opts.toolUseID } : {}),
        // A subagent's ask (#267): its id now; its name is looked up each time the card is drawn.
        ...(opts.agentID ? { subagent: { id: opts.agentID } } : {}),
        resolve,
      };
      live.pending.set(requestId, p);
      opts.signal.addEventListener("abort", () => {
        if (live.pending.delete(requestId)) {
          this.record(id, "host", { event: "permission-withdrawn", requestId, reason: "Claude Code cancelled the call" });
          resolve({ behavior: "deny", message: "request cancelled" });
          const rec = this.agents.get(id)!;
          if (live.pending.size === 0 && rec.status === "waiting") this.setStatus(rec, "working");
          else this.changed(rec);
        }
      });
      const sub = opts.agentID ? { id: opts.agentID, ...live.subagents.get(opts.agentID) } : undefined;
      this.record(id, "host", {
        event: "permission-asked", requestId, toolName, input, decisionReason: opts.decisionReason,
        ...(opts.toolUseID ? { toolUseId: opts.toolUseID } : {}),
        ...(sub ? { subagent: sub } : {}),
      });
      this.setStatus(this.agents.get(id)!, "waiting");
    });
  }

  /** The host ends a run itself (stop, wrong credential, shutdown). Status is set now, not when the process exits. */
  private endRun(id: string, live: Live, ending: { status: "stopped" | "failed"; reason: string }): void {
    if (live.ending) return;
    // After its result (server shutdown, say): the process is ended, the result stands (#114).
    if (live.exitingSince) {
      this.cutOff(id, live, `${ending.reason}; the result stands`);
      return;
    }
    live.ending = ending;
    this.withdrawAll(id, live, ending.reason);
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
    for (const t of live.timers) clearTimeout(t);
    live.timers.clear();
    // A resume was waiting for this process to exit (#126): its run starts now, on the same
    // record; this run's result was recorded when it came.
    if (live.handoff) {
      const next = live.handoff;
      live.handoff = undefined;
      next();
      return;
    }
    delete rec.processAlive;
    this.withdrawAll(rec.id, live, "agent ended");
    live.input.end();
    const why = live.ending ? live.ending.reason : "the agent's run ended before it read the message";
    for (const u of live.undelivered) this.record(rec.id, "host", { event: "message-not-delivered", messageId: u, reason: why });
    live.undelivered.clear();
    if (live.ending) {
      rec.status = live.ending.status;
      rec.reason = live.ending.reason;
    } else if (live.turnOver) {
      // A result was reported: it stands, however the process then exits (#114). An error after
      // it is recorded, unless AnviDeck ended the process itself.
      if (error !== undefined && !live.cutOff) {
        const msg = error instanceof Error ? error.message : String(error);
        this.record(rec.id, "host", { event: "exited-with-error-after-result", reason: `Claude Code exited with an error after the agent's result; the result stands: ${msg}`.slice(0, 600) });
      }
      rec.status = live.turnOver.status;
      rec.reason = live.turnOver.reason;
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
    // A run that ended mid-turn (stopped, failed) still gets the turn's checkpoint, if Claude Code
    // ever started on it: before init the agent has done nothing in the folder.
    if (live.sawInit) this.checkpointTurn(rec, live, "run-ended");
    this.changed(rec);
  }

  /** The run is ending: every request still parked is withdrawn (denied, never allowed) and recorded. */
  private withdrawAll(id: string, live: Live, reason: string): void {
    for (const p of live.pending.values()) {
      this.record(id, "host", { event: "permission-withdrawn", requestId: p.requestId, reason });
      p.resolve({ behavior: "deny", message: reason, interrupt: true });
    }
    live.pending.clear();
  }

  private setStatus(rec: AgentRecord, s: AgentStatus): void {
    rec.status = s;
    this.changed(rec);
  }

  private changed(rec: AgentRecord): void {
    rec.updatedAt = new Date().toISOString();
    this.settle(rec, this.persist(rec));
  }

  /**
   * After a write: tell the pages. A record another server has claimed since is no longer this
   * host's (its run here has ended): it is dropped from memory and the pages get the file's version.
   */
  private settle(rec: AgentRecord, kept: boolean): void {
    if (!kept && !this.live.has(rec.id)) {
      this.agents.delete(rec.id);
      try {
        this.emitFn({ type: "agent", data: this.get(rec.id) });
      } catch {
        /* the file cannot be read now; the next list says so */
      }
      return;
    }
    this.emitFn({ type: "agent", data: this.view(rec) });
  }

  /**
   * Write this one record over its own entry, only while this host still owns it on disk: a
   * server that has claimed the agent since (resumed it) keeps its claim, and a late write from
   * here (a process exiting after its turn) never puts back a stale owner and status (#104).
   * Every other record stays as it is on disk. False when another server owns it now.
   * A write that finds the registry locked is retried after RETRY_MS, never dropped.
   */
  private persist(rec: AgentRecord): boolean {
    try {
      const kept = this.registry.update((agents) => {
        const i = agents.findIndex((a) => a.id === rec.id);
        const there = i >= 0 ? agents[i] : undefined;
        if (there?.owner && there.owner.instance !== this.owner.instance) return { out: false };
        const next = [...agents];
        if (i >= 0) next[i] = rec;
        else next.push(rec);
        return { agents: next, out: true };
      }, PERSIST_WAIT_MS);
      this.unsaved.delete(rec.id);
      return kept;
    } catch (e) {
      console.error(`[agents] could not write the registry: ${(e as Error).message}`);
      if (e instanceof RegistryLockedError) {
        this.unsaved.add(rec.id);
        this.scheduleRetry();
      }
      return true;
    }
  }

  private record(id: string, from: "sdk" | "host", message: unknown): TranscriptLine {
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
    return line;
  }
}
