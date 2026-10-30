/**
 * Replay types — what one agent did in a time window, what anvi told it, and
 * what it changed (issue #15).
 *
 * Every piece carries how we know it. Two rules shape these types:
 *   - "could not read" is never reported as "nothing found": every source has
 *     a status, and an empty list is only meaningful next to status "none".
 *   - All times are ISO 8601 in UTC; the response says so in `timezone`.
 */

/** Where a step came from. */
export type StepSource =
  | "transcript" // a record in the Claude Code transcript (.jsonl)
  | "hook-meter" // a row in anvi's hook meter (~/.claude/anvi-meter/<sid>.jsonl)
  | "hook-log" // a row in the live hook log (/tmp/anvi-hook-<sid>.log)
  | "commit" // a git commit, attributed to this session by time
  | "guessed"; // inferred, not observed (e.g. "this shell command edits files")

/**
 * The state of one source after we tried to read it.
 *   ok          read, and it had something in the window
 *   none        read, and it had nothing in the window (nothing found)
 *   not-found   the file/dir does not exist (could not read)
 *   unreadable  exists but reading or parsing failed (could not read)
 *   skipped     not attempted (e.g. caller turned it off)
 */
export type ReadStatus = "ok" | "none" | "not-found" | "unreadable" | "skipped";

export interface SourceStatus {
  status: ReadStatus;
  path?: string;
  detail?: string;
  /** Rows/records read from the source in the window. */
  count?: number;
}

export type StepKind = "tool" | "injection" | "hook-run" | "commit" | "pr";

export interface ReplayStep {
  /** Order in the replay (0-based), after sorting by placed time then file line. */
  seq: number;
  /** The record's own timestamp, or null if it had none. */
  ts: string | null;
  /**
   * How the step got its place in time:
   *   timestamp  its own `ts`
   *   neighbour  no timestamp; placed at `placedAt`, the previous timed record's
   *              time in file order (the next one if nothing precedes it)
   */
  placement: "timestamp" | "neighbour";
  placedAt: string;
  kind: StepKind;
  source: StepSource;
  /** 1-based line in the transcript, when the step came from it. */
  line?: number;
  tool?: string;
  toolUseId?: string;
  filePath?: string;
  command?: string;
  hookName?: string;
  /** For kind "commit": sha and subject. For kind "pr": number and repo. */
  sha?: string;
  subject?: string;
  pr?: number;
  repo?: string;
  /**
   * A guess, labelled as one: the command text looks like it writes files
   * (e.g. `git mv`, `sed -i`, a python `open(...,'w')`). `reason` names the match.
   */
  /**
   * A guess that this shell command writes files. `scope` says where: "project"
   * (possibly a code change), "scratch" (temp/scratchpad only) or "link" (only
   * creates links). Only "project" should be shown as a possible code change.
   */
  mayEditFiles?: { source: "guessed"; reason: string; scope: "project" | "scratch" | "link" };
  /** Injections attached to this tool call (by toolUseID). */
  noteIds?: number[];
  /** Extra detail for hook-meter / hook-log steps. */
  detail?: Record<string, unknown>;
}

/** One file that changed, and how we know. */
export interface ChangedFile {
  path: string;
  /**
   * Every way we know it changed: "tool" = an Edit/Write call in the
   * transcript; "commit" = an attributed git commit; "pr" = `gh pr view` files.
   */
  how: ("tool" | "commit" | "pr")[];
  status?: string; // git name-status letter (M, A, D, R099…) when from git
  /** For a rename or copy (R…/C…): the path it came from, repo-relative. */
  oldPath?: string;
  additions?: number;
  deletions?: number;
  sha?: string;
  pr?: number;
  /**
   * Only via shell/commit: no Edit/Write tool call on this file (same repository
   * store and repo-relative path, at or before the commit, anywhere in the session).
   */
  viaShell: boolean;
  /** The tool edit that matched when it named the file by another path or fell before the window. */
  toolEdit?: { path: string; ts: string; tool: string };
  /**
   * Plain-language labels for the two gaps a shell edit has. Present only when
   * viaShell. Kept as separate facts, never merged into one.
   */
  notesGap?: string; // "no notes given for these files"
  designRules?: string; // "checked at merge, not at edit" (or why not)
}

