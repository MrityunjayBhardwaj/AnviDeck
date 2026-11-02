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
   * reading: nothing failed, but some source was still being read when Home answered (#61).
   */
  state: "loading" | "failed" | "ok" | "partial" | "reading";
  n: number;
  /** Agents blocked on you right now (a subset of n). */
  waiting: number;
  /** Rows that could not be checked, plus sources that did not fully answer. Never part of n. */
  unread: number;
  /** Rows and sources still being read. Never part of n, never counted as unread. */
  reading: number;
  live: number;
  busy: number;
}

export function needsCount(home: HomeResponse | null, failed = false): NeedsCount {
  if (!home) return { state: failed ? "failed" : "loading", n: 0, waiting: 0, unread: 0, reading: 0, live: 0, busy: 0 };
  const sources = Object.values(home.sources);
  const badSources = sources.filter((s) => s.status === "could-not-read" || s.status === "partial" || s.status === "not-measured").length;
  const unread = home.unread.filter((u) => !u.reading).length + badSources;
  const reading = home.unread.filter((u) => u.reading).length + sources.filter((s) => s.status === "reading").length;
  return {
    state: unread ? "partial" : reading ? "reading" : "ok",
    n: home.queue.length,
    waiting: home.queue.filter((q) => q.kind === "agent-waiting").length,
    unread,
    reading,
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
  // A partial answer must not open with "Nothing needs you": that is the all-clear.
  if (c.state === "partial")
    return c.n === 0
      ? "Nothing found so far, but some sources could not be read"
      : `${plural(c.n, "thing needs", "things need")} you, and some sources could not be read`;
  // Still reading is not the all-clear either, and not a failure.
  if (c.state === "reading")
    return c.n === 0
      ? "Nothing found so far; still reading some sources"
      : `${plural(c.n, "thing needs", "things need")} you so far; still reading some sources`;
  return c.n === 0 ? "Nothing needs you" : `${plural(c.n, "thing needs", "things need")} you`;
}

/** The sidebar badge: the same n, "…" while loading, "?" appended when a source could not be read, "…" when one is still being read. */
export function badgeText(c: NeedsCount): string {
  if (c.state === "loading") return "…";
  if (c.state === "failed") return "?";
  return c.state === "partial" ? `${c.n}?` : c.state === "reading" ? `${c.n}…` : String(c.n);
}

/** The live strip in the header. */
export function stripText(c: NeedsCount): string {
  if (c.state === "loading") return "checking agents…";
  if (c.state === "failed") return "could not read agents";
  return `${plural(c.live, "agent", "agents")} · ${c.busy} working · ${c.waiting} waiting on you · ${badgeText(c)} need${c.n === 1 ? "s" : ""} you`;
}
