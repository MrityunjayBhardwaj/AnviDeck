// -- Catalogue types --

export interface CatalogueEntry {
  id: string;
  title: string;
  sections: Record<string, string>;
  tags: string[];
  origin?: string;
  why?: string;
  how?: string;
  /** Ground Truth REF — provenance chain to source code */
  ref?: string;
  /** Whether entry is grounded (has REF to Ground Truth doc) */
  grounded: boolean;
}

export interface Catalogue {
  name: string;
  path: string;
  entries: CatalogueEntry[];
  lastModified: Date;
}

// -- Memory types --

export interface MemoryEntry {
  name: string;
  description: string;
  type: "user" | "feedback" | "project" | "reference";
  content: string;
  sections: Record<string, string>;
  filePath: string;
}

// -- Project types --

export interface BoundaryInfo {
  id: string;
  name: string;
  fatality: boolean;
  patternCount: number;
}

export interface GroundTruthDoc {
  system: string;
  path: string;
  lines: number;
  codeCitations: number;
  stages: number;
  lastModified: Date;
}

export interface GroundingStatus {
  totalEntries: number;
  groundedEntries: number;
  ungroundedEntries: number;
  groundTruthDocs: GroundTruthDoc[];
  sourceDirectories: string[];
}

export interface ProjectState {
  name: string;
  path: string;
  /**
   * How the project path was determined from ~/.claude/projects/<encoded>:
   * the cwd in its transcripts, a unique filesystem match, a unique
   * central-store name under an existing parent (directory itself gone), or
   * not at all (path is then "" and nothing is read from a guessed location).
   */
  pathSource?: "transcript" | "filesystem" | "store" | "unresolved";
  catalogues: Catalogue[];
  memory: MemoryEntry[];
  fatalitySignals: number;
  misalignedInvariants: number;
  blindSpots: number;
  boundaries: BoundaryInfo[];
  grounding: GroundingStatus;
}

// -- Timeline types --

export interface TimelinePoint {
  hash: string;
  message: string;
  date: Date;
  filesChanged: string[];
}

export interface FrameworkState {
  principles: string;
  memories: MemoryEntry[];
  catalogues: Catalogue[];
}

// -- File watcher types --

export type WatchEventType = "change" | "rename";

export interface WatchEvent {
  type: WatchEventType;
  path: string;
  timestamp: Date;
}

// -- Real-time types --

export interface HookLogEntry {
  ts: string;
  sid: string;
  file: string;
  boundaries: string[];
  fatality: boolean;
  patterns: string[];
  invariants: string[];
}

export interface RouteLogEntry {
  ts: string;
  sid: string;
  file: string;
  category: string;
  tier: number;
}

export interface SessionContext {
  sessionId: string;
  model?: string;
  contextRemaining?: number;
  cwd?: string;
}

export type WSMessage =
  | { type: "hook"; data: HookLogEntry }
  | { type: "route"; data: RouteLogEntry }
  | { type: "session"; data: SessionContext }
  | { type: "heartbeat" };

// -- Routing Architecture types --

export interface RoutingFileInfo {
  path: string;
  name: string;
  sizeBytes: number;
  estimatedTokens: number;
}

export interface RoutingTier {
  tier: number;
  name: string;
  description: string;
  files: RoutingFileInfo[];
  totalTokens: number;
}

export interface RoutingTableEntry {
  activity: string;
  files: string[];
  catalogues: string[];
  totalTokens: number;
  fileDetails: RoutingFileInfo[];
}

export interface RoutingArchitecture {
  tiers: RoutingTier[];
  routingTable: RoutingTableEntry[];
  totalCapacity: number;
}

// -- Cross-Project types --

export interface CrossProjectPattern {
  keyword: string;
  entries: { project: string; entryId: string; title: string; content: string }[];
}

export interface CrossProjectData {
  recurringPatterns: CrossProjectPattern[];
  sharedInvariants: CrossProjectPattern[];
  memoryNetwork: {
    byType: Record<string, { project: string; name: string; description: string }[]>;
    totalCount: number;
  };
  projectCount: number;
}

// -- System Lens types --

export interface ContributionCell {
  status: "contributed" | "not-relevant" | "stale";
  fireCount: number;
}

export interface ContributionRow {
  entryId: string;
  entryTitle: string;
  catalogue: string;
  sessions: Record<string, ContributionCell>;
  totalFires: number;
  lastFired: string | null;
  created: string | null;
  why?: string;
}

export interface HookLogSession {
  sid: string;
  entries: HookLogEntry[];
  boundaries: string[];
  totalFires: number;
  fatalityFires: number;
}

// -- Brain View types --

export interface BrainStratum {
  name: string;
  catalogue: string;
  entries: CatalogueEntry[];
  color: string;
}

export interface BrainBoundaryNode {
  id: string;
  name: string;
  patternCount: number;
  fatality: boolean;
  linkedEntries: string[];
}

export interface BrainFlowEvent {
  ts: string;
  tier: number;
  label: string;
  fatality: boolean;
  patterns: string[];
  source: "hook" | "route";
}

// -- GitHub Trace types --

export interface GitHubArtifact {
  type: "issue" | "pr" | "commit";
  id: string;
  title: string;
  url: string | null;
  date: string;
  confidence: "high" | "medium";
  matchedKeywords: string[];
}

export interface EntryTrace {
  entryId: string;
  entryTitle: string;
  catalogue: string;
  artifacts: GitHubArtifact[];
}

export interface GitHubTrace {
  project: string;
  repoUrl: string | null;
  entries: EntryTrace[];
  artifactCount: { issues: number; prs: number; commits: number };
  correlationCount: number;
  cachedAt: string;
  error: string | null;
}

// -- API response types --

export interface ProjectSummary {
  name: string;
  path: string;
  /**
   * How the project path was determined from ~/.claude/projects/<encoded>:
   * the cwd in its transcripts, a unique filesystem match, a unique
   * central-store name under an existing parent (directory itself gone), or
   * not at all (path is then "" and nothing is read from a guessed location).
   */
  pathSource?: "transcript" | "filesystem" | "store" | "unresolved";
  catalogueCounts: Record<string, number>;
  memoryCount: number;
  fatalitySignals: number;
  misalignedInvariants: number;
  blindSpots: number;
  /** Percentage of catalogue entries with Ground Truth REFs (0-100) */
  groundingPercent: number;
  /** Number of Ground Truth docs found */
  groundTruthDocCount: number;
}

/** A live (currently-running) Claude Code session. */
export interface LiveSession {
  sessionId: string;
  pid: number;
  /** Derived session name, e.g. "anvi-8e". */
  name: string;
  /** Project = basename of the session's cwd. */
  project: string;
  cwd: string;
  /** Reported session status, e.g. "busy" | "idle". */
  status: string;
  /** Session start (epoch ms). */
  startedAt: number;
  /** Last status/activity update (epoch ms). */
  updatedAt: number;
  /** Claude Code version. */
  version: string;
  /** e.g. "interactive". */
  kind: string;
  /** Current git branch at cwd, or null. */
  branch: string | null;
}
