// Types for the structure map (GET /api/structure, GET /api/structure/:project).
//
// Every answer carries a `status`, so "could not read / could not measure" is never shaped like
// "nothing found":
//   measured      — the guard built and judged the package's graph at a named commit
//   not-measured  — the guard (or this reader) gave no verdict; `reason` says why
//   no-design     — the project registers no design: its folders are shown, and nothing is blocked
//   could-not-read — an input this reader needs (the registry, the repository) could not be read

/** Where a registry entry came from: the root-owned lock, or the user's own registry. */
export type RegistrySource = "locked" | "user";

export interface StructurePackageEntry {
  dir: string;
  design: string;
  baseline: string;
  designId: string | null;
  extractor: string | null;
  source: RegistrySource;
  /** The registered project check (adapter + files), passed through as the registry states it. */
  check: unknown;
}

export interface StructureProjectListing {
  name: string;
  path: string;
  hasDesign: boolean;
  packages: { dir: string; designId: string | null; source: RegistrySource }[];
}

export interface StructureListResponse {
  status: "ok" | "could-not-read";
  reason?: string;
  registry: { locked: string | null; user: string | null; errors: string[] };
  projects: StructureProjectListing[];
}

/** How an import edge stands under the design and the baseline, as the guard reads it. */
export type EdgeClass =
  | "internal" // both ends in one component: always allowed
  | "allowed" // between two components, and the design declares the pair
  | "grandfathered" // a divergence the baseline holds
  | "new" // a divergence the baseline does not hold: the guard refuses it
  | "unmapped"; // touches a module outside every component: not examined by the divergence rule

export interface StructureEdge {
  from: string;
  to: string;
  fromComponent: string | null;
  toComponent: string | null;
  pair: string | null;
  class: EdgeClass;
  /** null when the edge is on no cycle; else whether the baseline holds that cycle edge */
  cycle: "grandfathered" | "new" | null;
  reexport: boolean;
  typeOnly: boolean;
}

export interface StructureRuleLedger {
  examined: number;
  total: number;
  grandfathered: number;
  new: { key: string; detail: string; pair: string | null }[];
  /** baseline keys that no longer occur */
  fixed: string[];
}

export interface StructureComponent {
  name: string;
  dirs: string[];
  files: string[];
  why: string | null;
  modules: number;
}

export interface MeasuredAt {
  ref: string;
  sha: string;
  date: string | null;
  why: string;
  modulesFrom: string[];
}

export interface GuardSource {
  /** e.g. "structure-guard /Users/.../structure-guard.js@sha256:abcd1234 (mtime ...)" */
  label: string;
  guard: { path: string; sha256: string; mtime: string };
  rules: { path: string; sha256: string } | null;
  graph: string | null;
}

export interface StructureMeasured {
  status: "measured";
  project: string;
  package: StructurePackageEntry;
  refAsked: string | null;
  refChosenBy: string;
  measuredAt: MeasuredAt;
  designId: string;
  baselineDesignId: string | null;
  components: StructureComponent[];
  allowedPairs: string[];
  edgeNotes: Record<string, string>;
  modules: { path: string; rel: string; component: string | null }[];
  edges: StructureEdge[];
  cycles: string[];
  rules: Record<"divergence" | "cycle", StructureRuleLedger>;
  byPair: { pair: string; count: number }[];
  unmapped: string[];
  absences: string[];
  counts: {
    modules: number;
    edges: number;
    examinedBetweenComponents: number;
    byClass: Record<EdgeClass, number>;
    divergence: { total: number; grandfathered: number; new: number; fixed: number };
    cycle: { total: number; grandfathered: number; new: number; fixed: number };
    baselineKeys: { divergence: number; cycle: number };
    relativeImports: number;
    unresolvedRelative: number;
  };
  extractor: string;
  typeOnlyImports: string;
  source: GuardSource;
  timing: { cache: "hit" | "miss"; ms: number; guardMs: number | null };
}

export interface StructureNotMeasured {
  status: "not-measured" | "could-not-read";
  project: string;
  package?: StructurePackageEntry;
  refAsked: string | null;
  measuredAt?: MeasuredAt;
  reason: string;
  source?: GuardSource;
  timing?: { cache: "hit" | "miss"; ms: number; guardMs: number | null };
}

export interface StructureFolder {
  path: string;
  /** files directly inside */
  files: number;
  /** files anywhere below */
  total: number;
}

export interface StructureNoDesign {
  status: "no-design";
  project: string;
  path: string;
  label: "nothing blocked";
  refAsked: string | null;
  refChosenBy: string;
  measuredAt: { ref: string; sha: string } | null;
  /** "git" = tracked files at the ref; "disk" = not a git checkout, read as it is on disk */
  treeFrom: "git" | "disk";
  folders: StructureFolder[];
  files: number;
  timing: { cache: "hit" | "miss"; ms: number };
}

export type StructureProjectResponse = StructureMeasured | StructureNotMeasured | StructureNoDesign;
