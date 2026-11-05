/**
 * Help's six guided flows (#91): what each step opens, what it points at, and how a step is
 * judged when the screen is not showing it. Pure: no DOM, so tests read it directly. The DOM
 * runner is tour-runner.ts (the polling and the decisions) and tour.ts (the card).
 *
 * The flows are the prototype's (https://claude.ai/artifact/RucrgeLUJLfb8HaCTUGViF), its step
 * titles and wording, placed on the screens that exist on main and on the project picked in the
 * switcher. Where the prototype pointed at something no screen shows yet, the step is routed to
 * the screen that does show it, or it is skipped and the card says why.
 *
 * A tour opens screens and highlights. It never presses a button: Start agent, Merge, Allow,
 * Right / Wrong and Re-check are pointed at, never pressed (tests/help-tour.test.ts).
 */
import type { ScreenId } from "./routes";

/** What a step knows when it builds its hash: the picked project and what earlier steps read. */
export interface TourCtx {
  project: string | null;
  /** Attributes read off the element an earlier step of this flow highlighted (Step.capture). */
  got: Record<string, string>;
  now: Date;
}

/**
 * A sign on the screen that the data is not shown for a reason the screen states: it could not
 * read, the instrument is still measuring, no source records it. Its words are quoted on the card.
 */
export interface Gap {
  sel: string;
  /** Words to show instead of the element's text (for elements with no text, e.g. SVG cells). */
  say?: string;
  /** Still reading or measuring: wait for it (up to the step's limit) instead of skipping at once. */
  transient?: boolean;
}

export interface Step {
  title: string;
  body: string;
  /** The screen the step opens (for the flow's "Screens:" line). */
  screen: ScreenId;
  /** The hash the step opens. */
  to: (c: TourCtx) => string;
  /** The element highlighted: the first match. */
  target: string;
  /** What must be on the screen for the step's data to count as there (default: the target). */
  needs?: string;
  /** The screen has finished reading: from then, no target means no data. */
  ready: string;
  gaps?: Gap[];
  /** Why the step is skipped when the screen finished reading and shows no such thing. */
  none: (c: TourCtx) => string;
  /** An element whose words are added to `none` (e.g. the window the instrument read). */
  noneQuote?: string;
  /** Show the highlighted element's own words on the card (its state is the point of the step). */
  quote?: boolean;
  /**
   * Values kept for later steps of the flow: name → an attribute of the highlighted element, or of
   * the first match of `sel` (a link the person could follow, e.g. the PR's checklist on Work).
   */
  capture?: Record<string, { attr: string; sel?: string }>;
  /** Values an earlier step must have captured; without them the step is skipped at once, saying why. */
  requires?: string[];
  /** What the step waits for, named in a timeout ("the trial record"). */
  what: string;
  /** How long to wait for the screen (default DEFAULT_LIMIT_MS). */
  limitMs?: number;
  /** After the screen says it is ready, how long to keep looking before saying "no data". */
  graceMs?: number;
}

export interface Flow {
  name: string;
  steps: Step[];
}

export const DEFAULT_LIMIT_MS = 30_000;

const proj = (c: TourCtx) => c.project ?? "this project";
const withProject = (base: string, c: TourCtx, extra: Record<string, string | undefined> = {}) => {
  const q = new URLSearchParams();
  if (c.project) q.set("project", c.project);
  for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
  const s = q.toString();
  return `#${base}${s ? `?${s}` : ""}`;
};

