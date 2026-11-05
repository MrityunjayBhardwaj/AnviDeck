/**
 * The Design screen's rules (#87), apart from the DOM so the tests can pin them. Five lenses:
 * Armed, Placed, Consolidated, Path to target, System flows.
 *
 * Every figure names where it came from. A source that could not be read, or a measurement that
 * could not be made, says so; it never reads as zero or as "nothing". Counts shown in several
 * places (refusals, calls) are derived once here and reused.
 */
import type { StructureMeasured, StructureProjectResponse } from "../../shared/structure-types";
import type { CallVerdict, RefusalCallState, RefusalsResponse } from "../../shared/refusal-types";
import type { EditHooksAnswer, FixCostAnswer, PairCost } from "../../shared/design-types";
import type { BoundaryInfo } from "../../shared/types";

export const LENSES = [
  { k: "armed", label: "Armed · what is enforced" },
  { k: "placed", label: "Placed · where new code goes" },
  { k: "consolidated", label: "Consolidated · where boundaries are wrong" },
  { k: "path", label: "Path to target" },
  { k: "flows", label: "System flows" },
] as const;
export type Lens = (typeof LENSES)[number]["k"];

export function lensOf(params: URLSearchParams): Lens {
  return (LENSES.find((l) => l.k === params.get("lens"))?.k ?? "armed") as Lens;
}

/** "2026-10-13T05:03:45Z" → "2026-10-13" (the stamp's own day, as written). */
export const day = (iso: string | null | undefined): string => (iso ? (/^\d{4}-\d{2}-\d{2}/.exec(iso)?.[0] ?? iso) : "?");
const sha7 = (s: string) => s.slice(0, 7);

/** Where the structure was measured, in one phrase: "origin/main 6a5c17c (commit of 2026-11-05)". */
export function measuredPhrase(s: StructureMeasured): string {
  return `${s.measuredAt.ref} ${sha7(s.measuredAt.sha)}${s.measuredAt.date ? ` (commit of ${day(s.measuredAt.date)})` : ""}`;
}

/** Why a lens that needs the structure cannot show it; null when it can. */
export function structureGap(s: StructureProjectResponse | null, error: string | null): string | null {
  if (error) return `The design could not be read: ${error}.`;
  if (!s) return null;
  if (s.status === "no-design") return `${s.project} registers no design with anvi's structure guard: nothing is enforced, and there are no components to place code in or to measure.`;
  if (s.status !== "measured") return `The design was not measured: ${s.reason}`;
  return null;
}

// ── Armed ──────────────────────────────────────────────────────────────────────────────────

export interface KV {
  k: string;
  v: string;
  note?: string;
  tone?: "ok" | "warn" | "bad";
}

export const GUARD_HOOK = "structure-guard-hook.js";

/** The settings files read, in one phrase: "~/.claude/settings.json (read), /p/.claude/settings.json (absent), …". */
export function filesPhrase(h: EditHooksAnswer): string {
  return h.files.map((f) => `${f.file} (${f.status}${f.reason ? `: ${f.reason}` : ""})`).join(", ");
}

/**
 * Is the guard's hook registered for edits, by the settings files read? "registered" when any
 * file registers it. Otherwise "unknown" when a file could not be read or located, else
 * "not-found": never "not running", because Claude Code also loads hooks from places not read
 * (plugins, frontmatter; `notRead`).
 */
export function guardRegistration(h: EditHooksAnswer): "registered" | "unknown" | "not-found" {
  if (h.hooks.some((x) => x.name === GUARD_HOOK)) return "registered";
  return h.files.some((f) => f.status === "unreadable") ? "unknown" : "not-found";
}

