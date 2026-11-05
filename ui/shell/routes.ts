/**
 * The workspace's screens and their URL hashes (#80). Pure: no DOM, so tests read it directly.
 *
 * Every screen has one hash (`#<id>`, optionally `?params`). The rail, the project tabs, the
 * "Older views" list and the palette all build from SCREENS, so a screen cannot be reachable
 * from one of them and missing from another.
 */

export type ScreenId =
  | "home"
  | "map"
  | "agents"
  | "changes"
  | "notes"
  | "design"
  | "code"
  | "work"
  | "history"
  | "flows"
  | "older"
  | "project"
  | "sessions"
  | "trace"
  | "brain"
  | "system-lens"
  | "cross-project"
  | "routing"
  | "github-trace";

/** Which rail item is lit while a screen is open. */
export type RailKey = "home" | "map" | "agents" | "changes" | "notes" | "project" | "older" | null;

export interface ScreenDef {
  id: ScreenId;
  label: string;
  /** rail: its own rail item. project: a tab under the Project rail item. help: opened from Help. older: listed under Older views. */
  group: "rail" | "project" | "help" | "older";
  rail: RailKey;
  /** Not built yet: the screen is a placeholder naming the issue that builds it. */
  buildsIn?: number;
  /** One line: what the screen shows (for placeholders, what it will show). */
  blurb: string;
  /** Older views only: what happens to it. */
  fate?: string;
}

export const SCREENS: readonly ScreenDef[] = [
  { id: "home", label: "Home", group: "rail", rail: "home", blurb: "What needs you, soonest first, and the agents running now." },
  { id: "map", label: "Map", group: "rail", rail: "map", blurb: "Projects, design blocks, files and imports, with agents replayed on them." },
  { id: "agents", label: "Agents", group: "rail", rail: "agents", blurb: "A tab per agent and a 2×2 grid: its plan, its tool calls with the anvi hooks that ran, refusals, and a message box. Terminal sessions view only." },
  {
    id: "changes",
    label: "Changes",
    group: "rail",
    rail: "changes",
    blurb:
      "A PR's files, the layers and boundaries it touches, the diff with the anvi context the agent received at each hunk, line comments that go back to the agent, the evidence and the self-review gaps.",
  },
  {
    id: "notes",
    label: "Notes",
    group: "rail",
    rail: "notes",
    blurb:
      "Catalogues by kind with search, which catalogue is used when, freshness and re-checks, grounding, and project memory with Promote.",
  },
  {
    id: "design",
    label: "Design",
    group: "project",
    rail: "project",
    buildsIn: 87,
    blurb: "Five lenses on the project's design: Armed, Placed, Consolidated, Path to target, System flows.",
  },
  {
    id: "code",
    label: "Code",
    group: "project",
    rail: "project",
    buildsIn: 88,
    blurb:
      "The file tree coloured by layer, with refused edits, imports that break the design and files agents touched; a file view with blame and known-trap lines.",
  },
  {
    id: "work",
    label: "Work",
    group: "project",
    rail: "project",
    blurb:
      "The board, Start agent, New issue, and each PR's workflow as steps with merge checks. Merge is a button only you press.",
  },
  {
    id: "history",
    label: "History",
    group: "project",
    rail: "project",
    blurb:
      "One timeline of agent turns, edits, refusals, rulings, commits and catalogue changes, each naming its source; compare two points; replay a session.",
  },
  {
    id: "flows",
    label: "Example flows",
    group: "help",
    rail: null,
    buildsIn: 91,
    blurb: "Six guided flows played over the real screens: start a task, a blocked edit and your call, review a change, and more.",
  },
  { id: "older", label: "Older views", group: "rail", rail: "older", blurb: "The dashboard's views from before the workspace, until #92 retires them." },
  {
    id: "project",
    label: "Project deep dive",
    group: "older",
    rail: "older",
    blurb: "Catalogues with REF and an ungrounded-only filter, memory, grounding, read status, and the history strip.",
    fate: "not named in #92",
  },
  { id: "sessions", label: "Live Sessions", group: "older", rail: "older", blurb: "Active Claude Code sessions.", fate: "retired by #92" },
  {
    id: "trace",
    label: "Live Trace",
    group: "older",
    rail: "older",
    blurb: "Live hook activity, routing decisions, context budget.",
    fate: "retired by #92",
  },
  {
    id: "brain",
    label: "Brain",
    group: "older",
    rail: "older",
    blurb: "A project's boundaries and entries by stratum, with hook and routing activity.",
    fate: "retired by #92",
  },
  {
    id: "system-lens",
    label: "System Lens",
    group: "older",
    rail: "older",
    blurb: "Contribution matrix, pruning candidates with WHY.",
    fate: "retired by #92",
  },
  {
    id: "cross-project",
    label: "Cross-Project",
    group: "older",
    rail: "older",
    blurb: "Recurring patterns, shared invariants, memory network.",
    fate: "retired by #92",
  },
  {
    id: "routing",
    label: "Routing",
    group: "older",
    rail: "older",
    blurb: "Three-tier context diagram, routing table, coverage.",
    fate: "retired by #92",
  },
  {
    id: "github-trace",
    label: "GitHub Trace",
    group: "older",
    rail: "older",
    blurb: "Catalogue entries linked to issues, PRs and commits.",
    fate: "not named in #92",
  },
];

