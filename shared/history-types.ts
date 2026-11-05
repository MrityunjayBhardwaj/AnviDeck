/**
 * History (#90): one project's timeline. Every kind of event comes from one source, named in its
 * lane, and a lane that could not be read says so instead of reading as an empty one.
 *
 *   turn       a prompt that started an agent turn       session transcripts (~/.claude/projects)
 *   edit       an Edit / Write / MultiEdit / NotebookEdit session transcripts
 *   refusal    an edit the design guard refused          anvi's structure-refusals.js (GET /api/refusals)
 *   ruling     your call on a refusal (right / wrong)    calls.jsonl in AnviDeck's own folder (GET /api/calls)
 *   commit     a commit on the default branch            git log of the project's repository
 *   catalogue  a commit that changed a catalogue         git log of the catalogue folder's repository
 *   action     a write AnviDeck was asked to make        actions.jsonl (GET /api/actions)
 */

export const HISTORY_KINDS = ["turn", "edit", "refusal", "ruling", "commit", "catalogue", "action"] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

interface EventBase {
  kind: HistoryKind;
  /** UTC ISO time the event happened (see each lane's source for which time that is). */
  at: string;
  /** Unique within its kind. */
  id: string;
}

export interface TurnEvent extends EventBase {
  kind: "turn";
  session: string;
  /** The prompt's first words (at most PROMPT_CHARS); the full text is in the replay. */
  prompt: string;
  /** Who wrote the prompt, as the transcript records it ("human", "agent host"…), when it does. */
  origin: string | null;
}

export interface EditEvent extends EventBase {
  kind: "edit";
  session: string;
  tool: string;
  file: string;
}

export interface RefusalEvent extends EventBase {
  kind: "refusal";
  session: string;
  tool: string;
  file: string;
  pairs: string[];
  refusedBy: string;
  reason: string | null;
  design: string | null;
  /** Your call on it, as the refusals reader read it. */
  call: { state: "none" } | { state: "unknown"; reason: string } | { state: "called"; call: "right" | "wrong"; at: string; note?: string; earlier: number };
}

export interface RulingEvent extends EventBase {
  kind: "ruling";
  /** The refusal's key (its tool_use id). */
  key: string;
  call: "right" | "wrong";
  note?: string;
  /** What the page showed when the call was made. */
  refusal?: { session?: string; tool?: string; file?: string; at?: string };
  /** A later call on the same refusal replaced this one. */
  superseded: boolean;
}

export interface CommitEvent extends EventBase {
  kind: "commit";
  sha: string;
  subject: string;
  author: string;
}

export interface CatalogueEvent extends EventBase {
  kind: "catalogue";
  sha: string;
  subject: string;
  /** Catalogue files the commit changed, relative to the catalogue folder, with git's status letter. */
  files: { status: string; file: string }[];
}

export interface ActionEvent extends EventBase {
  kind: "action";
  method: string;
  path: string;
  result: string;
  status: number;
  reason?: string;
  target?: string;
}

export type HistoryEvent = TurnEvent | EditEvent | RefusalEvent | RulingEvent | CommitEvent | CatalogueEvent | ActionEvent;

/**
 * How one lane was read.
 *   ok / none      read whole; none = nothing in the window
 *   partial        read, but some of it could not be (detail says what)
 *   unreadable     could not be read at all
 *   measuring      the source is still running (refusals); ask again
 *   not-available  this project has no such source (detail says why) — never "none"
 */
export type LaneStatus = "ok" | "none" | "partial" | "unreadable" | "measuring" | "not-available";

export interface LaneRead {
  kind: HistoryKind;
  status: LaneStatus;
  /** Where the events come from, in words a person can check. */
  source: string;
  detail?: string;
  /** Events of this kind in the window (the population). */
  total: number;
  /** Events of this kind sent in `events` (at most the cap). */
  shown: number;
  /** Events per local day ("YYYY-MM-DD" → n), counted over all `total`, not only those shown. */
  perDay: Record<string, number>;
}

export interface HistoryWindow {
  since: string;
  until: string;
  /** Minutes east of UTC the days are counted in (the page's own time zone). */
  tzMinutes: number;
}

export interface HistoryResponse {
  project: string;
  path: string;
  window: HistoryWindow;
  readAt: string;
  ms: number;
  /** At most this many events per kind are sent; the newest are kept. */
  cap: number;
  lanes: Record<HistoryKind, LaneRead>;
  /** Sorted by time, oldest first. */
  events: HistoryEvent[];
  /** Sessions with at least one turn or edit in the window: what "Replay a session" offers. */
  sessions: { id: string; first: string; last: string; turns: number; edits: number; cwd: string | null }[];
}

// ── compare two points ─────────────────────────────────────────────────────────────────────

export type Side<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface CodeCompare {
  repo: string;
  ref: string;
  refWhy: string;
  a: { at: string; sha: string; date: string; subject: string } | null;
  b: { at: string; sha: string; date: string; subject: string } | null;
  /** Commits in a..b on the ref. */
  commits: number;
  /** git diff --shortstat a b, verbatim. */
  shortstat: string;
  files: { file: string; added: number | null; deleted: number | null }[];
  filesTotal: number;
}

export interface KnowledgeFileCompare {
  file: string;
  /** Entries parsed at each point (null: the file did not exist then). */
  before: number | null;
  after: number | null;
  added: string[];
  removed: string[];
  changed: string[];
}

export interface KnowledgeCompare {
  repo: string;
  dir: string;
  a: { at: string; sha: string; date: string } | null;
  b: { at: string; sha: string; date: string } | null;
  /** Commits that changed the catalogue folder between the two. */
  commits: number;
  files: KnowledgeFileCompare[];
}

export interface CompareResponse {
  project: string;
  a: string;
  b: string;
  code: Side<CodeCompare>;
  knowledge: Side<KnowledgeCompare>;
}