export function enforcement(s: StructureMeasured, hooks: EditHooksAnswer | null): KV[] {
  const p = s.package;
  // Registered means judged only if the edit-time hook runs: the settings say whether it does.
  const reg = hooks ? guardRegistration(hooks) : null;
  const hook =
    hooks === null
      ? { v: "refusing (hook not checked yet)", tone: undefined }
      : reg === "registered"
        ? { v: "refusing", tone: "ok" as const, why: `${GUARD_HOOK} is registered for edits in ${[...new Set(hooks.hooks.filter((h) => h.name === GUARD_HOOK).map((h) => h.file))].join(", ")}` }
        : reg === "unknown"
          ? { v: "unknown", tone: "warn" as const, why: `not every settings file could be read (${filesPhrase(hooks)}), so whether ${GUARD_HOOK} runs is unknown` }
          : { v: "hook not found", tone: "warn" as const, why: `${GUARD_HOOK} is registered for edits in none of the settings files read (${filesPhrase(hooks)}); ${hooks.notRead}, so it may still run` };
  const check = (p.check ?? null) as { mode?: unknown } | null;
  const c = s.counts;
  const rows: KV[] = [
    {
      k: "graph rule",
      v: hook.v,
      ...(hook.tone ? { tone: hook.tone } : {}),
      note:
        ("why" in hook ? `${hook.why}; ` : "") +
        `an edit that adds an import the design does not allow, and the baseline does not hold, is refused (${p.source === "locked" ? "registered in the locked registry" : "registered in your own registry"})`,
    },
    {
      k: "project's own check",
      v: check && typeof check.mode === "string" ? check.mode : "none registered",
      ...(check && check.mode === "refuse" ? { tone: "ok" as const } : {}),
      note: check ? "as the registry states it" : "the registry names no check of the project's own",
    },
    { k: "design", v: s.designId, note: s.baselineDesignId && s.baselineDesignId !== s.designId ? `the baseline was written under ${s.baselineDesignId}` : "the baseline was written under the same design" },
    {
      k: "allowed breaks",
      v: `${c.divergence.grandfathered} held · ${c.divergence.new} new · ${c.cycle.total} cycles`,
      ...(c.divergence.new || c.cycle.new ? { tone: "bad" as const } : {}),
      note: `measured by the guard at ${measuredPhrase(s)}, ${c.examinedBetweenComponents} imports between components examined of ${c.edges}`,
    },
    {
      k: "change",
      v: p.source === "locked" ? "needs owner sudo" : "your own registry",
      note: p.source === "locked" ? "the registry entry is root-owned; a change goes through anvi's structure-lock.js" : "~/.claude/structure-guard.json: anything running as you can change it",
    },
  ];
  return rows;
}

export interface TrialRow {
  key: string;
  at: string;
  /** Component pairs the refused imports cross ("engine -> monaco"), or the rule when none is named. */
  edge: string;
  file: string;
  refusedBy: string;
  design: string | null;
  session: string;
  tool: string;
}

/**
 * The trial record's rows, one per refusal key, oldest first. A key seen twice (a forked or
 * resumed transcript repeats records; #189) is one refusal: it is counted once and the repeat is
 * reported in `merged`, never silently.
 */
export function trialRows(r: RefusalsResponse): { rows: TrialRow[]; merged: number } {
  if (r.status !== "measured") return { rows: [], merged: 0 };
  const seen = new Map<string, TrialRow>();
  let merged = 0;
  for (const x of r.refusals) {
    if (seen.has(x.key)) {
      merged++;
      continue;
    }
    const pairs = [...new Set(x.pairs.map((p) => p.pair))];
    seen.set(x.key, {
      key: x.key,
      at: x.at,
      edge: pairs.length ? pairs.join(", ") : x.violations.map((v) => v.rule).join(", ") || "?",
      file: x.file,
      refusedBy: x.refusedBy,
      design: x.design,
      session: x.session,
      tool: x.tool,
    });
  }
  return { rows: [...seen.values()].sort((a, b) => a.at.localeCompare(b.at)), merged };
}

/** Your calls on the rows, from the refusals answer's call states, updated by calls recorded since. */
export function callStates(r: RefusalsResponse, recorded: Record<string, CallVerdict> = {}): Record<string, RefusalCallState | { state: "called-now"; call: CallVerdict }> {
  const out: Record<string, RefusalCallState | { state: "called-now"; call: CallVerdict }> = {};
  if (r.status !== "measured") return out;
  for (const x of r.refusals) if (!(x.key in out)) out[x.key] = x.call;
  for (const [k, v] of Object.entries(recorded)) out[k] = { state: "called-now", call: v };
  return out;
}

export interface Tally {
  rows: number;
  right: number;
  wrong: number;
  none: number;
  unknown: number;
}

