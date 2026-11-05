/**
 * Notes (#89): the rules behind the screen, pure so tests read them directly. NotesScreen.ts
 * only builds the DOM from these.
 *
 * Where each figure comes from:
 *   - entries, titles, REF:        AnviDeck's catalogue parser (GET /api/project/:name)
 *   - out of date, freshness:      anvi's `currency-report.js --json` (GET /api/notes/currency),
 *                                  counted exactly as its summary line counts them
 *                                  (🟡 drifted + 🔴 dangling, of the entries it examined)
 *   - the series:                  the fleet snapshots, health-<date>.json (dates UTC)
 *   - uses / 30d:                  the injector's log, /tmp/anvi-hook-<sid>.log (GET /api/notes/usage)
 *   - which catalogue, when:       the routing table in ~/.claude/CLAUDE.md (GET /api/routing-architecture)
 */
import type { CurrencyAnswer, CurrencyEntry, GtCheckAnswer, SnapshotSeries, UsageAnswer } from "../../shared/notes-types";
import type { CatalogueEntry, EntryDates, GroundTruthDoc, MemoryEntry } from "../../shared/types";

export const KINDS = [
  { cat: "hetvabhasa", label: "Error patterns" },
  { cat: "vyapti", label: "Invariants" },
  { cat: "krama", label: "Lifecycles" },
  { cat: "dharana", label: "Focus map" },
] as const;

export const key = (cat: string, id: string) => `${cat}/${id}`;

/** Out of date as anvi's report counts it: 🟡 + 🔴 of the entries it examined. null until it has run. */
export function outOfDate(c: CurrencyAnswer | null): { n: number; of: number; yellow: number; red: number } | null {
  if (!c || c.state !== "ok" || !c.counts || c.examined === undefined) return null;
  return { n: c.counts.YELLOW + c.counts.RED, of: c.examined, yellow: c.counts.YELLOW, red: c.counts.RED };
}

export const isOutOfDate = (v: Pick<CurrencyEntry, "status">) => v.status === "YELLOW" || v.status === "RED";

/** "catalogue/ID" → anvi's verdict. The report repeats nothing per ID, but the first wins if it did. */
export function verdicts(c: CurrencyAnswer | null): Map<string, CurrencyEntry> {
  const m = new Map<string, CurrencyEntry>();
  for (const e of c?.state === "ok" ? c.entries ?? [] : []) if (!m.has(key(e.catalogue, e.id))) m.set(key(e.catalogue, e.id), e);
  return m;
}

/** What the screen says about one entry's freshness. Never blank: "not measured" says why. */
export function freshnessText(c: CurrencyAnswer | null, v: CurrencyEntry | undefined): string {
  if (!c || c.state === "measuring") return "currency: measuring";
  if (c.state !== "ok") return `currency: could not read`;
  if (!v) return "not in anvi's report";
  if (v.status === "RED") return "dangling";
  const state = v.state || v.status.toLowerCase();
  // anvi's summary counts every 🟡 as drifted, including entries it has never confirmed.
  return v.status === "YELLOW" && state !== "drifted" ? `${state} · out of date` : state;
}

export function entryNote(e: CatalogueEntry, c: CurrencyAnswer | null, v: CurrencyEntry | undefined): string {
  return `${e.grounded ? "grounded" : "ungrounded"} · ${freshnessText(c, v)}`;
}

