/**
 * The Agents screen (#82): what GET /api/agents-screen/session/:sid answers, and the shapes
 * the screen's model (ui/components/agents-model.ts) reads.
 *
 * One Claude Code session, from three files that each say how they were read:
 *   - its transcript   ~/.claude/projects/<encoded cwd>/<sid>.jsonl (Claude Code writes it for
 *                      terminal sessions and for sessions AnviDeck started through the SDK alike)
 *   - anvi's hook meter ~/.claude/anvi-meter/<sid>.jsonl   (one row per hook run: outcome, bytes)
 *   - the live hook log /tmp/anvi-hook-<sid>.log           (what the context injector matched)
 *
 * "Could not read" is never "nothing found": every source carries a status, and an empty list
 * means nothing only next to status "none".
 */

/**
 *   ok          read, and it had rows
 *   none        read, and it had no rows (nothing found)
 *   not-found   the file does not exist (could not read)
 *   unreadable  it exists but reading failed (could not read)
 *   partial     read, but some lines could not be parsed (`skippedLines` says how many)
 */
export type SourceState = "ok" | "none" | "not-found" | "unreadable" | "partial";

export interface SourceRead {
  status: SourceState;
  path: string;
  /** Why it could not be read, or what "not-found" means for this file. */
  detail?: string;
  /** Rows in this answer (after filtering to what the screen uses, and to the window sent). */
  count: number;
  /** Rows the source holds in all (when only the newest are sent, `count` < `total`). */
  total?: number;
  /** Hook rows left out because they are older than the oldest transcript record sent. */
  beforeWindow?: number;
  /** Lines that were not JSON (a torn last line while the session writes, or damage). */
  skippedLines: number;
  /** When the file was last changed (UTC), when it could be read. */
  modifiedAt?: string;
}

/**
 * One transcript record the screen uses, as Claude Code wrote it, trimmed:
 * assistant and user messages (thinking blocks dropped, long tool results cut and marked), and
 * hook attachments (hook_additional_context, hook_success, hook_non_blocking_error,
 * hook_cancelled, and any other hook_* type, kept as written).
 */
export interface CliRecord {
  /** The record's own timestamp (UTC), or null when it had none. */
  at: string | null;
  /** 1-based line in the transcript file. */
  line: number;
  type: "assistant" | "user" | "attachment";
  message?: { role?: string; content?: unknown };
  attachment?: Record<string, unknown>;
}

/** A row of anvi's hook meter: one hook run. */
export interface MeterRow {
  ts: string;
  hook: string;
  event: string;
  bytes: number;
  ms?: number;
  outcome: string;
  why?: string;
}

/** A row of the live hook log: what the context injector matched for one file. */
export interface HookLogRow {
  ts: string;
  file: string;
  boundaries: string[];
  fatality: boolean;
  patterns: string[];
  invariants: string[];
}

export interface AgentSessionResponse {
  timezone: "UTC";
  sessionId: string;
  /** When this answer was read (UTC). */
  readAt: string;
  transcript: SourceRead & { records: CliRecord[]; cwd?: string };
  meter: SourceRead & { rows: MeterRow[] };
  hookLog: SourceRead & { rows: HookLogRow[] };
}

/** Tool results longer than this are cut in the answer (the cut is marked, never silent). */
export const TOOL_RESULT_MAX_CHARS = 2000;
