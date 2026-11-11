/**
 * What each turn of an agent changed, and Undo (#248): the routes' side of the checkpoints the
 * agent host takes (server/agents/checkpoints.ts).
 *
 * Undo is refused while anything may be working in the agent's folder: the agent itself (here or
 * on another server), another of AnviDeck's agents in the same folder, or a terminal Claude Code
 * session there. A sessions folder that could not be read refuses too: a session working there may
 * be among the unread.
 */
import { realpathSync, statSync } from "node:fs";
import { sep } from "node:path";
import { AgentHost, HostError, type AgentView } from "./host";
import { CheckpointError } from "./checkpoints";
import { readLiveSessionsReport } from "../readers/sessions";
import { LIVE_STATUSES } from "./registry";
import type { CheckpointsAnswer, UndoAnswer, UndoPlan } from "../../shared/checkpoint-types";
import type { ReadReport } from "../../shared/types";

type SessionsRead = () => { sessions: { sessionId: string; pid: number; cwd: string; status: string }[]; report: ReadReport };

const realOr = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const within = (a: string, b: string) => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);
const SHA = /^[0-9a-f]{40}$/;

export class AgentTurns {
  private readonly sessions: SessionsRead;

  constructor(
    private readonly host: AgentHost,
    opts: { sessions?: SessionsRead } = {},
  ) {
    this.sessions = opts.sessions ?? readLiveSessionsReport;
  }

  private store() {
    const s = this.host.checkpoints;
    if (!s) throw new HostError(503, "this server takes no checkpoints (the agent host was started without them)", { refusal: "off" });
    return s;
  }

  /** Why nothing may put this agent's folder back now, or null. */
  private busy(a: AgentView): string | null {
    if (a.runsElsewhere) return `it runs on another AnviDeck server (pid ${a.runsElsewhere.pid}); stop it there first`;
    if (a.running || LIVE_STATUSES.has(a.status)) return `it is ${a.status}; stop it first`;
    const here = realOr(a.cwd);
    let others: AgentView[];
    try {
      others = this.host.list();
    } catch (e) {
      return `whether another agent works in its folder could not be checked (${(e as Error).message})`;
    }
    for (const o of others) {
      if (o.id === a.id) continue;
      if ((o.running || o.runsElsewhere || LIVE_STATUSES.has(o.status)) && overlaps(here, realOr(o.cwd))) return `agent ${o.id} is ${o.status} in ${o.cwd}`;
    }
    let read: ReturnType<SessionsRead>;
    try {
      read = this.sessions();
    } catch (e) {
      return `the live Claude Code sessions could not be read (${(e as Error).message}), so whether one works in this folder is not known`;
    }
    if (read.report.status === "unreadable" || read.report.status === "partial")
      return `the live Claude Code sessions could not all be read (${read.report.errors.join("; ")}), so whether one works in this folder is not known`;
    for (const t of read.sessions) {
      if (!t.cwd || (a.sessionId && t.sessionId === a.sessionId)) continue;
      if (overlaps(here, realOr(t.cwd))) return `a terminal Claude Code session (${t.sessionId.slice(0, 8)}, pid ${t.pid}) works in ${t.cwd}`;
    }
    return null;
  }

  list(id: string): CheckpointsAnswer {
    const a = this.host.get(id);
    const store = this.store();
    const { records, unreadable } = store.read(id);
    const kept = store.kept(id);
    const undoable = store.undoable(id).map((c) => c.n);
    const folderGone = !existsDir(a.cwd);
    const why = folderGone ? `its folder ${a.cwd} no longer exists` : this.busy(a);
    return {
      agentId: id,
      cwd: a.cwd,
      records,
      unreadable,
      undoable,
      undo: why ? { ok: false, why } : { ok: true },
      folderGone,
      kept,
    };
  }

  private num(n: string): number {
    const v = Number(n);
    if (!Number.isInteger(v) || v <= 0) throw new HostError(400, `not a checkpoint number: ${n}`);
    return v;
  }

  private refused(e: unknown): never {
    if (e instanceof CheckpointError) throw new HostError(e.status, e.message, { refusal: e.refusal });
    throw e;
  }

  /** What Undo to checkpoint `n` would discard, read just now. Writes nothing to the folder or the record. */
  async plan(id: string, nIn: string): Promise<UndoPlan> {
    const n = this.num(nIn);
    const a = this.host.get(id);
    const store = this.store();
    const why = this.busy(a);
    if (why) throw new HostError(409, `Undo is not offered now: ${why}`, { refusal: "busy" });
    try {
      const to = await store.target(id, a.cwd, n);
      const now = await store.serial(id, () => store.snapshot(id, a.cwd));
      const { changes, count } = await store.changes(id, a.cwd, to.tree, now.tree);
      return { agentId: id, cwd: a.cwd, to: n, toAt: to.at, toWhen: to.when, current: now.tree, discarded: changes, discardedCount: count, head: { then: to.head, now: now.head } };
    } catch (e) {
      if (e instanceof CheckpointError) this.refused(e);
      throw new HostError(502, (e as Error).message, { refusal: "snapshot-failed" });
    }
  }

  /** Undo: put the folder back to checkpoint `n`. `{ current }` is the tree the preview showed. */
  async undo(id: string, nIn: string, body: Record<string, unknown>): Promise<UndoAnswer> {
    const n = this.num(nIn);
    if (typeof body.current !== "string" || !SHA.test(body.current)) throw new HostError(400, "current must be the folder's snapshot the preview showed (40 hex)");
    const a = this.host.get(id);
    const store = this.store();
    const why = this.busy(a);
    if (why) throw new HostError(409, `Undo refused: ${why}`, { refusal: "busy" });
    this.host.hold(id, a.cwd, `Undo to checkpoint ${n} is putting its folder back`);
    try {
      // Checked again under the hold: a resume between the check and the hold is refused from here on.
      const again = this.busy(this.host.get(id));
      if (again) throw new HostError(409, `Undo refused: ${again}`, { refusal: "busy" });
      const r = await store.undo(id, a.cwd, n, body.current, a.runs);
      return { agentId: id, before: r.before.n, after: r.after.n, to: n, changeCount: r.after.changeCount };
    } catch (e) {
      if (e instanceof CheckpointError) this.refused(e);
      throw e;
    } finally {
      this.host.release(id);
    }
  }

  /** Remove this agent's snapshots by hand. Refused while anything works in its folder; the record is kept. */
  async clear(id: string): Promise<{ agentId: string; cleared: true }> {
    const a = this.host.get(id);
    const store = this.store();
    if (a.running || a.runsElsewhere || LIVE_STATUSES.has(a.status)) throw new HostError(409, `not cleared: the agent is ${a.status}; its next checkpoint would need them`, { refusal: "busy" });
    if (!store.kept(id)) throw new HostError(409, "this agent has no snapshots on this machine", { refusal: "none" });
    this.host.hold(id, a.cwd, "its checkpoints are being cleared");
    try {
      await store.clear(id, "cleared by you");
    } finally {
      this.host.release(id);
    }
    return { agentId: id, cleared: true };
  }
}

function existsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
