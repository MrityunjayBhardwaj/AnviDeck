/**
 * The turns of the AnviDeck agents that worked on a PR, for the Changes screen (#275).
 *
 * The join: the PR's sessions (server/readers/changes.ts) name the AnviDeck agents among them; each
 * agent's record (GET /api/agents/:id/checkpoints, #248) says what every turn changed in its folder.
 * A turn's paths are relative to the agent's folder; the answer's `prefix` puts them in the
 * repository's terms, as the PR names its files. Only turns taken on the PR's branch are the PR's.
 *
 * Every way of not knowing is said as such: an agent whose record could not be read, a server that
 * takes no checkpoints, an agent that ran before checkpoints existed, a turn whose file list was cut
 * short. None of them reads as "no turn changed this file".
 */
import type { SessionsRead } from "../../shared/changes-types";
import type { CheckpointEntry, CheckpointsAnswer, FileChange } from "../../shared/checkpoint-types";

export type TurnsLoad =
  | { state: "loading" }
  | { state: "ok"; data: CheckpointsAnswer }
  | { state: "error"; status: number | null; error: string };

export interface PrTurn {
  agentId: string;
  n: number;
  at: string;
  when: CheckpointEntry["when"];
  /** What the row is, in words: "turn ended", "changed outside the agent before run 2"… */
  label: string;
  /** The branch the folder was on; null on a detached HEAD. */
  branch: string | null;
  /** Its changes, in the repository's terms; `inPr` when the PR changes that file too. */
  files: (FileChange & { inPr: boolean })[];
  changeCount: number;
  /** Changed files the record did not keep (it keeps at most FILES_KEPT per checkpoint). */
  notKept: number;
  mayIncludeNext: boolean;
}

export type AgentTurnsState =
  /** Its record was read and its paths could be joined to the PR's. */
  | "listed"
  | "loading"
  /** The record holds no checkpoint: it ran before checkpoints were added (#248). */
  | "no-record"
  /** This server takes no checkpoints, so it cannot read the record. */
  | "off"
  | "unreadable"
  /** Read, but its folder is not placed in a git checkout, so its paths cannot be joined to the PR's. */
  | "paths-unknown";

export interface PrTurnsAgent {
  agentId: string;
  state: AgentTurnsState;
  /** Said under the agent's name; empty when its turns say it all. */
  notes: string[];
  /** Its turns on the PR's branch that changed something, oldest first. */
  turns: PrTurn[];
  /** Turns taken on another branch: not this PR's, counted and not shown. */
  otherBranch: number;
  /** Checkpoints on the PR's branch with nothing changed since the one before (the first is not counted). */
  unchanged: number;
}

export type PrTurnsView =
  | { state: "could-not-look"; note: string }
  | { state: "no-agent"; note: string }
  | { state: "agents"; agents: PrTurnsAgent[] };

const LABEL: Record<CheckpointEntry["when"], string> = {
  "after-turn": "turn ended",
  "run-ended": "run ended mid-turn",
  "before-run": "changed outside the agent",
  "before-undo": "changed outside the agent before an Undo",
  "after-undo": "Undo",
};

function label(c: CheckpointEntry): string {
  if (c.when === "before-run") return `changed outside the agent before run ${c.run}`;
  if (c.when === "after-undo") return `Undo to #${c.undoTo}`;
  return LABEL[c.when];
}

/** The AnviDeck agents among the PR's sessions, in the order the sessions list them. */
export function prAgentIds(sessions: SessionsRead): string[] {
  if (sessions.status === "unreadable") return [];
  return [...new Set(sessions.sessions.map((s) => s.agentId).filter((x): x is string => !!x))];
}

export function prTurns(sessions: SessionsRead, pr: { headRefName: string; files: { path: string }[] }, loads: Map<string, TurnsLoad>): PrTurnsView {
  if (sessions.status === "unreadable") return { state: "could-not-look", note: `Could not look for this PR's agents: ${sessions.reason}` };
  const ids = prAgentIds(sessions);
  if (!ids.length) {
    const why =
      sessions.registry.status === "unreadable"
        ? `AnviDeck's agent registry could not be read (${sessions.registry.reason ?? "no reason given"}), so whether one of this PR's sessions is an AnviDeck agent is not known.`
        : sessions.sessions.length
          ? `None of this PR's ${sessions.sessions.length} session(s) is an AnviDeck agent, and only AnviDeck agents have turns recorded.`
          : "No agent session was found for this PR, so there are no turns to show.";
    const partial = sessions.status === "partial" ? ` The search for its sessions was partial (${sessions.errors.join("; ")}), so one may be missing.` : "";
    return { state: "no-agent", note: why + partial };
  }
  const inPr = new Set(pr.files.map((f) => f.path));
  return { state: "agents", agents: ids.map((id) => agentTurns(id, loads.get(id) ?? { state: "loading" }, pr.headRefName, inPr)) };
}

