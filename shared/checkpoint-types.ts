/**
 * Checkpoints per agent turn (#248): what each turn changed in the agent's folder, and Undo.
 * Shared by the server (server/agents/checkpoints.ts, server/agents/host.ts) and the Agents screen.
 *
 * Two parts, kept apart on purpose (the owner's decision on #248):
 * - The record (this file's shapes) is `turns/<agent>.jsonl` in AnviDeck's own folder in the store,
 *   backed up with the action log: which files each turn changed, and every Undo.
 * - The snapshots are a git repository per agent in `checkpoints/`, which ignores itself
 *   (`checkpoints/.gitignore` is `*`), so they stay on this machine and are never committed.
 */

/** When a checkpoint is taken. Each one's changes are counted from the checkpoint before it. */
export type CheckpointWhen =
  /** Before a run starts (start or resume): changes since the last one were made outside the agent. */
  | "before-run"
  /** When Claude Code reports a turn's result. */
  | "after-turn"
  /** A run that ended without a result for its last turn (stopped, failed). */
  | "run-ended"
  /** Just before an Undo: anything changed since the last checkpoint, kept so the Undo can be undone. */
  | "before-undo"
  /** Just after an Undo: its changes are what the Undo did. */
  | "after-undo";

export interface FileChange {
  path: string;
  /** A added, M modified, D deleted, T type changed (e.g. file to symlink). */
  status: "A" | "M" | "D" | "T";
  /** Lines added and removed; null for a binary file. */
  added: number | null;
  removed: number | null;
}

/** At most this many changed files are kept per checkpoint in the record; changeCount says how many there were. */
export const FILES_KEPT = 200;

export interface CheckpointEntry {
  kind: "checkpoint";
  /** 1, 2, 3… for this agent, never reused (not even after Clear). */
  n: number;
  at: string;
  when: CheckpointWhen;
  /** Which run of the agent (1 = its start, 2 = its first resume…). */
  run: number;
  /** The snapshot: a git tree in the agent's checkpoint repository. */
  tree: string;
  /** The folder's branch and commit at that moment; null when the folder is not in a git checkout. */
  head: { sha: string; branch: string | null } | null;
  /** Changes since the checkpoint before it (none before the first). At most FILES_KEPT. */
  changes: FileChange[];
  changeCount: number;
  /** For after-turn: a message started the next turn before this snapshot finished, so it may hold the start of that turn. */
  mayIncludeNext?: boolean;
  /** For run-ended: why the run ended. */
  reason?: string;
  /** For after-undo: the checkpoint the folder was put back to. */
  undoTo?: number;
}

export interface CheckpointFailedEntry {
  kind: "checkpoint-failed";
  at: string;
  when: CheckpointWhen;
  run: number;
  reason: string;
}

export interface ClearedEntry {
  kind: "cleared";
  at: string;
  reason: string;
}

export type TurnRecordLine = CheckpointEntry | CheckpointFailedEntry | ClearedEntry;

/** GET /api/agents/:id/checkpoints */
export interface CheckpointsAnswer {
  agentId: string;
  cwd: string;
  records: TurnRecordLine[];
  /** Lines of the record that could not be read (not JSON): counted, never dropped silently. */
  unreadable: number;
  /** The checkpoints that can still be undone to: their snapshots are on this machine. */
  undoable: number[];
  /** Whether Undo can be pressed now, and if not why. */
  undo: { ok: true; warnings: string[] } | { ok: false; why: string };
  /** The agent's folder no longer exists: its snapshots can be cleared. */
  folderGone: boolean;
  /** Snapshots are kept for this agent on this machine. */
  kept: boolean;
  /**
   * The agent's folder inside its git checkout, as `git rev-parse --show-prefix` says ("" at the
   * checkout's top, else "sub/dir/"). Each change's path is relative to the agent's folder; this
   * puts it in the repository's terms, as a PR names its files (#275). Null when the folder is
   * gone, is not in a git checkout, or git could not say: then the paths cannot be joined to a PR's.
   */
  prefix: string | null;
}

/** GET /api/agents/:id/checkpoints/:n/undo: what pressing Undo would do, read just now. */
export interface UndoPlan {
  agentId: string;
  cwd: string;
  to: number;
  toAt: string;
  toWhen: CheckpointWhen;
  /** The folder as it is now (a tree); the press sends it back, and is refused if the folder has changed since. */
  current: string;
  /** What Undo would discard: the changes from the checkpoint to now. At most FILES_KEPT. */
  discarded: FileChange[];
  discardedCount: number;
  /** The branch then and now: Undo puts files back, never the branch or its commits. */
  head: { then: CheckpointEntry["head"]; now: CheckpointEntry["head"] };
  /** Sessions or agents working in a folder above this one: allowed, but they could edit here. */
  warnings: string[];
}

export interface UndoAnswer {
  agentId: string;
  /** The checkpoint taken just before, so this Undo can itself be undone. */
  before: number;
  /** The checkpoint recording what the Undo did. */
  after: number;
  to: number;
  changeCount: number;
}
