/**
 * Types for the Design screen's own reads (#87), mounted at /api/design. The lenses also use
 * GET /api/structure/:project (the guard's graph and verdicts), GET /api/refusals (the trial
 * record) and GET /api/project/:name (the catalogue's boundaries); those types live beside
 * their readers.
 *
 * Every answer carries a status, so "could not measure" is never shaped like "nothing found".
 */

/** One fix commit that touched both sides of a component pair. */
export interface FixPoint {
  sha: string;
  /** Author date, ISO with offset, as git prints it. */
  date: string;
  subject: string;
  /** Files in the package the commit changed (the cost of the fix). */
  files: number;
}

/** How the files-per-fix series moves, by the rule named in `trendRule`. */
export type Trend = "rising" | "falling" | "flat" | "too few";

export interface PairCost {
  /** "visualizers -> workspace" */
  pair: string;
  /** Rule breaks the guard holds for this pair at the measured commit (its count in byPair). */
  held: number;
  fixes: FixPoint[];
  trend: Trend;
}

export interface FixCostMeasured {
  status: "measured";
  project: string;
  package: string;
  /** The commit the series is read at: the one the guard measured the structure at. */
  at: { ref: string; sha: string; date: string | null };
  /** The predicate, in words: which commits count as fixes and when one is in a pair's concern. */
  predicate: string;
  trendRule: string;
  /** Commits on the package read (the population), and how many of them are fixes. */
  commits: number;
  fixCommits: number;
  /** Files a fix touched that no component of the design maps (not counted toward any pair). */
  unmappedFiles: number;
  pairs: PairCost[];
  command: string;
  ms: number;
}

export interface FixCostNotMeasured {
  status: "not-measured" | "unreadable" | "no-design";
  project: string;
  reason: string;
}

export type FixCostAnswer = FixCostMeasured | FixCostNotMeasured;

/** One hook registered on PreToolUse for the edit tools, in the order Claude Code runs them. */
export interface EditHook {
  matcher: string;
  /** The script's file name ("structure-guard-hook.js"), or the command when no script is named. */
  name: string;
  command: string;
}

export type EditHooksAnswer =
  | { status: "ok"; file: string; readAt: string; hooks: EditHook[] }
  | { status: "none"; file: string; readAt: string; reason: string }
  | { status: "unreadable"; file: string; readAt: string; reason: string };
