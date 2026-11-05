/**
 * The Notes screen's own answers (#89): anvi's currency verdicts, the fleet snapshots' series
 * for one project, and how often the injector delivered each entry. The catalogues, memory,
 * Ground Truth docs and routing table come from the existing readers (GET /api/project/:name,
 * /api/project/:name/entry-dates, /api/routing-architecture).
 */

/** One entry's verdict, exactly as `currency-report.js --json` prints it (fields we use). */
export interface CurrencyEntry {
  catalogue: string;
  id: string;
  /** GREEN fresh · YELLOW drifted · RED dangling · GRAY unknown · REFERENCE · WITHHELD */
  status: string;
  /** verified · drifted · never confirmed · not checked */
  state: string;
  /** Cited files that changed since the entry's anchor. */
  drifted: string[];
  /** Cited files that are gone (RED), when the report names them. */
  gone: string[] | null;
  /** What the verdict is measured from: VALIDATED, FIX-<ref>, TIME@<sha>, none. */
  anchor: string;
  not_checked?: string;
  /** The report graded this entry with a withheld reference area set aside: the verdict covers part of its evidence. */
  partial?: boolean;
}

export interface CurrencyCounts {
  GREEN: number;
  YELLOW: number;
  RED: number;
  GRAY: number;
  REFERENCE: number;
  WITHHELD: number;
}

/**
 * anvi's currency report for one project, run by AnviDeck (read only) or still running.
 *   measuring   the report is running; ask again (startedAt says since when)
 *   ok          the report ran; counts are its own
 *   none        the report says the project has no catalogues (exit 2)
 *   withheld    the report refused to read the catalogues (exit 3); nothing is known
 *   unreadable  the report failed or timed out; nothing is known
 */
export type CurrencyState = "measuring" | "ok" | "none" | "withheld" | "unreadable";

export interface CurrencyAnswer {
  project: string;
  path: string;
  state: CurrencyState;
  /** The exact command run, for the source line. */
  command: string;
  startedAt: string | null;
  /** When the run finished (ok/none/withheld/unreadable). */
  ranAt: string | null;
  /** Why it could not answer (none/withheld/unreadable), in the report's or the system's words. */
  reason?: string;
  examined?: number;
  counts?: CurrencyCounts;
  /** The report's freshness line: verified, drifted, never confirmed, not checked (of its primaries). */
  states?: Record<string, number>;
  entries?: CurrencyEntry[];
  /**
   * How many verdicts the report graded with a withheld area set aside (its top-level `partial`),
   * and which reference areas it was refused (`withheld_kinds`). Either non-zero means the counts
   * are over less than the project holds; the screen says so beside them.
   */
  partial?: number;
  withheldKinds?: string[];
  /** A newer run is going; this answer is the last finished one. */
  measuringAgain?: boolean;
}

/** One fleet health snapshot's figures for one project (health-<date>.json, dates UTC). */
export interface SnapshotPoint {
  date: string;
  file: string;
  examined: number;
  yellow: number;
  red: number;
}

export interface SnapshotSeries {
  /** The key the snapshots use for this project (the store folder name). */
  key: string;
  dir: string;
  /** ok: read; none: no snapshot directory or no snapshot names the project; unreadable/partial: some could not be read. */
  status: "ok" | "none" | "partial" | "unreadable";
  points: SnapshotPoint[];
  /** Snapshots that exist but do not measure this project (named as not measured, or absent from it). */
  notMeasuredIn: string[];
  errors: string[];
}

/** How often the catalogue-context injector delivered an entry, from /tmp/anvi-hook-<sid>.log. */
export interface UsageAnswer {
  project: string;
  /** The window asked for: start (ISO) and length. */
  since: string;
  days: number;
  /**
   * Where the logs actually reach back to inside that window: the oldest log line read (or a
   * log untouched since before the window, which reaches it all), never earlier than `since`.
   * null when no log line was read at all. /tmp is cleared, so this is often days, not `days`.
   */
  coveredFrom: string | null;
  /** ok: logs read; none: no hook logs at all; partial/unreadable: some could not be read. */
  status: "ok" | "none" | "partial" | "unreadable";
  errors: string[];
  /** Log files read, and of them the ones whose session is this project's. */
  logsRead: number;
  sessions: number;
  /** Injector firings (edits) in the window for this project's sessions. */
  edits: number;
  /** Entry deliveries per kind: patterns → hetvabhasa, invariants → vyapti, boundaries → dharana. */
  delivered: { hetvabhasa: number; vyapti: number; dharana: number };
  /** Deliveries per "catalogue/ID". */
  uses: Record<string, number>;
  /** Log lines that were not JSON. */
  malformed: number;
}

/** One Ground Truth doc as anvi's gt-citation-check.js --json measures it (preamble not counted). */
export interface GtDocCheck {
  doc: string;
  system: string;
  sections: number;
  cited: number;
  uncitable: number;
  missing: number;
  citations: number;
}

/**
 * anvi's Ground Truth citation check for a project's ref folder.
 *   ok           every section cites code or says why it cannot (exit 0)
 *   missing      some section does neither (exit 1); docs still measured
 *   none         no ref folder for the project
 *   not-measured the check could not read a doc or found none (exit 2), or failed
 */
export interface GtCheckAnswer {
  state: "ok" | "missing" | "none" | "not-measured";
  command: string | null;
  refDir: string | null;
  ranAt: string;
  reason?: string;
  docs: GtDocCheck[];
}
