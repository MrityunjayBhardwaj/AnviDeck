/**
 * History (#90): the rules of the screen, without DOM, so tests read them directly.
 *
 * The timeline has a row per lane and a column per local day. A cell's number is the lanes'
 * own per-day count from the server (counted over every event, not only those sent), so a cell
 * never shows fewer than happened; when fewer events were sent than counted, the moment's list
 * says "showing N of M". A lane that could not be read is drawn as such, never as an empty row.
 */
import type {
  CodeCompare,
  HistoryEvent,
  HistoryKind,
  HistoryResponse,
  KnowledgeCompare,
  LaneRead,
  Side,
} from "../../shared/history-types";
import type { StructureProjectResponse } from "../../shared/structure-types";

export interface Row {
  key: string;
  label: string;
  color: string;
  kinds: HistoryKind[];
}

/** The prototype's lanes, in its order, for the kinds that have a source today. */
export const ROWS: readonly Row[] = [
  { key: "agents", label: "Agent turns", color: "#5aa9f5", kinds: ["turn"] },
  { key: "edits", label: "Edits", color: "#9aa4b8", kinds: ["edit"] },
  { key: "refusals", label: "Refusals & rulings", color: "#f2645a", kinds: ["refusal", "ruling"] },
  { key: "commits", label: "Commits", color: "#3ccf91", kinds: ["commit"] },
  { key: "knowledge", label: "Catalogue changes", color: "#c792ea", kinds: ["catalogue"] },
  { key: "actions", label: "AnviDeck actions", color: "#f2b84b", kinds: ["action"] },
];

export const KIND_LABEL: Record<HistoryKind, string> = {
  turn: "agent turn",
  edit: "edit",
  refusal: "refusal",
  ruling: "your call",
  commit: "commit",
  catalogue: "catalogue change",
  action: "AnviDeck action",
};

export const DEFAULT_DAYS = 14;

// ── days and the window ────────────────────────────────────────────────────────────────────

/** "YYYY-MM-DD" of a Date in the page's own time zone. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The instant a local day starts ("YYYY-MM-DD" at 00:00 here), as UTC ISO. */
export function dayStart(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toISOString();
}

/** The instant after a local day ends. */
export function dayEnd(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d + 1).toISOString();
}

export const isDay = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** The window from the URL (?from=&to=, local days, both included), else the last DEFAULT_DAYS days. */
export function windowDays(params: URLSearchParams, today: Date = new Date()): { from: string; to: string } {
  const to = isDay(params.get("to")) ? params.get("to")! : localDay(today);
  const [y, m, d] = to.split("-").map(Number);
  const dflt = localDay(new Date(y, m - 1, d - (DEFAULT_DAYS - 1)));
  const from = isDay(params.get("from")) && params.get("from")! <= to ? params.get("from")! : dflt;
  return { from, to };
}

/** Every local day from `from` to `to`, both included. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const [y, m, d] = from.split("-").map(Number);
  for (let i = 0; ; i++) {
    const day = localDay(new Date(y, m - 1, d + i));
    if (day > to || i > 400) break;
    out.push(day);
  }
  return out;
}

/** The query for GET /api/history: the window's instants and the page's time zone (minutes east of UTC). */
export function historyQuery(project: string, from: string, to: string, now: Date = new Date()): string {
  const q = new URLSearchParams({ project, since: dayStart(from), until: dayEnd(to), tz: String(-now.getTimezoneOffset()) });
  return `/api/history?${q}`;
}

// ── cells and the selected moment ──────────────────────────────────────────────────────────

export type CellState = "ok" | "unreadable" | "partial" | "measuring" | "not-available";

/** A row's state: the worst of its lanes' (a row of two lanes is not "ok" if one could not be read). */
export function rowState(res: HistoryResponse, row: Row): CellState {
  const sts = row.kinds.map((k) => res.lanes[k].status);
  for (const s of ["unreadable", "measuring", "partial", "not-available"] as const) if (sts.includes(s)) return s;
  return "ok";
}

/** The count in one cell: the lanes' own per-day counts (over every event, not only those sent). */
export function cellCount(res: HistoryResponse, row: Row, day: string): number {
  return row.kinds.reduce((n, k) => n + (res.lanes[k].perDay[day] ?? 0), 0);
}

