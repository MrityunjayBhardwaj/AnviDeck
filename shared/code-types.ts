/**
 * Project · Code (#88): the answers of GET /api/code/:project (the tree), GET
 * /api/code/:project/file (one file at a commit, with blame), GET /api/code/:project/working
 * (the working copy an edit replaces) and POST /api/code/:project/edit.
 *
 * Every answer says where it came from. A source that could not be read says so in its own
 * field ("unreadable"), never as an empty list.
 */
import type { StructureProjectResponse } from "./structure-types";

/** What an AnviDeck agent edited, from its transcript in the agent host's registry. */
export interface AgentEdit {
  /** Path relative to the package shown in the tree (the agent may have edited it in another checkout). */
  file: string;
  /** The absolute path the agent's tool call named. */
  abs: string;
  tool: string;
  at: string;
}

export interface AgentTouch {
  id: string;
  status: string;
  running: boolean;
  cwd: string;
  prompt: string;
  /** Edits on files of this repository, inside the package shown. */
  edits: AgentEdit[];
  /** Set when this agent's transcript could not be read whole: its edits are not all known. */
  unreadable?: string;
}

export interface AgentsRead {
  status: "ok" | "off" | "partial";
  /** Why the agent host could not be asked ("off"), or which transcripts could not be read ("partial"). */
  reason?: string;
  /** AnviDeck's agent registry folder. */
  registry: string | null;
  /** Every agent in the registry (the population), and how many run now. */
  total: number;
  running: number;
  /** Agents with at least one edit on this package. */
  agents: AgentTouch[];
}

/** One `file:line` a catalogue entry cites, placed on a file of the tree. */
export interface TrapCite {
  catalogue: string;
  /** "error pattern", "invariant", "lifecycle", "focus". */
  kind: string;
  entryId: string;
  title: string;
  /** The entry field the citation is in (REF, Root cause, …). */
  field: string;
  /** The citation as written, e.g. `StrudelEngine.ts:445`. */
  cite: string;
  /** Package-relative file it was placed on. */
  file: string;
  lines: number[];
}

export interface TrapsRead {
  status: "ok" | "none" | "partial" | "unreadable";
  /** The catalogue folder read, or null when the project has none. */
  dir: string | null;
  errors: string[];
  /** Citations of `<file>:<line>` found in every entry (the population). */
  cites: number;
  /** Placed on a file in this package. */
  placed: TrapCite[];
  /** Name a file outside this package, or one no file at this commit ends with. */
  elsewhere: number;
  /** Citations that name a file by a suffix more than one file in the repository ends with: not placed. */
  ambiguousCites: number;
  /** Those citations, each once, with how many files end with it. */
  ambiguous: { cite: string; candidates: number }[];
}

export interface CodeTreeOk {
  status: "ok";
  project: string;
  /** The repository's top folder (the main checkout). */
  top: string;
  /** The package the design guard judges (the top itself when no design is registered). */
  packageDir: string;
  /** packageDir relative to top ("" when they are the same). */
  packageRel: string;
  /** The commit everything below is read at. */
  commit: { ref: string; sha: string; date: string | null; why: string };
  /** Package-relative paths of the files tracked at that commit (git ls-tree). */
  files: string[];
  filesFrom: string;
  /** The design reader's answer for the same project (GET /api/structure/:project). */
  structure: StructureProjectResponse;
  agents: AgentsRead;
  traps: TrapsRead;
  /** The rule Code uses to decide an edit may be written, in words. */
  editRule: string;
}

export interface CodeTreeNot {
  status: "not-measured" | "could-not-read";
  project: string;
  reason: string;
  structure?: StructureProjectResponse;
}

export type CodeTreeResponse = CodeTreeOk | CodeTreeNot;

export interface BlameCommit {
  sha: string;
  author: string;
  /** ISO time the commit was authored. */
  at: string;
  summary: string;
}

export interface CodeFileOk {
  status: "ok";
  project: string;
  /** Repository-relative path. */
  file: string;
  sha: string;
  /** The file's text at sha, as git show gave it. */
  text: string;
  bytes: number;
  /** Per line (index 0 = line 1): the commit that last changed it. */
  blame: { status: "ok"; lines: string[]; commits: Record<string, BlameCommit> } | { status: "unreadable"; reason: string };
}

export interface CodeFileNot {
  status: "not-found" | "not-text" | "too-big" | "could-not-read" | "bad-request";
  project: string;
  file: string;
  sha?: string;
  reason: string;
}

export type CodeFileResponse = CodeFileOk | CodeFileNot;

/** A running AnviDeck agent that keeps a file from being edited, and why. */
export interface Touching {
  id: string;
  status: string;
  why: "works in this folder" | "edited this file" | "edits not known" | "a terminal session works in this folder" | "sessions not known";
  detail: string;
}

/** The working copy an edit would replace, and whether Code may write it now. */
export interface WorkingFile {
  project: string;
  /** Repository-relative path. */
  path: string;
  abs: string;
  text: string;
  /** sha256 of the bytes on disk, hex: an edit must name it. */
  hash: string;
  bytes: number;
  /** Agents that keep the file read-only now; empty when none. */
  touching: Touching[];
  editable: boolean;
  /** Why it is not editable now, when it is not. */
  reason?: string;
  rule: string;
  readAt: string;
}

export interface EditResult {
  project: string;
  path: string;
  abs: string;
  before: string;
  after: string;
  bytes: number;
  writtenAt: string;
}
