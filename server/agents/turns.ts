/**
 * What each turn of an agent changed, and Undo (#248): the routes' side of the checkpoints the
 * agent host takes (server/agents/checkpoints.ts).
 *
 * Undo is refused while anything may be working in the agent's folder: the agent itself (here or
 * on another server), another of AnviDeck's agents whose folder is this one or inside it, or a
 * terminal Claude Code session there. A sessions folder that could not be read refuses too: a
 * session working there may be among the unread.
 *
 * One that works in a folder ABOVE the agent's (a session at the project's root, when the agent's
 * worktree is `.claude/worktrees/issue-N` inside it) is named as a warning, not a refusal: it is
 * working on another checkout, and refusing on it would turn Undo off whenever you have the
 * project open in a terminal. It can still edit here; the preview says so.
 */
import { spawnSync } from "node:child_process";
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
/** Is `other` (a session's or agent's folder) a folder above `here`, not `here` itself? */
const above = (other: string, here: string) => other !== here && within(here, other);
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

  /**
   * Why nothing may put this agent's folder back now (`why`, or null), and what works in a folder
   * above it (`warnings`: allowed, but named in the preview).
   */
  private busy(a: AgentView): { why: string | null; warnings: string[] } {
    const warnings: string[] = [];
    const no = (why: string) => ({ why, warnings });
    if (a.runsElsewhere) return no(`it runs on another AnviDeck server (pid ${a.runsElsewhere.pid}); stop it there first`);
    if (a.running || LIVE_STATUSES.has(a.status)) return no(`it is ${a.status}; stop it first`);
    const here = realOr(a.cwd);
    let others: AgentView[];
    try {
      others = this.host.list();
    } catch (e) {
      return no(`whether another agent works in its folder could not be checked (${(e as Error).message})`);
    }
    for (const o of others) {
      if (o.id === a.id || !(o.running || o.runsElsewhere || LIVE_STATUSES.has(o.status))) continue;
      const there = realOr(o.cwd);
      if (within(there, here)) return no(`agent ${o.id} is ${o.status} in ${o.cwd}`);
      if (above(there, here)) warnings.push(`agent ${o.id} is ${o.status} in ${o.cwd}, which holds this folder: make sure it is not editing here`);
    }
    let read: ReturnType<SessionsRead>;
    try {
      read = this.sessions();
    } catch (e) {
      return no(`the live Claude Code sessions could not be read (${(e as Error).message}), so whether one works in this folder is not known`);
    }
    if (read.report.status === "unreadable" || read.report.status === "partial")
      return no(`the live Claude Code sessions could not all be read (${read.report.errors.join("; ")}), so whether one works in this folder is not known`);
    for (const t of read.sessions) {
      if (a.sessionId && t.sessionId === a.sessionId) continue;
      const who = `a terminal Claude Code session (${t.sessionId.slice(0, 8) || "no session id"}, pid ${t.pid})`;
      // A folder not known is not "elsewhere" (#286).
      if (!t.cwd) return no(`${who} names no working folder, so whether it works in this folder is not known`);
      const there = realOr(t.cwd);
      if (within(there, here)) return no(`${who} works in ${t.cwd}`);
      if (above(there, here)) warnings.push(`${who} works in ${t.cwd}, which holds this folder: make sure it is not editing here`);
    }
    return { why: null, warnings };
  }

  list(id: string): CheckpointsAnswer {
    const a = this.host.get(id);
    const store = this.store();
    const { records, unreadable } = store.read(id);
    const kept = store.kept(id);
    const undoable = store.undoable(id).map((c) => c.n);
    const folderGone = !existsDir(a.cwd);
    const b = folderGone ? { why: `its folder ${a.cwd} no longer exists`, warnings: [] } : this.busy(a);
    const why = b.why;
    return {
      agentId: id,
      cwd: a.cwd,
      records,
      unreadable,
      undoable,
      undo: why ? { ok: false, why } : { ok: true, warnings: b.warnings },
      folderGone,
      kept,
      prefix: folderGone ? null : gitPrefix(a.cwd),
      diskBytes: kept ? store.diskUse(id) : 0,
    };
  }

  private num(n: string): number {
    const v = Number(n);
    if (!Number.isInteger(v) || v <= 0) throw new HostError(400, `not a checkpoint number: ${n}`);
    return v;
  }

  private refused(e: unknown): never {
    if (e instanceof CheckpointError && e.refusal === "too-large")
      // Undo snapshots the folder as it is first (to keep what it would discard): over the limit it cannot (#276).
      throw new HostError(409, `Undo is not offered: the folder as it is now cannot be snapshotted, and Undo keeps such a snapshot of what it would discard. The snapshot was ${e.message}`, { refusal: e.refusal });
    if (e instanceof CheckpointError) throw new HostError(e.status, e.message, { refusal: e.refusal });
    throw e;
  }

  /** What Undo to checkpoint `n` would discard, read just now. Writes nothing to the folder or the record. */
  async plan(id: string, nIn: string): Promise<UndoPlan> {
    const n = this.num(nIn);
    const a = this.host.get(id);
    const store = this.store();
    const { why, warnings } = this.busy(a);
    if (why) throw new HostError(409, `Undo is not offered now: ${why}`, { refusal: "busy" });
    try {
      const to = await store.target(id, a.cwd, n);
      const now = await store.serial(id, () => store.snapshot(id, a.cwd));
      const { changes, count } = await store.changes(id, a.cwd, to.tree, now.tree);
      return { agentId: id, cwd: a.cwd, to: n, toAt: to.at, toWhen: to.when, current: now.tree, discarded: changes, discardedCount: count, head: { then: to.head, now: now.head }, warnings };
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
    const { why } = this.busy(a);
    if (why) throw new HostError(409, `Undo refused: ${why}`, { refusal: "busy" });
    this.host.hold(id, a.cwd, `Undo to checkpoint ${n} is putting its folder back`);
    try {
      // Checked again under the hold: a resume between the check and the hold is refused from here on.
      const again = this.busy(this.host.get(id)).why;
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

/** The folder's place in its git checkout ("" at the top), or null when git cannot say (#275). */
function gitPrefix(cwd: string): string | null {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-prefix"], { encoding: "utf8", timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

function existsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