export interface CommitInfo {
  sha: string;
  committedAt: string; // UTC
  subject: string;
  repoDir: string;
  files: { status: string; path: string; oldPath?: string }[];
  /** The Bash step whose `git commit` this commit was matched to, if any. */
  matchedStepSeq?: number;
}

export interface PrInfo {
  number: number;
  repo: string;
  /** First and last time the transcript linked this PR in the window. */
  firstSeen: string;
  lastSeen: string;
  read: SourceStatus; // gh pr view status
  headRefOid?: string;
  state?: string;
  mergedAt?: string | null;
  changedFiles?: number;
  /** The PR head is a commit made by this session in the window. */
  headCommittedInWindow?: boolean;
  merge?: MergeEvidence;
}

/** How a PR was merged, as far as local evidence shows. */
export interface MergeEvidence {
  /**
   *   claude-session   a session's transcript shows `gh pr merge` for this PR
   *                    shortly before mergedAt, and the merge hook was metered
   *                    in that session (a meter row alone is not enough: the
   *                    hook also runs on unrelated Bash calls)
   *   no-hook-run      merged, but no merge-hook run was metered near mergedAt
   *                    (e.g. merged on the GitHub web page)
   *   not-merged       PR not merged
   *   unknown          could not tell (meter unreadable, or candidate sessions
   *                    whose transcripts are gone or show no merge command)
   */
  how: "claude-session" | "no-hook-run" | "not-merged" | "unknown";
  sessionId?: string;
  hookRunAt?: string;
  /** When the confirming `gh pr merge` command ran (transcript timestamp). */
  commandAt?: string;
  /** Did the merge hook write a judgement row for this PR in merges.jsonl? */
  judgementRow?: "found" | "none" | "could-not-read";
  detail?: string;
}

export interface NoteUsed {
  id: number;
  ts: string | null;
  hookName: string;
  hookEvent?: string;
  toolUseId?: string;
  /** Bytes (UTF-8) of the full text, after loading a persisted file. */
  size: number;
  preview: string;
  /** The full text. Loaded from the persisted file when the inline content was a preview. */
  text?: string;
  persisted?: { path: string; status: ReadStatus };
  /** Matching hook-meter row(s): which anvi hook wrote it, and its byte count. */
  meter?: { hook: string; bytes: number; ts: string }[];
  line: number;
}

export interface ReplaySessionSummary {
  sessionId: string;
  project: string;
  cwd: string | null;
  transcriptPath: string;
  sizeBytes: number;
  modifiedAt: string; // UTC
  firstTs: string | null;
  lastTs: string | null;
}

export interface ReplaySessionsResponse {
  timezone: "UTC";
  project: string;
  status: ReadStatus;
  detail?: string;
  /** Transcript directories searched (encoded cwd dirs matching the project). */
  searched: string[];
  sessions: ReplaySessionSummary[];
}

export interface ReplayResponse {
  timezone: "UTC";
  sessionId: string;
  window: { from: string | null; to: string | null };
  transcript: SourceStatus & {
    records?: number;
    parseErrors?: number;
    /** Records with no timestamp in the whole file. Kept, never dropped. */
    untimedRecords?: number;
    /** Of those, how many were placed (by neighbour) inside the window. */
    untimedInWindow?: number;
    untimedByType?: Record<string, number>;
    retentionDays?: number;
  };
  sources: {
    hookMeter: SourceStatus & { informed?: number; refused?: number; silent?: number };
    hookLog: SourceStatus;
    git: SourceStatus & { dirs?: { dir: string; status: ReadStatus; detail?: string }[] };
    github: SourceStatus;
  };
  steps: ReplayStep[];
  notes: { status: ReadStatus; detail?: string; items: NoteUsed[] };
  changes: { status: ReadStatus; detail?: string; files: ChangedFile[] };
  commits: CommitInfo[];
  /** In-window commits in the same repos that no `git commit` step of this session matches. */
  unattributedCommits: CommitInfo[];
  prs: PrInfo[];
  timingsMs: Record<string, number>;
}
