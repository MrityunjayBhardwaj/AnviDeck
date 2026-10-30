// Home (issue #18): one decision queue, one count, a one-line status, the agents.
//
// Every row and every metric names where it came from (`source`). A source that could
// not be read says so (`could-not-read`) and is never shown as "nothing to decide".

/** How a source answered. `none` = read fine, nothing there. */
export type HomeSourceStatus = "ok" | "none" | "partial" | "could-not-read" | "not-measured";

export interface HomeSource {
  status: HomeSourceStatus;
  /** Plain words: what was read, e.g. "~/.claude/sessions (13 live)". */
  label: string;
  detail?: string;
}

export type QueueKind = "agent-waiting" | "rule-break" | "pr-review";

/** One thing that needs a decision. Deep links only: AnviDeck acts on nothing. */
export interface QueueItem {
  kind: QueueKind;
  /** Stable key, e.g. "pr:owner/repo#12". */
  id: string;
  what: string;
  why: string;
  /** A recorded deadline, or null. Nothing in the data records deadlines today. */
  dueBy: string | null;
  /** Epoch ms the thing started waiting, used for ordering (oldest first within a kind). */
  since: number | null;
  /** The one action: open a URL, or copy a command (e.g. `cd <worktree>`). */
  action: { label: string; href?: string; copy?: string };
  /** Where this row came from, in plain words. */
  source: string;
}

/** A row that could not be checked: shown apart from the queue and never counted in it. */
export interface UnreadItem {
  id: string;
  what: string;
  source: string;
}

export type MetricState = "ok" | "warn" | "bad" | "unknown";

export interface HomeMetric {
  id: "new-breaks" | "allowed-breaks" | "notes" | "sources";
  label: string;
  state: MetricState;
  value: string;
  /** One sentence of context. */
  note: string;
  source: string;
}

export interface HomeAgent {
  sessionId: string;
  name: string;
  project: string;
  cwd: string;
  branch: string | null;
  status: string;
  waitingFor?: string;
  updatedAt: number;
  /** Open PRs this session linked (numbers only), when read. */
  openPrs: number[];
}

export interface HomeResponse {
  generatedAt: string;
  queue: QueueItem[];
  unread: UnreadItem[];
  metrics: HomeMetric[];
  agents: HomeAgent[];
  sources: {
    sessions: HomeSource;
    prs: HomeSource;
    structure: HomeSource;
    notes: HomeSource;
  };
  timings: Record<string, number>;
}