export function eventDay(e: HistoryEvent, tzMinutes: number): string {
  return new Date(Date.parse(e.at) + tzMinutes * 60_000).toISOString().slice(0, 10);
}

/** The events sent for one cell, oldest first, and how many happened there. */
export function cellEvents(res: HistoryResponse, row: Row, day: string): { events: HistoryEvent[]; total: number } {
  const events = res.events.filter((e) => row.kinds.includes(e.kind) && eventDay(e, res.window.tzMinutes) === day);
  return { events, total: cellCount(res, row, day) };
}

/** "3 events" or "showing 400 of 1,203 — open this day to see the rest". */
export function showingLine(shown: number, total: number): string {
  const n = (x: number) => x.toLocaleString("en-US");
  if (shown >= total) return `${n(total)} event${total === 1 ? "" : "s"}`;
  return `showing ${n(shown)} of ${n(total)} — the newest are kept; open this day alone to see more`;
}

/** What a row's label says beside it when it is not simply read: never a bare 0. */
export function rowNote(res: HistoryResponse, row: Row): string | null {
  const notes = row.kinds
    .map((k) => res.lanes[k])
    .filter((l) => l.status !== "ok" && l.status !== "none")
    .map((l) => `${KIND_LABEL[l.kind]}s: ${laneStatusWord(l)}`);
  return notes.length ? notes.join(" · ") : null;
}

export function laneStatusWord(l: LaneRead): string {
  switch (l.status) {
    case "unreadable":
      return "could not be read";
    case "measuring":
      return "still being measured";
    case "partial":
      return `partly read: at least ${l.total.toLocaleString("en-US")}`;
    case "not-available":
      return "no source for this project";
    case "none":
      return "none in this window";
    default:
      return `${l.total.toLocaleString("en-US")} in this window`;
  }
}

/** The sources footer: one line per lane, with its source, state and "showing N of M". */
export function sourceLines(res: HistoryResponse): string[] {
  return (Object.values(res.lanes) as LaneRead[]).map((l) => {
    const count = l.shown < l.total ? ` · showing ${fmt(l.shown)} of ${fmt(l.total)}` : "";
    return `${KIND_LABEL[l.kind]}s — ${laneStatusWord(l)}${count} · ${l.source}${l.detail ? ` · ${l.detail}` : ""}`;
  });
}

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * The status line's count: every lane's total, and "at least" with the lanes that are not
 * whole (still measuring, partly read, unreadable, no source), so a missing lane never makes
 * the sum read as complete.
 */
export function totalLine(res: HistoryResponse): string {
  const ls = Object.values(res.lanes) as LaneRead[];
  const total = ls.reduce((n, l) => n + l.total, 0);
  const missing = ls.filter((l) => l.status !== "ok" && l.status !== "none" && l.status !== "not-available");
  if (!missing.length) return `${fmt(total)} events`;
  return `at least ${fmt(total)} events (${missing.map((l) => `${KIND_LABEL[l.kind]}s ${laneStatusWord(l)}`).join(", ")})`;
}

/** Ask again while the refusals instrument is running. */
export const shouldPoll = (res: HistoryResponse | null) => !!res && res.lanes.refusal.status === "measuring";

// ── one event ──────────────────────────────────────────────────────────────────────────────

export const short = (sha: string) => sha.slice(0, 7);

export function eventTitle(e: HistoryEvent): string {
  switch (e.kind) {
    case "turn":
      return e.prompt || "(a prompt with no text)";
    case "edit":
      return `${e.tool} ${e.file}`;
    case "refusal":
      return `blocked ${e.tool} ${e.file}${e.pairs.length ? ` · ${e.pairs.join(", ")}` : ""}`;
    case "ruling":
      return `your call: ${e.call}${e.refusal?.file ? ` on ${e.refusal.file}` : ""}${e.superseded ? " (a later call replaced it)" : ""}`;
    case "commit":
      return `${short(e.sha)} ${e.subject}`;
    case "catalogue":
      return `${short(e.sha)} ${e.subject}`;
    case "action":
      return `${e.method} ${e.path} · ${e.result}`;
  }
}

/** A short local time "10-22 16:16". */
export function stamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The replay of a session, around a time, in the Agents screen's replay view. */
export function replayHash(project: string, session: string, from?: string, to?: string): string {
  const q = new URLSearchParams({ project, sid: session });
  if (from) q.set("from", from);
  if (to) q.set("to", to);
  return `#agents?${q}`;
}

