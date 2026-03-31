// -- Catalogue types --

export interface CatalogueEntry {
  id: string;
  title: string;
  sections: Record<string, string>;
  tags: string[];
  origin?: string;
  why?: string;
  how?: string;
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

export interface ProjectState {
  name: string;
  path: string;
  catalogues: Catalogue[];
  memory: MemoryEntry[];
  fatalitySignals: number;
  misalignedInvariants: number;
  blindSpots: number;
  boundaries: BoundaryInfo[];
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

// -- API response types --

export interface ProjectSummary {
  name: string;
  path: string;
  catalogueCounts: Record<string, number>;
  memoryCount: number;
  fatalitySignals: number;
  misalignedInvariants: number;
  blindSpots: number;
}
