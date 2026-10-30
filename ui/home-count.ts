import type { HomeResponse } from "../shared/home-types";

/**
 * The ONE count of things that need you (#18). The Home headline, the sidebar badge and the
 * live strip all read this object; none of them counts the queue on its own, so they cannot
 * disagree. tests/home.test.ts checks both the numbers and that no other UI file counts the queue.
 */
export interface NeedsCount {
  /**
   * loading: not answered yet. failed: /api/home itself could not be read.
   * ok: every source read. partial: some source could not be read.
   */
  state: "loading" | "failed" | "ok" | "partial";
  n: number;
  /** Agents blocked on you right now (a subset of n). */
  waiting: number;
  /** Rows that could not be checked, plus sources that did not fully answer. Never part of n. */
  unread: number;
  live: number;
  busy: number;
}

export function needsCount(home: HomeResponse | null, failed = false): NeedsCount {
  if (!home) return { state: failed ? "failed" : "loading", n: 0, waiting: 0, unread: 0, live: 0, busy: 0 };
  const badSources = Object.values(home.sources).filter(
    (s) => s.status === "could-not-read" || s.status === "partial" || s.status === "not-measured"
  ).length;
  const unread = home.unread.length + badSources;
  return {
    state: unread ? "partial" : "ok",
    n: home.queue.length,
    waiting: home.queue.filter((q) => q.kind === "agent-waiting").length,
    unread,
    live: home.agents.length,
    busy: home.agents.filter((a) => a.status === "busy").length,
  };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The Home headline. */
export function headlineText(c: NeedsCount): string {
  if (c.state === "loading") return "Checking what needs you…";
  if (c.state === "failed") return "Could not read what needs you";
  const base = c.n === 0 ? "Nothing needs you" : `${plural(c.n, "thing needs", "things need")} you`;
  return c.state === "partial" ? `${base} (some sources could not be read)` : base;
}

/** The sidebar badge: the same n, "…" while loading, "?" appended when a source could not be read. */
export function badgeText(c: NeedsCount): string {
  if (c.state === "loading") return "…";
  if (c.state === "failed") return "?";
  return c.state === "partial" ? `${c.n}?` : String(c.n);
}

/** The live strip in the header. */
export function stripText(c: NeedsCount): string {
  if (c.state === "loading") return "checking agents…";
  if (c.state === "failed") return "could not read agents";
  return `${plural(c.live, "agent", "agents")} · ${c.busy} working · ${c.waiting} waiting on you · ${c.n} need${c.n === 1 ? "s" : ""} you`;
}
