/**
 * Which files AnviDeck's agents edited, and which running agent keeps a file from being edited
 * on the Code screen (#88). One module for both, so the "agent touched" marker in the tree and the
 * refusal of an edit are decided from the same facts:
 *
 *   - the agents are the agent host's own (host.list(): its live state, `running`), and
 *   - what each edited is read from its transcript in the host's registry: every Write, Edit,
 *     MultiEdit and NotebookEdit tool call Claude Code made, by the path it named.
 *
 * "The same file" is judged as the replay reader judges it (repoFileKey: the repository's object
 * store and the repository-relative path), so an agent editing src/x.ts in its own worktree
 * touches src/x.ts of the main checkout too: both end in the same file once its branch merges.
 *
 * A transcript that could not be read whole leaves that agent's edits unknown, and an unknown is
 * never read as "edited nothing": a running agent whose edits are not known keeps every file of
 * its repository read-only.
 */
import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { spawnSync } from "node:child_process";
import { LIVE_STATUSES, type AgentStatus } from "./agents/registry";
import { repoFileKey } from "./readers/replay";
import type { AgentsRead, AgentTouch, Touching } from "../shared/code-types";
import type { ReadReport } from "../shared/types";

/** A terminal Claude Code session as ~/.claude/sessions says it runs (server/readers/sessions.ts). */
export interface TerminalSession {
  sessionId: string;
  pid: number;
  cwd: string;
  status: string;
}

/**
 * Terminal Claude Code sessions (not AnviDeck's) whose working folder holds the file. What a
 * terminal session edited is not read (only its folder is known), and a session can edit outside
 * its folder: that is not caught. A sessions folder that could not be read whole keeps every file
 * read-only, since a session working there may be among the unread.
 *
 * An AnviDeck agent is a live Claude Code session too, with its own file in ~/.claude/sessions.
 * `listedAgents` maps the session ids of the agents already named as keeping this file to their
 * ids; such a session is that agent, so it is left out here rather than named a second time as a
 * terminal session (#252). Only those: a session whose agent is not in the list stays, since then
 * the session file is the only sign of someone working there (an agent the host has lost track of).
 */
export function terminalTouching(abs: string, read: { sessions: TerminalSession[]; report: ReadReport }, listedAgents: ReadonlyMap<string, string> = new Map()): Touching[] {
  if (read.report.status === "unreadable" || read.report.status === "partial")
    return [{ id: "terminal sessions", status: read.report.status, why: "sessions not known", detail: `the live Claude Code sessions could not all be read (${read.report.errors.join("; ")}), so whether one works in this folder is not known` }];
  const file = realOr(abs);
  return read.sessions
    .filter((t) => t.cwd && inside(file, realOr(t.cwd)) && !(t.sessionId && listedAgents.has(t.sessionId)))
    .map((t) => ({ id: t.sessionId || `pid ${t.pid}`, status: t.status, why: "a terminal session works in this folder" as const, detail: `a terminal Claude Code session (${t.sessionId.slice(0, 8)}, pid ${t.pid}, ${t.status}) works in ${t.cwd}, which holds this file` }));
}

export const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** The part of the agent host this module asks (AgentHost satisfies it). */
export interface HostLike {
  readonly registry: { dir: string };
  list(): { id: string; status: string; running: boolean; cwd: string; prompt: string; sessionId?: string }[];
  transcript(id: string): { lines: { at: string; from: string; message: unknown }[]; unreadable: number };
}

export interface AgentFact {
  id: string;
  status: string;
  running: boolean;
  cwd: string;
  prompt: string;
  /** Claude Code's session id, once its init arrived: its live session file has this id (#252). */
  sessionId?: string;
  edits: { abs: string; tool: string; at: string }[];
  /** Set when the transcript could not be read whole. */
  unreadable?: string;
}

/** Every file-editing tool call in a host transcript, by the absolute path it named. */
export function editsIn(lines: { at: string; from: string; message: unknown }[]): { abs: string; tool: string; at: string }[] {
  const out: { abs: string; tool: string; at: string }[] = [];
  for (const l of lines) {
    if (l.from !== "sdk") continue;
    const m = l.message as { type?: string; message?: { content?: unknown } } | null;
    if (!m || m.type !== "assistant" || !Array.isArray(m.message?.content)) continue;
    for (const b of m.message!.content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
      if (b?.type !== "tool_use" || !b.name || !EDIT_TOOLS.has(b.name)) continue;
      const p = b.input?.file_path ?? b.input?.notebook_path;
      if (typeof p === "string" && p.startsWith("/")) out.push({ abs: p, tool: b.name, at: l.at });
    }
  }
  return out;
}