/** Hashes the prototype used, and Home's details panel, kept working. */
const ALIASES: Record<string, ScreenId> = { knowledge: "notes", architecture: "design", status: "home" };

const BY_ID = new Map(SCREENS.map((s) => [s.id, s]));

export function screen(id: ScreenId): ScreenDef {
  return BY_ID.get(id)!;
}

export interface Route {
  screen: ScreenId;
  params: URLSearchParams;
  /** The hash named no screen; Home is shown instead and the shell says so. */
  unknown?: string;
}

/** `#map?project=x` → { screen: "map", params: project=x }. An empty hash is Home. */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const q = raw.indexOf("?");
  const rawId = q === -1 ? raw : raw.slice(0, q);
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    // A malformed escape (#%E0) is an unknown screen, never an exception at page load.
    return { screen: "home", params: new URLSearchParams(), unknown: rawId };
  }
  const params = new URLSearchParams(q === -1 ? "" : raw.slice(q + 1));
  if (id === "") return { screen: "home", params };
  if (BY_ID.has(id as ScreenId)) return { screen: id as ScreenId, params };
  // Own keys only: "constructor" or "__proto__" must not resolve through Object.prototype.
  if (Object.hasOwn(ALIASES, id)) return { screen: ALIASES[id]!, params };
  return { screen: "home", params: new URLSearchParams(), unknown: id };
}

export function hashFor(id: ScreenId, params?: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v) q.set(k, v);
  const s = q.toString();
  return `#${id}${s ? `?${s}` : ""}`;
}

/** The rail, top to bottom. `to` is where a click goes; Project opens its first tab. */
export const RAIL: readonly { key: Exclude<RailKey, null>; label: string; to: ScreenId }[] = [
  { key: "home", label: "Home", to: "home" },
  { key: "map", label: "Map", to: "map" },
  { key: "agents", label: "Agents", to: "agents" },
  { key: "changes", label: "Changes", to: "changes" },
  { key: "notes", label: "Notes", to: "notes" },
  { key: "project", label: "Project", to: "design" },
  { key: "older", label: "Older", to: "older" },
];

/** The Project rail item's tabs, in the prototype's order. */
export const PROJECT_TABS: readonly ScreenId[] = SCREENS.filter((s) => s.group === "project").map((s) => s.id);

export const OLDER_VIEWS: readonly ScreenId[] = SCREENS.filter((s) => s.group === "older").map((s) => s.id);

export const ISSUE_URL = (n: number) => `https://github.com/MrityunjayBhardwaj/AnviDeck/issues/${n}`;