/** The same session replayed on the Map. */
export function mapReplayHash(project: string, session: string): string {
  return `#map?${new URLSearchParams({ project, session })}`;
}

/** A replay window around one moment: 10 minutes before to 10 minutes after. */
export function around(at: string): { from: string; to: string } {
  const t = Date.parse(at);
  return { from: new Date(t - 10 * 60_000).toISOString(), to: new Date(t + 10 * 60_000).toISOString() };
}

/** The session an event belongs to, when it has one. */
export function sessionOf(e: HistoryEvent): string | null {
  if (e.kind === "turn" || e.kind === "edit" || e.kind === "refusal") return e.session;
  if (e.kind === "ruling") return e.refusal?.session ?? null;
  return null;
}

// ── compare two points ─────────────────────────────────────────────────────────────────────

/** A compare point is the end of a local day: the state "as of that day". */
export const pointOf = (day: string) => dayEnd(day);

export function codeLine(c: Side<CodeCompare>): string {
  if (!c.ok) return `code: not compared — ${c.reason}`;
  const v = c.value;
  if (!v.a || !v.b) return `code: ${!v.b ? "no commit on " + v.ref + " by the later point" : "no commit on " + v.ref + " by the earlier point"}`;
  if (v.a.sha === v.b.sha) return `code: no commit between (${short(v.a.sha)} at both)`;
  return `code: ${v.commits} commit${v.commits === 1 ? "" : "s"} on ${v.ref} (${short(v.a.sha)} → ${short(v.b.sha)})${v.shortstat ? ` · ${v.shortstat}` : ""}`;
}

const CATALOGUE_NAME: Record<string, string> = { "hetvabhasa.md": "error patterns", "vyapti.md": "invariants", "krama.md": "lifecycles", "dharana.md": "focus map" };

export function knowledgeLine(k: Side<KnowledgeCompare>): string {
  if (!k.ok) return `knowledge: not compared — ${k.reason}`;
  const v = k.value;
  if (!v.b) return "knowledge: the catalogues have no commit by the later point";
  const parts = v.files
    .filter((f) => f.added.length || f.removed.length || f.changed.length)
    .map((f) => {
      const bits = [f.added.length && `+${f.added.length}`, f.removed.length && `−${f.removed.length}`, f.changed.length && `${f.changed.length} changed`].filter(Boolean);
      return `${CATALOGUE_NAME[f.file] ?? f.file} ${bits.join(" ")}`;
    });
  return `knowledge: ${v.commits} catalogue commit${v.commits === 1 ? "" : "s"}${parts.length ? ` · ${parts.join(", ")}` : " · no entry added, removed or changed"}`;
}

export type DesignSide = { state: "loading" } | { state: "error"; reason: string } | { state: "done"; value: StructureProjectResponse };

/** The design at the two commits, as the structure guard measured each. */
export function designLine(a: DesignSide, b: DesignSide): string {
  if (a.state === "loading" || b.state === "loading") return "design: measuring with the structure guard at both commits…";
  if (a.state === "error") return `design: not compared — the earlier commit could not be measured (${a.reason})`;
  if (b.state === "error") return `design: not compared — the later commit could not be measured (${b.reason})`;
  const x = a.value;
  const y = b.value;
  if (x.status === "no-design" || y.status === "no-design") return "design: not compared — the project has no design registered with the structure guard";
  if (x.status !== "measured") return `design: not compared — at the earlier commit: ${x.reason}`;
  if (y.status !== "measured") return `design: not compared — at the later commit: ${y.reason}`;
  const ver = x.designId === y.designId ? `1 version (${x.designId})` : `${x.designId} → ${y.designId}`;
  const nd = (r: typeof x) => r.counts.divergence.new + r.counts.cycle.new;
  return `design: ${ver} · imports breaking it (new, not grandfathered) ${nd(x)} → ${nd(y)} · modules ${x.counts.modules} → ${y.counts.modules}`;
}

/** The two commits the design is measured at: the code compare's, else none. */
export function designShas(c: Side<CodeCompare> | null): { a: string; b: string } | null {
  if (!c || !c.ok || !c.value.a || !c.value.b) return null;
  return { a: c.value.a.sha, b: c.value.b.sha };
}