export function tally(rows: TrialRow[], states: ReturnType<typeof callStates>): Tally {
  const t: Tally = { rows: rows.length, right: 0, wrong: 0, none: 0, unknown: 0 };
  for (const row of rows) {
    const s = states[row.key];
    if (!s || s.state === "unknown") t.unknown++;
    else if (s.state === "none") t.none++;
    else {
      const v = s.state === "called-now" ? s.call : s.latest.call;
      if (v === "right") t.right++;
      else t.wrong++;
    }
  }
  return t;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "you called both right", "you called 1 of 3: 1 right", "no call yet on any of the 3". */
export function callsPhrase(t: Tally): string {
  const called = t.right + t.wrong;
  const unk = t.unknown ? ` · ${t.unknown} could not be read (a call you made may not show)` : "";
  if (!t.rows) return "nothing to call";
  if (!called) return `no call yet on ${t.rows === 1 ? "it" : `any of the ${t.rows}`}${unk}`;
  if (called === t.rows && (t.right === t.rows || t.wrong === t.rows)) {
    const v = t.right ? "right" : "wrong";
    return `you called ${t.rows === 1 ? "it" : t.rows === 2 ? "both" : `all ${t.rows}`} ${v}${unk}`;
  }
  return `you called ${called} of ${t.rows}: ${t.right} right, ${t.wrong} wrong${unk}`;
}

/**
 * The trial record's summary line: chances, blocked, missed (from the instrument's exposure),
 * and your calls. The population is always named, so a zero reads "0 of N edits", never bare.
 */
export function trialSummary(r: RefusalsResponse, t: Tally, merged: number): { line: string; population: string } | { gap: string } {
  if (r.status === "measuring") return { gap: `anvi's structure-refusals.js is reading the transcripts (started ${r.startedAt.slice(0, 16).replace("T", " ")} UTC, window from ${day(r.window.since)}); the trial record shows when it finishes.` };
  if (r.status === "no-design") return { gap: `No trial record: ${r.reason}` };
  if (r.status === "not-measured") return { gap: `structure-refusals.js could not measure: ${r.reason}` };
  if (r.status === "unreadable") return { gap: `The trial record could not be read: ${r.reason}` };
  const e = r.exposure as { chances?: unknown; missed?: unknown; possible?: unknown } | null;
  const num = (x: unknown) => (typeof x === "number" ? x : null);
  const chances = num(e?.chances);
  const missed = num(e?.missed);
  const parts = [
    chances === null ? "chances not computed" : plural(chances, "chance"),
    `${t.rows} blocked`,
    ...(missed === null ? [] : [`${missed} missed`]),
    callsPhrase(t),
  ];
  const population =
    `${t.rows} of ${r.totals.edits.toLocaleString("en-US")} edits to ${r.package.split("/").slice(-2).join("/")} refused, in ${plural(r.totals.sessions, "session")} since ${day(r.window.since)}` +
    ` (anvi's structure-refusals.js, run ${r.instrument.ranAt.slice(0, 16).replace("T", " ")} UTC, ${plural(r.transcripts.read, "transcript")} read` +
    (r.transcripts.unreadable ? `, ${r.transcripts.unreadable} unreadable` : "") +
    ")" +
    (merged ? ` · ${plural(merged, "repeated row")} with the same key merged` : "");
  return { line: parts.join(" · "), population };
}

// ── Placed ─────────────────────────────────────────────────────────────────────────────────

export const NO_PLACEMENT =
  "No placement is in review: no source records one. The guard's registry holds, per package, a design, a baseline and the project's own check, and nothing about a proposed move.";

export const ASK_EMPTY = "Type a question first. Ask sends exactly what you type; the example in the empty box is never sent.";

/** The question Ask would send, or why there is none. Only what was typed counts: never a placeholder. */
export function askQuestion(typed: string): { ok: true; question: string } | { ok: false; why: string } {
  const q = typed.trim();
  return q ? { ok: true, question: q } : { ok: false, why: ASK_EMPTY };
}

/** The prompt "Ask before writing" sends. Shown in full before anything starts; the same string is sent. */
export function askPrompt(project: string, s: StructureMeasured, question: string): string {
  const q = question.trim();
  return [
    `A question about where new code goes in ${project}. Answer it; do not create, edit or delete any file, and do not commit.`,
    "",
    `Question: ${q}`,
    "",
    `The design in force for ${s.package.dir} is ${s.designId}: ${s.package.design}. It lists the components (with their folders and files) and the imports allowed between them. The rule breaks it still allows are in ${s.package.baseline}. anvi's structure guard (~/.claude/anvi/scripts/structure-guard.js) refuses an edit that adds any other import between components.`,
    "",
    `Read the code at ${s.measuredAt.ref} (${sha7(s.measuredAt.sha)}), not a feature branch. Answer with: the component and folder the new code belongs in; the modules it would import and the ones that would import it; and whether any of those imports is one the design does not allow. Name the files you read.`,
  ].join("\n");
}

// ── Consolidated ───────────────────────────────────────────────────────────────────────────

export const NO_FATALITY_SIGNALS =
  "Not shown: the prototype's table of the three fatality signals (error patterns at one boundary, an invariant spanning modules, a lifecycle crossing boundaries), each with a count and an over-threshold or approaching state. No reader counts them yet (#210). What is shown instead: the guard's held breaks by pair, and the boundaries whose catalogue heading says the test tripped.";

export interface Cluster {
  where: string;
  count: number;
}

/** Rule breaks the guard holds, by component pair, most first (the guard's own byPair). */
export function pairClusters(s: StructureMeasured): Cluster[] {
  return [...s.byPair].sort((a, b) => b.count - a.count || a.pair.localeCompare(b.pair)).map((p) => ({ where: p.pair.replace(" -> ", " → "), count: p.count }));
}

export interface BoundaryCluster {
  id: string;
  name: string;
  /** What the heading says the fatality test counted ("6 patterns"), or null when it names no number. */
  stated: string | null;
  /** The first date the heading names, or null. */
  date: string | null;
}

/** Boundaries whose catalogue entry says the fatality test tripped, with what the heading itself states. */
export function boundaryClusters(bs: BoundaryInfo[]): BoundaryCluster[] {
  return bs
    .filter((b) => b.fatality)
    .map((b) => {
      const n = /fatality test TRIPPED:\s*(\d+\+?\s*(?:patterns?|instances?))/i.exec(b.name);
      const d = /\d{4}-\d{2}-\d{2}/.exec(b.name);
      const name = b.name.replace(/^[—\s-]+/, "").split(/ — |\s+\(/)[0].trim();
      return { id: b.id, name: name || b.name, stated: n ? n[1].replace(/\s+/g, " ") : null, date: d ? d[0] : null };
    });
}

/** The pair whose curve is drawn: the one with the most held breaks among those with enough fixes to say. */
export function headlinePair(cost: FixCostAnswer): PairCost | null {
  if (cost.status !== "measured") return null;
  return cost.pairs.filter((p) => p.trend !== "too few").sort((a, b) => b.held - a.held)[0] ?? null;
}

/** A pair's series, in words: "6 fixes, 2026-04-18 → 2026-11-05: 6, 9, 8, 7, 17, 9 files". */
export function seriesPhrase(p: PairCost): string {
  if (!p.fixes.length) return "no fix touched both sides";
  return `${plural(p.fixes.length, "fix", "fixes")}, ${day(p.fixes[0].date)} → ${day(p.fixes[p.fixes.length - 1].date)}: ${p.fixes.map((f) => f.files).join(", ")} files`;
}

/** Why the cost curve cannot be drawn, or null when it can. */
export function costGap(cost: FixCostAnswer | null, error: string | null): string | null {
  if (error) return `The cost curve could not be measured: ${error}.`;
  if (!cost) return null;
  if (cost.status !== "measured") return `The cost curve cannot be measured: ${cost.reason}.`;
  if (!cost.pairs.length) return "The cost curve cannot be measured: the guard holds no rule break, so there is no pair whose fixes to follow.";
  if (!headlinePair(cost)) return `The cost curve cannot be measured: no pair has the 3 fixes it takes to say which way the cost moves (${cost.pairs.map((p) => `${p.pair}: ${plural(p.fixes.length, "fix", "fixes")}`).join("; ")}).`;
  return null;
}

/** SVG geometry for a files-per-fix series: points within a w × h box with a left/bottom margin. */
export function curveGeometry(files: number[], w = 320, h = 120, m = { l: 30, r: 12, t: 12, b: 20 }) {
  const max = Math.max(1, ...files);
  const xs = files.map((_, i) => (files.length === 1 ? m.l : m.l + (i * (w - m.l - m.r)) / (files.length - 1)));
  const ys = files.map((f) => h - m.b - (f / max) * (h - m.t - m.b));
  const d = xs.map((x, i) => `${i ? "L" : "M"}${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(" ");
  return { max, xs, ys, d, base: h - m.b, top: m.t };
}

// ── Path to target ─────────────────────────────────────────────────────────────────────────

export const NO_MOVES_SOURCE =
  "No source lists the moves from today's structure to the declared design: no registry, design file or reader records a move with an issue for it. What is measured is the distance: the rule breaks the baseline still allows, below.";

export interface HeldGroup {
  pair: string;
  imports: { from: string; to: string }[];
}

/** The rule breaks the baseline holds today, grouped by pair (most first): what stands between today and the design. */
export function heldGroups(s: StructureMeasured): HeldGroup[] {
  const g = new Map<string, HeldGroup>();
  for (const e of s.edges) {
    if (e.class !== "grandfathered") continue;
    const k = (e.pair ?? `${e.fromComponent} -> ${e.toComponent}`).replace(" -> ", " → ");
    if (!g.has(k)) g.set(k, { pair: k, imports: [] });
    g.get(k)!.imports.push({ from: e.from, to: e.to });
  }
  return [...g.values()].sort((a, b) => b.imports.length - a.imports.length || a.pair.localeCompare(b.pair));
}

// ── System flows ───────────────────────────────────────────────────────────────────────────

export interface FlowNode {
  id: "call" | "hooks" | "guard" | "lands" | "refusal" | "ruling";
  label: string;
  /** What joins this step to the next: "→" then, "with" at the same time, "or" one or the other; null on the last. */
  next: "→" | "with" | "or" | null;
  /** What the step is: a fixed description, the same for every project. */
  what: string;
  /** A measured figure for this step, or null when nothing here measures it. */
  figure: string | null;
  /** Where the figure (or the step's registration) was read. */
  source: string;
}

export function flowNodes(r: RefusalsResponse | null, hooks: EditHooksAnswer | null, t: Tally | null): FlowNode[] {
  const m = r && r.status === "measured" ? r : null;
  const win = m ? `structure-refusals.js, since ${day(m.window.since)}` : r ? `structure-refusals.js: ${r.status === "measuring" ? "still reading" : "not measured"}` : "structure-refusals.js: not read yet";
  const others = hooks ? [...new Set(hooks.hooks.map((h) => h.name).filter((n) => n !== GUARD_HOOK))] : [];
  const reg = hooks ? guardRegistration(hooks) : null;
  const count = (st: string) => (hooks ? hooks.files.filter((f) => f.status === st).length : 0);
  const settings = hooks
    ? `PreToolUse on edits in ${plural(hooks.files.length, "settings file")} (${count("read")} read, ${count("absent")} absent, ${count("unreadable")} unreadable; each named under the flow), read ${hooks.readAt.slice(0, 16).replace("T", " ")} UTC; plugin and frontmatter hooks are not read`
    : "settings not read yet";
  return [
    { id: "call", label: "Agent tool call", next: "→", what: "Write, Edit or MultiEdit on a file in the package", figure: m ? `${m.totals.edits.toLocaleString("en-US")} edits in ${plural(m.totals.sessions, "session")}` : null, source: win },
    {
      id: "hooks",
      label: "Other edit hooks",
      next: "with",
      // Claude Code starts every matching hook at once; none of them runs "before" the guard.
      what: "the other hooks registered for edits, started together with the guard, not before it; some are guards of their own, and the catalogue injector adds the entries for the file",
      figure: hooks ? (others.length ? others.join(" · ") : "no other hook is registered for edits") : null,
      source: `${settings}. Claude Code runs matching hooks in parallel (its hooks reference); what they delivered is not counted here`,
    },
    {
      id: "guard",
      label: "Guard decides",
      next: "→",
      what: "structure-guard-hook.js judges the edit's imports against the design and the baseline",
      figure:
        reg === "not-found" ? "structure-guard-hook.js not found in the settings read"
        : reg === "unknown" && !m ? "whether structure-guard-hook.js is registered is unknown"
        : m ? `${m.totals.refused} refused · ${m.totals.deniedOtherwise} denied by something else · ${m.totals.erroredOtherwise} errored` : null,
      source: reg === "not-found" || (reg === "unknown" && !m) ? settings : win,
    },
    { id: "lands", label: "Edit lands", next: "or", what: "the edit is applied", figure: m ? `${m.totals.applied.toLocaleString("en-US")} applied` : null, source: win },
    { id: "refusal", label: "Refusal card", next: "→", what: "the agent reads the guard's reason; the card shows it on Agents and here", figure: t ? plural(t.rows, "refusal") : null, source: win },
    { id: "ruling", label: "Your ruling", next: null, what: "you call each refusal right or wrong", figure: t ? `${t.right + t.wrong} of ${t.rows} called` : null, source: "calls.jsonl in AnviDeck's own folder" },
  ];
}