/** Search: every word must appear in the ID, the title or the entry's text. */
export function matches(e: CatalogueEntry, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${e.id} ${e.title} ${e.ref ?? ""} ${Object.values(e.sections ?? {}).join(" ")}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * Per catalogue: how many entries anvi's report examined vs how many this screen lists, and the
 * IDs anvi counts that the list does not (e.g. a catalogue's universal U-entries, which the
 * parser skips). Only when the report has run.
 */
export function countGap(cat: string, listed: CatalogueEntry[], c: CurrencyAnswer | null): { anvi: number; missing: string[] } | null {
  if (c?.state !== "ok") return null;
  const ids = (c.entries ?? []).filter((e) => e.catalogue === cat).map((e) => e.id);
  const have = new Set(listed.map((e) => e.id));
  return { anvi: ids.length, missing: [...new Set(ids.filter((id) => !have.has(id)))] };
}

// ── Re-check a batch, by subsystem ────────────────────────────────────────────────────────

/** A file's subsystem: its folder, at most two levels deep ("server/readers", "hooks"); "(top level)" for a root file. */
export function folderOf(file: string): string {
  const parts = file.replace(/^\.\//, "").split("/").slice(0, -1);
  return parts.length ? parts.slice(0, 2).join("/") : "(top level)";
}

/** An entry's subsystem: the folder most of its drifted or gone files are in (ties: alphabetical). */
export function subsystemOf(v: CurrencyEntry): string {
  const files = [...v.drifted, ...(v.gone ?? [])];
  if (!files.length) return "(no file named)";
  const n = new Map<string, number>();
  for (const f of files) n.set(folderOf(f), (n.get(folderOf(f)) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
}

export interface Batch {
  subsystem: string;
  entries: CurrencyEntry[];
}

/** The most entries one Re-check agent is given; a larger subsystem is split into parts. */
export const BATCH_MAX = 25;

/**
 * Out-of-date entries grouped by subsystem, largest subsystem first. A subsystem with more than
 * BATCH_MAX entries becomes several batches ("hooks, part 2 of 6"), in the report's order.
 */
export function batches(c: CurrencyAnswer | null, max = BATCH_MAX): Batch[] {
  const by = new Map<string, CurrencyEntry[]>();
  for (const v of verdicts(c).values()) {
    if (!isOutOfDate(v)) continue;
    const s = subsystemOf(v);
    by.set(s, [...(by.get(s) ?? []), v]);
  }
  const groups = [...by.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const out: Batch[] = [];
  for (const [subsystem, entries] of groups) {
    const parts = Math.ceil(entries.length / max);
    for (let i = 0; i < parts; i++) {
      out.push({ subsystem: parts > 1 ? `${subsystem}, part ${i + 1} of ${parts}` : subsystem, entries: entries.slice(i * max, (i + 1) * max) });
    }
  }
  return out;
}

export const batchLabel = (b: Batch) =>
  `Re-check ${b.entries.length} out-of-date ${b.entries.length === 1 ? "note" : "notes"} about ${b.subsystem}`;

/** Why one entry is out of date, in the report's terms. */
export function whyOutOfDate(v: CurrencyEntry): string {
  const parts: string[] = [];
  if (v.drifted.length) parts.push(`changed since last checked: ${v.drifted.join(", ")}`);
  if (v.gone?.length) parts.push(`gone: ${v.gone.join(", ")}`);
  if (!parts.length) parts.push(v.state === "never confirmed" ? "never confirmed against the code it cites" : v.state || v.status);
  return parts.join("; ");
}

/**
 * The exact prompt a Re-check agent is given. Shown in full before anything starts; the same
 * string is what POST /api/agents receives.
 */
export function recheckPrompt(project: string, b: Batch, c: Pick<CurrencyAnswer, "command" | "ranAt">): string {
  return [
    `Re-check ${b.entries.length} out-of-date catalogue ${b.entries.length === 1 ? "entry" : "entries"} of ${project}, about ${b.subsystem}.`,
    "",
    `anvi's currency report (${c.command}, run ${c.ranAt ?? "?"}) marks them out of date:`,
    ...b.entries.map((v) => `- ${v.id} (${v.catalogue}.md): ${whyOutOfDate(v)}`),
    "",
    "For each entry, read the entry and the code it cites as it is now (the /anvi:currency skill says how to re-validate). Then do one of:",
    "- confirm it, if it still holds, and stamp it VALIDATED;",
    "- re-point its REF, if the code moved;",
    "- flag it for the owner's review, if the claim may no longer hold.",
    "Change only these entries. Do not merge anything.",
    "",
    "When done, say how many you confirmed, re-pointed and flagged, naming each entry.",
  ].join("\n");
}

// ── Memory, with Promote ──────────────────────────────────────────────────────────────────

/** Text in a memory note that says it recurred, quoted for the reader to judge; null when none. */
export function recurrenceHint(m: Pick<MemoryEntry, "content" | "description">): string | null {
  const text = `${m.description}\n${m.content}`;
  // Words anvi's promotion rule is about. "twice" alone is not one: "suite ran twice" is not a recurrence.
  const re = /[^.\n]*\b(recurr\w*|second time|seen again)\b[^.\n]*/i;
  const hit = re.exec(text);
  if (!hit) return null;
  const s = hit[0].trim().replace(/\s+/g, " ");
  return s.length > 140 ? `${s.slice(0, 137)}…` : s;
}

export const memoryFile = (m: Pick<MemoryEntry, "filePath">) => m.filePath.split("/").pop() ?? m.filePath;

/** The exact prompt a Promote agent is given (shown in full before anything starts). */
export function promotePrompt(project: string, m: Pick<MemoryEntry, "filePath" | "name" | "description">): string {
  return [
    `Consider promoting the project memory note ${memoryFile(m)} of ${project} ("${m.name}") to the focus map (.anvi/dharana.md).`,
    "",
    "anvi's rule for promotion: seen once, it stays in memory; seen again, it becomes a focus-map entry recording where it came from (ORIGIN), why it matters (WHY), how to check it (HOW) and its REF.",
    "",
    `Read ${m.filePath}. If what it records has recurred, add one focus-map entry for it with ORIGIN, WHY, HOW and REF, citing this memory note, and say what you added. If it has not recurred, change nothing and say why.`,
    "Do not edit or delete the memory note. Do not merge anything.",
  ].join("\n");
}

// ── Grounding ─────────────────────────────────────────────────────────────────────────────

/** Entries (any catalogue) whose text names `GROUND_TRUTH_<SYSTEM>`, per Ground Truth doc. */
export function citations(docs: Pick<GroundTruthDoc, "system">[], entries: CatalogueEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of docs) {
    const needle = `GROUND_TRUTH_${d.system}`.toUpperCase();
    // Whole name only: GROUND_TRUTH_GIT must not count GROUND_TRUTH_GIT_PLUMBING's citations.
    const re = new RegExp(`${needle}(?![A-Z0-9_])`);
    let n = 0;
    for (const e of entries) {
      const text = `${e.ref ?? ""}\n${Object.values(e.sections ?? {}).join("\n")}`.toUpperCase();
      if (re.test(text)) n++;
    }
    out.set(d.system, n);
  }
  return out;
}

/**
 * "Sections traced" for one doc, from anvi's citation check: sections that cite code, of all
 * its sections (preamble not counted), with the uncitable and missing ones named. Never "0" when
 * the check did not measure: then it says so.
 */
export function sectionsText(check: GtCheckAnswer | null, system: string): string {
  if (!check) return "checking…";
  if (check.state === "none" || check.state === "not-measured") return "not measured";
  const d = check.docs.find((x) => x.system === system);
  if (!d) return "not measured";
  const extra = [d.uncitable ? `${d.uncitable} say why not` : "", d.missing ? `${d.missing} missing` : ""].filter(Boolean).join(", ");
  return `${d.cited} of ${d.sections} cite code${extra ? ` (${extra})` : ""}`;
}

export const ageDays =(iso: string | Date, now: Date) => Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000));

// ── Which catalogue, when ─────────────────────────────────────────────────────────────────

export const WHEN_COLUMNS = ["hetvabhasa", "vyapti", "krama", "dharana", "ground-truth"] as const;
export type WhenColumn = (typeof WHEN_COLUMNS)[number];

/** Per activity in the routing table: which catalogues (and Ground Truth docs) it names. */
export function routingMatrix(routes: { activity: string; catalogues: string[]; other?: string[] }[]): { activity: string; named: Set<WhenColumn> }[] {
  return routes.map((r) => {
    const named = new Set<WhenColumn>();
    for (const c of r.catalogues) {
      const n = c.replace(/\.md$/, "");
      if ((WHEN_COLUMNS as readonly string[]).includes(n)) named.add(n as WhenColumn);
    }
    if ((r.other ?? []).some((o) => /GROUND_TRUTH/i.test(o))) named.add("ground-truth");
    return { activity: r.activity, named };
  });
}

// ── Freshness over time ───────────────────────────────────────────────────────────────────

export interface SeriesPoint {
  label: string;
  value: number;
  of: number;
  /** The live run (not a snapshot). */
  live: boolean;
}

/** The snapshots' out-of-date figures for this project, oldest first, then the live run's. */
export function seriesPoints(s: SnapshotSeries | null, c: CurrencyAnswer | null): SeriesPoint[] {
  const pts: SeriesPoint[] = (s?.points ?? []).map((p) => ({ label: p.date.slice(5), value: p.yellow + p.red, of: p.examined, live: false }));
  const o = outOfDate(c);
  if (o && c?.ranAt) pts.push({ label: `now`, value: o.n, of: o.of, live: true });
  return pts;
}

export interface UsedRow {
  catalogue: string;
  id: string;
  lastChanged: string | null;
  uses: number;
}

/**
 * Out-of-date entries the injector delivered in the window, the longest unchanged first
 * (entries with no known date last).
 */
export function oldestStillUsed(c: CurrencyAnswer | null, dates: EntryDates | null, usage: UsageAnswer | null, limit = 8): UsedRow[] {
  if (!usage || usage.status === "unreadable") return [];
  const rows: UsedRow[] = [];
  for (const v of verdicts(c).values()) {
    if (!isOutOfDate(v)) continue;
    const uses = usage.uses[key(v.catalogue, v.id)] ?? 0;
    if (!uses) continue;
    rows.push({ catalogue: v.catalogue, id: v.id, lastChanged: dates?.[v.catalogue]?.[v.id]?.lastModified ?? null, uses });
  }
  return rows
    .sort((a, b) => (a.lastChanged ?? "￿").localeCompare(b.lastChanged ?? "￿") || b.uses - a.uses || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/** The header's "N notes · P% backed by source". Backed by source = a REF that is not UNGROUNDED. */
export function headerCounts(entries: CatalogueEntry[], grounding: { totalEntries: number; groundedEntries: number } | null): { notes: number; backedPct: number | null; backed: number; of: number } {
  const of = grounding?.totalEntries ?? 0;
  const backed = grounding?.groundedEntries ?? 0;
  return { notes: entries.length, backed, of, backedPct: of ? Math.round((backed / of) * 100) : null };
}