/** The local day (YYYY-MM-DD) `days` before an ISO time. */
export function dayBefore(iso: string, days: number): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  d.setDate(d.getDate() - days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** History opened on a window that starts a day before the blocked edit, so its dot is on it. */
export function historyHashFor(c: TourCtx): string {
  const from = c.got.at ? dayBefore(c.got.at, 1) : null;
  return from ? `#history?from=${from}` : "#history";
}

const WORK_READY = "#wk-board-src, #wk-issues-src, #wk-no-board, #wk-several-boards, #wk-board-unreadable";
/**
 * Where a Design card says why it shows no measurement: a structure gap (no design registered,
 * the guard could not measure), or "Measuring…" while the guard runs. `after` is what precedes
 * it in the card: the heading, or the card's fixed note.
 */
const DESIGN_STRUCTURE_GAP = (card: string, after: string): Gap[] => [
  { sel: `${card} > ${after} + .dz-gap` },
  { sel: `${card} > ${after} + .sh-dim`, transient: true },
];

export const FLOWS: readonly Flow[] = [
  {
    name: "1 · Start a task",
    steps: [
      {
        title: "Pick an issue",
        body: "Start agents from issues. The board Status is the source of truth.",
        screen: "work",
        to: () => "#work",
        // The first card: the board's first column (Todo on a board), or the first open issue.
        target: '[data-tour="issue"]',
        ready: WORK_READY,
        gaps: [{ sel: "#wk-board-error" }, { sel: "#wk-issues-error" }],
        none: (c) => `no issue on ${proj(c)}'s board or among its open issues`,
        what: "the board",
      },
      {
        title: "Start the agent",
        body: "Start agent opens a dialog that names the worktree and branch it creates, with .anvi and ref linked; nothing starts until you confirm there. The tour points at it and does not press it.",
        screen: "work",
        to: () => "#work",
        target: '[data-tour="start-agent"]',
        ready: WORK_READY,
        gaps: [{ sel: "#wk-board-error" }, { sel: "#wk-issues-error" }],
        // States Work's rule (work-model.ts canStartAgent), not a guess at which part of it failed.
        none: (c) => `no issue on ${proj(c)}'s board offers Start agent (Work offers it only on an issue of the project's own repository, outside Done and In Progress)`,
        what: "a Start agent button",
      },
      {
        title: "It runs here",
        body: "Each agent gets a tab. Tool calls show which anvi hooks ran and what context they gave. Sessions started in a terminal are tabs too, view only.",
        screen: "agents",
        to: (c) => withProject("agents", c),
        target: '[data-tour="agent-tabs"]',
        needs: '[data-tour="agent-tabs"] .aw-tab',
        ready: "#aw-host-line",
        graceMs: 4_000,
        none: (c) => `no agent started here and no terminal session of ${proj(c)} to show as a tab`,
        what: "the agent tabs",
      },
      {
        title: "And on Home",
        body: "Each agent is one line: what it is doing, and whether it needs you.",
        screen: "home",
        to: () => "#home",
        target: '[data-tour="home-agents"]',
        needs: '[data-tour="home-agents"] .hm-arow:not(.hm-unread)',
        ready: '[data-tour="home-agents"] .hm-src',
        graceMs: 4_000,
        gaps: [{ sel: '[data-tour="home-agents"] .hm-unread' }],
        none: () => "no agent is running, and none was started here",
        noneQuote: '[data-tour="home-agents"] .hm-note',
        what: "Home's agents",
      },
    ],
  },
  {
    name: "2 · A blocked edit and your call",
    steps: [
      {
        title: "The blocked edit",
        body: "An edit that breaks the design is stopped, with the layer path and the rule. Here it is in the trial record, read from anvi's own instrument.",
        screen: "design",
        to: () => "#design?lens=armed",
        target: '[data-tour="blocked-edit"]',
        ready: "#dz-trial-sum",
        gaps: [{ sel: "#dz-trial > .dz-gap" }, { sel: "#dz-trial > .sh-dim:not(.dz-note)", transient: true }],
        none: (c) => `no blocked edit in ${proj(c)} in the trial record`,
        noneQuote: "#dz-trial-pop",
        capture: { at: { attr: "data-at" }, session: { attr: "data-session" } },
        what: "the trial record",
        limitMs: 120_000,
      },
      {
        title: "As the agent read it",
        body: "On Agents, the refused call carries the refusal the agent read: the layer path, the rule and the guard's remedy.",
        screen: "agents",
        to: (c) => withProject("agents", c, { session: c.got.session }),
        requires: ["session"],
        target: '[data-tour="refusal-card"]',
        ready: ".aw-card[data-session] .aw-log, #aw-read-all",
        // The session itself could not be read (not a tool call's own error mark inside its log).
        gaps: [{ sel: ".aw-card[data-session] > .aw-err" }],
        graceMs: 2_000,
        none: (c) =>
          c.got.session
            ? `the refusal is not among the records this screen read of session ${c.got.session.slice(0, 8)}`
            : "no blocked edit was highlighted in the step before, so there is no session to open",
        noneQuote: ".aw-note:has(#aw-read-all)",
        what: "the session's tool calls",
      },
      {
        title: "Your call",
        body: "Right or Wrong, with a note: your ruling on the refusal is recorded in AnviDeck's own folder. The tour does not press either.",
        screen: "design",
        to: () => "#design?lens=armed",
        target: '[data-tour="your-call"]',
        ready: "#dz-trial-sum",
        gaps: [{ sel: "#dz-trial > .dz-gap" }, { sel: "#dz-trial > .sh-dim:not(.dz-note)", transient: true }],
        none: (c) => `no blocked edit in ${proj(c)} in the trial record, so there is nothing to rule on`,
        noneQuote: "#dz-trial-pop",
        what: "the trial record",
        limitMs: 120_000,
      },
      {
        title: "Recorded on the timeline",
        body: "Refusals (filled) and your calls (rings) sit on History's timeline beside the agents' turns, edits and commits.",
        screen: "history",
        to: historyHashFor,
        target: "#hs-svg",
        needs: '.hs-cell[data-row="refusals"]:not([data-n="0"])',
        ready: "#hs-svg",
        gaps: [
          { sel: "#hs-status.hs-bad" },
          { sel: '.hs-cell[data-row="refusals"][data-lane="unreadable"]', say: "the Refusals & rulings lane could not be read" },
          { sel: '.hs-cell[data-row="refusals"][data-lane="measuring"]', say: "the Refusals & rulings lane is still measuring", transient: true },
        ],
        none: (c) => `no refusal or call of ${proj(c)} in the window shown`,
        noneQuote: "#hs-status",
        what: "the timeline",
        limitMs: 90_000,
      },
    ],
  },
  {
    name: "3 · Review a change",
    steps: [
      {
        title: "Read the diff",
        body: "Each file shows the anvi context the agent had when it wrote it.",
        screen: "changes",
        to: (c) => withProject("changes", c),
        target: '[data-tour="diff"]',
        needs: '[data-tour="diff"] .chg-fsec',
        ready: ".chg-pick",
        gaps: [{ sel: ".chg-screen > .chg-bad" }, { sel: '[data-tour="diff"] > .chg-bad-annot' }, { sel: ".chg-pick[title]" }],
        none: (c) => `no open PR in ${proj(c)}`,
        noneQuote: ".chg-screen > .sh-card",
        capture: { checklist: { attr: "href", sel: ".chg-primary" } },
        what: "the PR's diff",
        limitMs: 120_000,
      },
      {
        title: "Comment on a line",
        body: "Comments go back to the agent as instructions. The line below says whether this PR has an agent that can take them.",
        screen: "changes",
        to: (c) => withProject("changes", c),
        target: '[data-tour="line-comments"]',
        ready: ".chg-pick",
        gaps: [{ sel: ".chg-screen > .chg-bad" }],
        none: (c) => `no open PR in ${proj(c)}`,
        quote: true,
        what: "the line comments",
        limitMs: 120_000,
      },
      {
        title: "Check the evidence",
        body: "Tests (with the runner's exit code), what was observed, and what was not checked, kept separate.",
        screen: "changes",
        to: (c) => withProject("changes", c),
        target: '[data-tour="evidence"]',
        ready: ".chg-pick",
        gaps: [{ sel: ".chg-screen > .chg-bad" }],
        none: (c) => `no open PR in ${proj(c)}`,
        quote: true,
        what: "the evidence",
        limitMs: 120_000,
      },
      {
        title: "Your workflow, visible",
        body: "Issue to merge. Agents stop before merge; you merge. The tour does not press Merge.",
        screen: "work",
        to: (c) => c.got.checklist ?? "#work",
        target: '[data-tour="pipeline"]',
        ready: "#wk-prs-src, #wk-no-prs",
        gaps: [{ sel: "#wk-prs-error" }, { sel: "#wk-focus-missing" }],
        none: (c) => `no open PR in ${proj(c)}`,
        what: "the PR's workflow",
        limitMs: 120_000,
      },
    ],
  },
  {
    name: "4 · Notes go out of date",
    steps: [
      {
        title: "The status line",
        body: "One line says if anything needs watching. Open it for the numbers.",
        screen: "home",
        to: () => "#home",
        target: '[data-tour="status"]',
        ready: '[data-tour="status"]',
        none: () => "Home did not draw its status line",
        quote: true,
        what: "the status line",
      },
      {
        title: "Open Notes",
        body: "What anvi knows, which notes are used when, and which are out of date.",
        screen: "notes",
        to: () => "#notes?tab=decay",
        target: '[data-tour="notes-tabs"]',
        ready: '[data-tour="notes-tabs"]',
        none: () => "Notes did not draw its tabs",
        what: "Notes' tabs",
      },
      {
        title: "Re-check a batch",
        body: "Batches go by subsystem, never all at once. Re-check shows the agent's prompt first; the tour does not press it.",
        screen: "notes",
        to: () => "#notes?tab=decay",
        target: '[data-tour="recheck"]',
        ready: "#nt-batches",
        gaps: [{ sel: "#nt-batches .nt-bad" }, { sel: "#nt-measuring", transient: true }],
        none: (c) => `anvi's currency report marks no entry of ${proj(c)} out of date`,
        what: "the batches to re-check",
        limitMs: 120_000,
      },
    ],
  },
  {
    name: "5 · Place new code",
    steps: [
      {
        title: "Placed lens",
        body: "Before an agent writes a new module, ask where it belongs. Ask shows the agent's prompt first; nothing starts until you press Start agent.",
        screen: "design",
        to: () => "#design?lens=placed",
        target: '[data-tour="ask-placement"]',
        ready: '[data-tour="ask-placement"]',
        none: () => "the Placed lens did not draw its question box",
        what: "the question box",
      },
      {
        title: "The move in review",
        body: "The move is drawn on the graph, and its PR is one click away.",
        screen: "design",
        to: () => "#design?lens=placed",
        target: '[data-tour="placement"]',
        needs: '[data-tour="placement"]:not(:has(.dz-gap))',
        ready: '[data-tour="placement"]',
        none: () => "no placement is in review",
        noneQuote: '[data-tour="placement"] .dz-gap',
        what: "the placement in review",
      },
    ],
  },
  {
    name: "6 · Fix a boundary",
    steps: [
      {
        title: "Consolidated lens",
        body: "Where error patterns cluster, invariants span modules, and fixes keep getting bigger.",
        screen: "design",
        to: () => "#design?lens=consolidated",
        target: '[data-tour="clusters"]',
        needs: '[data-tour="clusters-measured"]',
        ready: '[data-tour="clusters-measured"]',
        gaps: DESIGN_STRUCTURE_GAP('[data-tour="clusters"]', "h3"),
        none: () => "the Consolidated lens drew no clusters",
        what: "where problems cluster",
        limitMs: 90_000,
      },
      {
        title: "Path to target",
        body: "The distance from today's structure to the declared design: the rule breaks the baseline still allows, by pair.",
        screen: "design",
        to: () => "#design?lens=path",
        target: '[data-tour="path"]',
        needs: '[data-tour="path"] .dz-note',
        ready: '[data-tour="path"] .dz-note',
        gaps: DESIGN_STRUCTURE_GAP('[data-tour="path"]', "h3 + .dz-gap"),
        none: () => "the Path to target lens drew nothing measured",
        what: "the path to target",
        limitMs: 90_000,
      },
    ],
  },
];

// ── deciding one step ─────────────────────────────────────────────────────────────────────

/** What the runner saw on the screen at one look. */
export interface Look {
  target: boolean;
  needs: boolean;
  ready: boolean;
  /** The first gap on the screen, with its words. */
  gap: { text: string; transient: boolean } | null;
  /** Milliseconds since the step opened its screen. */
  elapsed: number;
  /** Milliseconds since `ready` was first seen, or null if not yet. */
  sinceReady: number | null;
}

export type SkipWhy = "no-data" | "gap" | "still-reading" | "timeout";
export type Outcome = { kind: "show" } | { kind: "wait" } | { kind: "skip"; why: SkipWhy; text: string };

const secs = (ms: number) => `${Math.round(ms / 1000)} s`;

/**
 * One look → show, keep waiting, or skip with the reason. The four skips are told apart: the
 * screen finished and has no such data; the screen says why it shows none (it could not read,
 * no source records it); it was still reading when the time ran out; it never showed the thing.
 */
export function decide(step: Step, look: Look, c: TourCtx, noneQuote?: string | null): Outcome {
  const limit = step.limitMs ?? DEFAULT_LIMIT_MS;
  if (look.target && look.needs) return { kind: "show" };
  if (look.gap && !look.gap.transient) return { kind: "skip", why: "gap", text: `the screen says: ${look.gap.text}` };
  if (look.gap && look.gap.transient) {
    if (look.elapsed >= limit) return { kind: "skip", why: "still-reading", text: `still reading after ${secs(look.elapsed)}: ${look.gap.text}` };
    return { kind: "wait" };
  }
  if (look.ready && look.sinceReady !== null && look.sinceReady >= (step.graceMs ?? 0)) {
    const q = noneQuote?.trim();
    return { kind: "skip", why: "no-data", text: `${step.none(c)}${q ? ` (the screen: ${q})` : ""}` };
  }
  if (look.elapsed >= limit) return { kind: "skip", why: "timeout", text: `the screen did not show ${step.what} within ${secs(limit)}` };
  return { kind: "wait" };
}

/** An element's words, one line, at most `max` characters. */
export function squeeze(text: string, max = 280): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ── moving through the flows ──────────────────────────────────────────────────────────────

export interface TourPos {
  flow: number;
  step: number;
}

/** The next step, the first step of the next flow (as the prototype), or done after the last. */
export function nextPos(p: TourPos, flows: readonly Flow[] = FLOWS): TourPos | "done" {
  if (p.step < flows[p.flow]!.steps.length - 1) return { flow: p.flow, step: p.step + 1 };
  if (p.flow < flows.length - 1) return { flow: p.flow + 1, step: 0 };
  return "done";
}

/** Back stays within the flow. */
export function backPos(p: TourPos): TourPos | null {
  return p.step > 0 ? { flow: p.flow, step: p.step - 1 } : null;
}

export function countText(p: TourPos, flows: readonly Flow[] = FLOWS): string {
  return `step ${p.step + 1} of ${flows[p.flow]!.steps.length}`;
}

export function nextLabel(p: TourPos, flows: readonly Flow[] = FLOWS): string {
  if (p.step < flows[p.flow]!.steps.length - 1) return "Next";
  return p.flow < flows.length - 1 ? "Next flow" : "Finish";
}

/** The screens a flow opens, in order, each once. */
export function flowScreens(f: Flow): ScreenId[] {
  return [...new Set(f.steps.map((s) => s.screen))];
}
