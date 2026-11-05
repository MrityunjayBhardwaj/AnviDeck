/**
 * Refusals by the design guard, and your calls on them (#86).
 *
 * The refusals come from anvi's own instrument, ~/.claude/anvi/scripts/structure-refusals.js, run
 * by server/readers/refusals.ts. Your calls ("right" / "wrong", with a note) are lines in
 * calls.jsonl in AnviDeck's own folder (beside actions.jsonl), written by server/calls.ts and read
 * by server/readers/calls.ts. Design, Code and History reuse both.
 */

/** Who refused the edit, as the instrument tells them apart. */
export type RefusedBy = "graph rule" | "project's own check";

/** One edit the guard refused, with the instrument's fields and the guard's verbatim reason. */
export interface Refusal {
  /**
   * The stable key a call is recorded under: the refused tool call's tool_use id. One id names
   * one blocked edit: a subagent's transcript carries its parent's session id, and a resumed or
   * forked transcript repeats earlier records, so the session id adds nothing that tells two
   * refusals apart.
   */
  key: string;
  at: string;
  session: string;
  tool: string;
  /** The file, relative to the package. */
  file: string;
  /** registered · worktree · gone (the checkout no longer exists). */
  checkout: string;
  checkoutDir: string;
  /** Claude Code version that recorded it. */
  version: string | null;
  transcript: string;
  refusedBy: RefusedBy;
  /** The graph rule refused it and the project's own check refused it too. */
  checkToo: boolean;
  /** The design version the refusal names (`judged under design <id>`), or null before refusals named one. */
  design: string | null;
  /** Each violation line: rule (divergence · layer · cycle) and file -> file. */
  violations: { rule: string; key: string }[];
  /** Each refused import with its component pair ("engine -> monaco"). */
  pairs: { key: string; pair: string }[];
  /** The guard's words, verbatim, as the agent read them. Null when they could not be re-read (see reasonError). */
  reason: string | null;
  reasonError?: string;
  /** Your call on it (latest, with earlier ones), or null when none is recorded. Unknown when calls.status is unreadable. */
  call: CallState | null;
}

/** An edit that landed with no judgement, or was denied in a shape the instrument does not know. */
export interface RefusalEdit {
  key: string;
  at: string;
  session: string;
  tool: string;
  file: string;
  outcome: string;
  reason?: string | null;
}

/** How the instrument was run: its name, identity, arguments and when. */
export interface RefusalInstrument {
  name: "structure-refusals.js";
  path: string;
  sha256: string;
  mtime: string;
  args: string[];
  ranAt: string;
  ms: number;
  /** The instrument's exit code, and what it means by its own header. */
  exit: number | null;
  exitMeaning: string;
}

export interface RefusalTotals {
  /** Write/Edit/MultiEdit calls on the package in the window: the population every count is out of. */
  edits: number;
  sessions: number;
  applied: number;
  refused: number;
  refusedByCheckAlone: number;
  deniedOtherwise: number;
  erroredOtherwise: number;
  noResult: number;
  timedOut: number;
  cancelled: number;
  unrecognised: number;
}

export interface RefusalCache {
  /** When this answer was measured. */
  at: string;
  ageMs: number;
  /** A newer run has started; this answer is served until it finishes. */
  refreshing: boolean;
  /** Answers older than this are measured again on the next request. */
  ttlMs: number;
}

export interface RefusalWindow {
  since: string;
  until: string | null;
  /** "?since" when asked, else the default window. */
  chosenBy: string;
}

interface Base {
  project: string;
}

export interface RefusalsMeasured extends Base {
  status: "measured";
  package: string;
  window: RefusalWindow;
  instrument: RefusalInstrument;
  transcripts: { read: number; unreadable: number; badLines: number };
  totals: RefusalTotals;
  /** Notices the guard said without refusing, by kind; every kind the instrument knows is listed, zero included. */
  notices: Record<string, number>;
  refusals: Refusal[];
  timeouts: RefusalEdit[];
  unrecognised: RefusalEdit[];
  /** The instrument's exposure section (chances to refuse), as it wrote it; null when it computed none. */
  exposure: Record<string, unknown> | null;
  defaultBranch: Record<string, unknown> | null;
  byDesign: unknown[];
  /** The instrument's own last reading line ("TRIAL READING: …"), verbatim. */
  trialReading: string | null;
  /** The instrument's whole text report, verbatim. */
  report: string;
  cache: RefusalCache;
  /** Where your calls were read from, and whether they could be (read at answer time, not cached). */
  calls: Omit<CallsRead, "calls" | "byKey">;
}

/** The instrument ran and said it could not measure (no edit in the window, no transcripts…). */
export interface RefusalsNotMeasured extends Base {
  status: "not-measured";
  package?: string;
  window?: RefusalWindow;
  instrument?: RefusalInstrument;
  reason: string;
  report?: string;
  cache?: RefusalCache;
}

/** The project has no package registered with the structure guard: nothing is refused there. */
export interface RefusalsNoDesign extends Base {
  status: "no-design";
  reason: string;
}

/** A run is under way and no earlier answer is kept. Ask again. */
export interface RefusalsMeasuring extends Base {
  status: "measuring";
  package: string;
  window: RefusalWindow;
  startedAt: string;
}

/** The instrument could not be run, or its output could not be read. */
export interface RefusalsUnreadable extends Base {
  status: "unreadable";
  package?: string;
  window?: RefusalWindow;
  instrument?: Partial<RefusalInstrument>;
  reason: string;
  cache?: RefusalCache;
}

export type RefusalsResponse = RefusalsMeasured | RefusalsNotMeasured | RefusalsNoDesign | RefusalsMeasuring | RefusalsUnreadable;

// ── your calls ─────────────────────────────────────────────────────────────────────────────

export type CallVerdict = "right" | "wrong";

/** One line of calls.jsonl: your call on one refusal, at one time. */
export interface CallRecord {
  at: string;
  /** The refusal's key (its tool_use id). */
  key: string;
  project: string;
  call: CallVerdict;
  note?: string;
  /** What the page showed when you made the call, so the record says what it was about. */
  refusal?: { session?: string; tool?: string; file?: string; at?: string };
}

/** The latest call on one refusal, with the earlier ones kept as history (oldest first). */
export interface CallState {
  latest: CallRecord;
  earlier: CallRecord[];
}

export interface CallsRead {
  file: string;
  /** false when no call has been recorded yet: "no file" is not "unreadable". */
  exists: boolean;
  status: "ok" | "none" | "partial" | "unreadable";
  /** Set when the file exists but could not be read at all. */
  error?: string;
  /** Non-empty lines in the file (the population). */
  lines: number;
  /** Lines that were not a call (torn or damaged): counted, never dropped silently. */
  unreadableLines: number;
  /** Every call read, in the order recorded (filtered by ?project / ?key when asked). */
  calls: CallRecord[];
  /** By refusal key. */
  byKey: Record<string, CallState>;
  readAt: string;
}