function agentTurns(agentId: string, load: TurnsLoad, branch: string, inPr: Set<string>): PrTurnsAgent {
  const base = { agentId, notes: [] as string[], turns: [] as PrTurn[], otherBranch: 0, unchanged: 0 };
  if (load.state === "loading") return { ...base, state: "loading", notes: ["reading its checkpoints…"] };
  if (load.state === "error") {
    if (load.status === 503) return { ...base, state: "off", notes: [`This AnviDeck server takes no checkpoints, so it cannot read the agent's turn record (${load.error}).`] };
    return { ...base, state: "unreadable", notes: [`Could not read its checkpoints: ${load.error}`] };
  }
  const d = load.data;
  const notes: string[] = [];
  if (d.unreadable) notes.push(`${d.unreadable} line${d.unreadable === 1 ? "" : "s"} of its record could not be read, so a turn may be missing.`);
  const checkpoints = d.records.filter((r): r is CheckpointEntry => r.kind === "checkpoint");
  for (const f of d.records) if (f.kind === "checkpoint-failed") notes.push(`No checkpoint at ${f.at} (${f.when}, run ${f.run}): ${f.reason}. Its changes are counted in the next checkpoint.`);
  if (!checkpoints.length)
    return { ...base, state: "no-record", notes: [...notes, "No checkpoint is recorded for this agent: it ran before AnviDeck took checkpoints per turn (#248), so which turn changed what is not known. This is not \"no changes\"."] };
  if (d.prefix === null)
    return { ...base, state: "paths-unknown", notes: [...notes, `Its folder ${d.cwd} could not be placed in a git checkout, so its turns' files cannot be matched to the PR's.`] };
  const out: PrTurnsAgent = { ...base, state: "listed", notes };
  for (const c of checkpoints) {
    if (c.head?.branch && c.head.branch !== branch) {
      out.otherBranch++;
      continue;
    }
    if (!c.changeCount) {
      if (c.n > 1) out.unchanged++;
      continue;
    }
    out.turns.push({
      agentId,
      n: c.n,
      at: c.at,
      when: c.when,
      label: label(c),
      branch: c.head?.branch ?? null,
      files: c.changes.map((f) => {
        const path = d.prefix + f.path;
        return { ...f, path, inPr: inPr.has(path) };
      }),
      changeCount: c.changeCount,
      notKept: Math.max(0, c.changeCount - c.changes.length),
      mayIncludeNext: !!c.mayIncludeNext,
    });
  }
  if (out.otherBranch) notes.push(`${out.otherBranch} checkpoint${out.otherBranch === 1 ? " was" : "s were"} taken on another branch than ${branch}, so ${out.otherBranch === 1 ? "it is" : "they are"} not this PR's and not shown.`);
  return out;
}

export type FileTurns =
  | { kind: "no-agent" }
  /** Turns that changed the file, oldest first; `gaps` are what could still be missing. */
  | { kind: "turns"; turns: PrTurn[]; gaps: string[] }
  /** Every agent's record was read and no turn changed the file; `gaps` as above. */
  | { kind: "none-recorded"; gaps: string[] }
  | { kind: "not-known"; why: string };

/** Which recorded turns changed one of the PR's files, and what could still be missing. */
export function turnsForFile(view: PrTurnsView, path: string): FileTurns {
  if (view.state === "no-agent") return { kind: "no-agent" };
  if (view.state === "could-not-look") return { kind: "not-known", why: view.note };
  const gaps: string[] = [];
  const turns: PrTurn[] = [];
  let listed = 0;
  for (const a of view.agents) {
    if (a.state === "loading") return { kind: "not-known", why: "reading the agents' checkpoints…" };
    if (a.state !== "listed") {
      gaps.push(`agent ${a.agentId}: ${a.notes[a.notes.length - 1]}`);
      continue;
    }
    listed++;
    for (const t of a.turns) {
      if (t.files.some((f) => f.path === path)) turns.push(t);
      else if (t.notKept) gaps.push(`turn #${t.n} of agent ${a.agentId} changed ${t.notKept} more file${t.notKept === 1 ? "" : "s"} than its record kept, which may include this one`);
    }
  }
  if (!listed) return { kind: "not-known", why: gaps.join("; ") };
  turns.sort((a, b) => a.at.localeCompare(b.at));
  return turns.length ? { kind: "turns", turns, gaps } : { kind: "none-recorded", gaps };
}

/** One line for a file's diff: which turns changed it, or why that is not known. */
export function fileTurnsLine(t: FileTurns): string | null {
  if (t.kind === "no-agent") return null;
  if (t.kind === "not-known") return `Which turn changed this file is not known: ${t.why}`;
  const gaps = t.gaps.length ? ` Not complete: ${t.gaps.join("; ")}.` : "";
  if (t.kind === "none-recorded") return `No recorded turn changed this file: it may have been changed outside the agents' folders (another checkout, a push to the branch).${gaps}`;
  return `Changed in ${t.turns.map((x) => `#${x.n} (${x.label}, agent ${x.agentId})`).join(", ")}.${gaps}`;
}