/** The agents and what each edited. Throws when the host cannot be asked; the caller says so. */
export function agentFacts(host: HostLike): AgentFact[] {
  return host.list().map((a) => {
    let edits: AgentFact["edits"] = [];
    let unreadable: string | undefined;
    try {
      const t = host.transcript(a.id);
      edits = editsIn(t.lines);
      if (t.unreadable) unreadable = `${t.unreadable} line(s) of its transcript could not be read`;
    } catch (e) {
      unreadable = `its transcript could not be read: ${(e as Error).message}`;
    }
    return { id: a.id, status: a.status, running: a.running, cwd: a.cwd, prompt: a.prompt, ...(a.sessionId ? { sessionId: a.sessionId } : {}), edits, ...(unreadable ? { unreadable } : {}) };
  });
}

const realOr = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** A Claude Code process runs, or is about to, for this agent. */
export const isLive = (a: { running: boolean; status: string }) => a.running || LIVE_STATUSES.has(a.status as AgentStatus);

/** The git object store a path's repository uses, or null outside a repository. */
export function storeOf(dir: string): string | null {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
  return r.status === 0 ? realOr(r.stdout.trim()) : null;
}

/**
 * The running agents that keep the file at `abs` from being edited, each with why:
 *   works in this folder — the agent's working folder holds the file: it may write it at any moment;
 *   edited this file     — it edited the same file (same repository, same path) in any checkout;
 *   edits not known      — its transcript could not be read whole, and the file is in its repository.
 * Agents that are not running never keep a file.
 */
export function touching(abs: string, agents: AgentFact[], keyOf: (p: string) => string | null = (p) => repoFileKey(p)): Touching[] {
  const file = realOr(abs);
  const fileKey = keyOf(abs);
  const fileStore = fileKey ? fileKey.split("\0")[0] : null;
  const out: Touching[] = [];
  for (const a of agents) {
    if (!isLive(a)) continue;
    const cwd = realOr(a.cwd);
    if (inside(file, cwd)) {
      out.push({ id: a.id, status: a.status, why: "works in this folder", detail: `agent ${a.id} (${a.status}) works in ${a.cwd}, which holds this file` });
      continue;
    }
    const hit = a.edits.find((e) => realOr(e.abs) === file || (fileKey !== null && keyOf(e.abs) === fileKey));
    if (hit) {
      out.push({ id: a.id, status: a.status, why: "edited this file", detail: `agent ${a.id} (${a.status}) edited this file with ${hit.tool} at ${hit.at} (${hit.abs})` });
      continue;
    }
    if (a.unreadable) {
      const agentStore = storeOf(cwd);
      if (fileStore === null || agentStore === null || agentStore === fileStore)
        out.push({ id: a.id, status: a.status, why: "edits not known", detail: `agent ${a.id} (${a.status}) works in this repository and ${a.unreadable}, so whether it edited this file is not known` });
    }
  }
  return out;
}

/**
 * For the tree: every agent with an edit on a file of this package (running or not), the edits as
 * package-relative paths. "off" when the host could not be asked; "partial" when some agent's
 * transcript could not be read whole.
 */
export function agentsRead(host: HostLike | null, offReason: string | null, ctx: { top: string; packageRel: string }, keyOf: (p: string) => string | null = (p) => repoFileKey(p)): AgentsRead {
  if (!host) return { status: "off", reason: offReason ?? "the agent host is not running", registry: null, total: 0, running: 0, agents: [] };
  let facts: AgentFact[];
  try {
    facts = agentFacts(host);
  } catch (e) {
    return { status: "off", reason: `the agent host could not list its agents: ${(e as Error).message}`, registry: host.registry.dir, total: 0, running: 0, agents: [] };
  }
  const store = storeOf(ctx.top);
  const prefix = ctx.packageRel ? ctx.packageRel + "/" : "";
  const cache = new Map<string, string | null>();
  const key = (p: string) => {
    if (!cache.has(p)) cache.set(p, keyOf(p));
    return cache.get(p)!;
  };
  const agents: AgentTouch[] = [];
  for (const a of facts) {
    const edits = [];
    for (const e of a.edits) {
      const k = key(e.abs);
      if (!k || !store) continue;
      const [s, rel] = k.split("\0");
      if (s !== store || !rel.startsWith(prefix)) continue;
      edits.push({ file: rel.slice(prefix.length), abs: e.abs, tool: e.tool, at: e.at });
    }
    if (edits.length || (a.unreadable && isLive(a)))
      agents.push({ id: a.id, status: a.status, running: isLive(a), cwd: a.cwd, prompt: a.prompt.split("\n")[0].slice(0, 160), edits, ...(a.unreadable ? { unreadable: a.unreadable } : {}) });
  }
  const bad = facts.filter((a) => a.unreadable);
  return {
    status: bad.length ? "partial" : "ok",
    ...(bad.length ? { reason: bad.map((a) => `${a.id}: ${a.unreadable}`).join("; ") } : {}),
    registry: host.registry.dir,
    total: facts.length,
    running: facts.filter(isLive).length,
    agents,
  };
}
