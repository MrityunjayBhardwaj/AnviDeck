/**
 * The ⌘K palette's entries and its filter (#80). Pure: the DOM part is palette.ts.
 *
 * An entry opens something (`hash` or `href`), runs a command of this page (`command`), or is
 * listed as not wired yet (`pending` names the issue that wires it). "Start an agent on an
 * issue" (#78) opens its dialog; the commands that start an agent on a task with no issue
 * (/anvi:debug, /anvi:currency) are pending until #130.
 */
import { SCREENS, hashFor, type ScreenId } from "./routes";
import type { StripAgent } from "./activity";

export type PaletteGroup = "Screens" | "Projects" | "Agents" | "Issues" | "Commands";

export interface PaletteEntry {
  group: PaletteGroup;
  label: string;
  /** Second line, dim. */
  hint?: string;
  /** Opens a screen in this page. */
  hash?: string;
  /** Opens another page (the temporary agent host page). */
  href?: string;
  /** Picks a project in the switcher. */
  project?: string;
  /** Runs a command of this page (opens its dialog). */
  command?: PaletteCommand;
  /** Not wired yet: shown, never run. */
  pending?: string;
}

/** Commands an entry can run in this page. */
export type PaletteCommand = "start-from-issue";

export interface PaletteInput {
  projects: { name: string; path: string }[];
  currentProject: string | null;
  /** AnviDeck-started agents, or null when they could not be read. */
  hostAgents: StripAgent[] | null;
  /** Claude Code sessions in terminals, from /api/home. */
  terminalAgents: { sessionId: string; name: string; project: string; status: string }[];
}

/** Screens that take the current project as a parameter. */
const PROJECT_PARAM: Partial<Record<ScreenId, string>> = { project: "name", brain: "project", "github-trace": "project", agents: "project" };

export function screenHash(id: ScreenId, project: string | null): string {
  const key = PROJECT_PARAM[id];
  return key && project ? hashFor(id, { [key]: project }) : hashFor(id);
}

export function paletteEntries(inp: PaletteInput): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  for (const s of SCREENS) {
    const where = s.group === "project" ? "Project tab" : s.group === "older" ? "Older view" : s.group === "help" ? "Help" : "Screen";
    out.push({
      group: "Screens",
      label: s.group === "project" ? `Project · ${s.label}` : s.label,
      hint: s.buildsIn ? `${where} · placeholder until #${s.buildsIn}` : where,
      hash: screenHash(s.id, inp.currentProject),
    });
  }
  for (const p of inp.projects) {
    out.push({ group: "Projects", label: `Switch to ${p.name}`, hint: p.path || "path not resolved", project: p.name });
  }
  if (inp.hostAgents) {
    for (const a of inp.hostAgents) {
      const first = a.prompt.split("\n")[0].slice(0, 60);
      out.push({
        group: "Agents",
        label: `${a.id} · ${first || "(no prompt)"}`,
        hint: `started here · ${a.status}${a.issue ? ` · #${a.issue}` : ""} · opens the agent host page until #82`,
        href: "/agent-host",
      });
    }
  }
  for (const a of inp.terminalAgents) {
    out.push({
      group: "Agents",
      label: `${a.project} · ${a.name}`,
      hint: `terminal session · ${a.status}`,
      hash: hashFor("agents", { project: a.project, sid: a.sessionId }),
    });
  }
  out.push({
    group: "Issues",
    label: inp.currentProject ? `Open issues of ${inp.currentProject}` : "Open issues",
    hint: "no AnviDeck route lists a project's open issues yet",
    pending: "#85",
  });
  out.push(
    {
      group: "Commands",
      label: "Start an agent on an issue",
      hint: `in its own worktree and branch${inp.currentProject ? ` · ${inp.currentProject}` : ""}`,
      command: "start-from-issue",
    },
    { group: "Commands", label: "/anvi:debug · systematic diagnosis in a new agent", pending: "#130" },
    { group: "Commands", label: "/anvi:currency · re-check drifted notes in a new agent", pending: "#130" },
    { group: "Commands", label: "Open the agent host page", hint: "temporary page from #75: start, watch, stop agents", href: "/agent-host" },
  );
  return out;
}

/**
 * Fuzzy score: every query character must appear in order. Higher is better; null is no match.
 * Consecutive characters and characters at word starts score more, so "pd" ranks
 * "Project · Design" above "Map dive".
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === " ") continue;
    const at = t.indexOf(ch, ti);
    if (at === -1) return null;
    score += 1;
    if (at === prev + 1) score += 3;
    if (at === 0 || /[\s·/:#\-_.]/.test(t[at - 1])) score += 2;
    prev = at;
    ti = at + 1;
  }
  // Shorter labels win ties: a closer match.
  return score - t.length / 100;
}

/**
 * The label is matched fuzzily. The hint (a path, a status) only lets an entry in when it
 * contains the query as written, ranked below every label match: a fuzzy match over a long
 * path matches almost any query.
 */
function entryScore(e: PaletteEntry, query: string): number | null {
  const l = fuzzyScore(query, e.label);
  if (l !== null) return l + 1000;
  const q = query.trim().toLowerCase();
  return q && e.hint?.toLowerCase().includes(q) ? 0 : null;
}

/**
 * Entries matching the query, best first within each group. With no query the groups keep
 * their order; with a query, the group holding the best match comes first, so the selected
 * first row is the best match and not a weak one from an earlier group.
 */
export function filterEntries(entries: PaletteEntry[], query: string): PaletteEntry[] {
  const groups: PaletteGroup[] = ["Screens", "Projects", "Agents", "Issues", "Commands"];
  const blocks: { g: number; best: number; rows: PaletteEntry[] }[] = [];
  groups.forEach((g, gi) => {
    const scored = entries
      .filter((e) => e.group === g)
      .map((e, i) => ({ e, i, s: entryScore(e, query) }))
      .filter((x): x is { e: PaletteEntry; i: number; s: number } => x.s !== null);
    if (!scored.length) return;
    if (query.trim()) scored.sort((a, b) => b.s - a.s || a.i - b.i);
    blocks.push({ g: gi, best: scored[0]!.s, rows: scored.map((x) => x.e) });
  });
  if (query.trim()) blocks.sort((a, b) => b.best - a.best || a.g - b.g);
  return blocks.flatMap((b) => b.rows);
}

/**
 * Which choosable row starts selected (an index into the rows that can run), or -1 for none.
 * When the best match cannot run yet (a command still pending), nothing is selected:
 * otherwise Enter would run the next runnable row, a weaker match the person did not ask for.
 */
export function initialSelection(shown: PaletteEntry[], query: string): number {
  if (!shown.length) return -1;
  if (query.trim() && shown[0]!.pending) return -1;
  return 0;
}
