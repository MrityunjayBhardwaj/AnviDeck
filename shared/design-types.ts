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

/**
 * One hook registered on PreToolUse for the edit tools. Claude Code starts every matching hook
 * at once (its hooks reference: "all matching hooks run in parallel"), so the list's order says
 * nothing about when a hook runs.
 */
export interface EditHook {
  matcher: string;
  /** The script's file name ("structure-guard-hook.js"), or the command when no script is named. */
  name: string;
  command: string;
  /** The settings file it is registered in. */
  file: string;
}

/** A settings file Claude Code loads hooks from, and what reading it gave. */
export interface HookSettingsFile {
  scope: "user" | "project" | "project-local" | "managed";
  file: string;
  /** read: parsed (it may hold no hook); absent: no such file; unreadable: could not be read or located. */
  status: "read" | "absent" | "unreadable";
  reason?: string;
}

/**
 * The edit hooks found in the settings files this reader reads. Claude Code also loads hooks from
 * places not read here (named in `notRead`), so a hook that is not found is "not found here",
 * never "not running".
 */
export interface EditHooksAnswer {
  readAt: string;
  files: HookSettingsFile[];
  hooks: EditHook[];
  notRead: string;
}
