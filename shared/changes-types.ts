/**
 * The Changes screen (#84): what GET /api/changes/* answers.
 *
 * Every part carries its own read status, so "could not look" never has the shape of
 * "nothing there": a PR whose agent session could not be searched for is `unreadable`,
 * never an empty list of sessions.
 */
import type { HookLogEntry } from "./types";

export interface ChangesPrListItem {
  number: number;
  title: string;
  headRefName: string;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  author: string | null;
}

export interface ChangesPrList {
  project: string;
  repo: string;
  /** When gh answered (ISO). */
  readAt: string;
  /** Open PRs, newest first (by creation). */
  prs: ChangesPrListItem[];
}

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface PrMeta {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: PrFile[];
  /** Issues the PR closes, as GitHub parsed them (closingIssuesReferences). */
  closingIssues: number[];
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
}

/**
 * Whether the PR's file list is every file it changes. gh pr view lists at most 100 files; past that
 * the reader pages GitHub's files API, and adds any file the diff has that is still missing.
 */
export type FilesRead =
  | { status: "complete"; from: "gh pr view" | "gh api" | "gh pr view + diff" | "gh api + diff" }
  | { status: "partial"; reason: string };

export type DiffRead = { status: "ok"; text: string } | { status: "unreadable"; reason: string };

export interface PrCommit {
  oid: string;
  headline: string;
  authoredDate: string;
  /** Files this commit touched; null when they could not be read (filesError says why). */
  files: string[] | null;
  filesError?: string;
  /** Where the file list came from. */
  filesFrom?: "git" | "gh";
}

export type CommitsRead =
  | { status: "ok"; commits: PrCommit[] }
  /** Some commits' files could not be read, or there were more commits than the cap. */
  | { status: "partial"; commits: PrCommit[]; reason: string }
  | { status: "unreadable"; reason: string };

/** One PR file's layer, from the structure reader's layer map. */
export interface FileLayer {
  path: string;
  /** The block (component) the file sits in, or null when it sits in none. */
  layer: string | null;
  /** How the layer was found: the measured module itself, or the block's folder (a file the measured commit does not have). */
  how: "module" | "folder" | "outside-package" | "unmapped";
}

export type LayersRead =
  | { status: "unknown"; reason: string }
  | {
      status: "measured";
      /** The design package measured, and where. */
      packageDir: string;
      measuredAt: { ref: string; sha: string; date: string | null };
      files: FileLayer[];
      /** Layers touched, with how many PR files sit in each, most first. */
      layers: { name: string; files: number }[];
    };

export type HookLogRead =
  | { status: "read"; path: string; entries: HookLogEntry[]; totalEntries: number; malformedLines: number }
  | { status: "absent"; path: string }
  | { status: "unreadable"; path: string; reason: string };

/** How a session was tied to the PR. */
export type SessionMatch = "pr-link" | "branch" | "agent-issue";

export interface PrSession {
  sessionId: string | null;
  how: SessionMatch[];
  /** Transcripts that named the PR or ran on its branch (absolute paths). */
  transcripts: string[];
  /** Set when AnviDeck started this agent (its registry id). */
  agentId?: string;
  /** The injector's log for this session, filtered to the PR's files. */
  log: HookLogRead | null;
}

export type SessionsRead =
  | {
      status: "ok" | "partial";
      /** Transcript folders searched (absolute). */
      searched: string[];
      /** The PR files each session's hook log was searched for. A file not here was not looked for. */
      filesSearched: string[];
      errors: string[];
      sessions: PrSession[];
      /** The agent registry read for AnviDeck-started agents. */
      registry: { path: string; status: "read" | "absent" | "unreadable"; reason?: string };
    }
  | { status: "unreadable"; reason: string };

export type DharanaRead =
  | { status: "none"; searched: string[] }
  | { status: "unreadable"; path: string; reason: string }
  | { status: "read"; path: string; boundaries: { id: string; title: string }[] };

export interface ChangesResponse {
  project: string;
  projectPath: string;
  repo: string;
  readAt: string;
  pr: PrMeta;
  /** Whether pr.files is every file the PR changes. */
  filesRead: FilesRead;
  diff: DiffRead;
  commits: CommitsRead;
  layers: LayersRead;
  sessions: SessionsRead;
  dharana: DharanaRead;
  /** Error-pattern and invariant titles by ID, from the project's catalogues, for the IDs the log names. */
  titles: Record<string, string>;
  titlesStatus: { status: "read" | "none" | "unreadable" | "partial"; errors: string[] };
}
