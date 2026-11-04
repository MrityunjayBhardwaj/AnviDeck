import type { ProjectSummary, ProjectState, MemoryEntry, TimelinePoint, HookLogSession, CrossProjectData, RoutingArchitecture, BrainFlowEvent, GitHubTrace, LiveSession, EntryDates, EntryDatesRead } from "../shared/types";

import type { HomeResponse } from "../shared/home-types";

const BASE = "/api";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    // Keep the server's own words (e.g. git's stderr), not just the status code.
    const body = await res.json().catch(() => null) as { error?: string; errors?: string[] } | null;
    const why = body?.error ? `${body.error}${body.errors?.length ? `: ${body.errors.join("; ")}` : ""}` : res.statusText;
    throw new Error(`API error: ${res.status} ${why}`);
  }
  return res.json();
}

/**
 * One /entry-dates answer (#34): "ready" (200), "pending" (202, some
 * catalogues are still being read from git; ask again) or "failed" (503, git
 * could not answer). Anything else throws, so a dropped or garbled answer is
 * an error, never an empty set of dates.
 */
async function entryDatesRead(name: string): Promise<EntryDatesRead> {
  const res = await fetch(`${BASE}/project/${encodeURIComponent(name)}/entry-dates`);
  const body = (await res.json().catch(() => null)) as any;
  if (res.status === 200 && body && typeof body === "object" && !("error" in body)) return { status: "ready", dates: body };
  if (res.status === 202 && body?.status === "pending") return body;
  if (res.status === 503 && body?.status === "failed") return body;
  throw new Error(`API error: ${res.status} ${body?.error ?? (res.statusText || "no readable answer")}`);
}

/**
 * Every catalogue's dates: asks again while the server is still reading, and
 * throws when git could not answer. The server stops a git read that runs too
 * long, so this ends.
 */
async function entryDatesComplete(name: string, everyMs = 1000): Promise<EntryDates> {
  for (;;) {
    const r = await entryDatesRead(name);
    if (r.status === "ready") return r.dates;
    if (r.status === "failed") throw new Error(`entry dates could not be read: ${r.error}`);
    await new Promise((ok) => setTimeout(ok, everyMs));
  }
}

export const api = {
  projects: () => get<ProjectSummary[]>("/projects"),
  project: (name: string) => get<ProjectState>(`/project/${encodeURIComponent(name)}`),
  projectCatalogues: (name: string) => get<ProjectState["catalogues"]>(`/project/${encodeURIComponent(name)}/catalogues`),
  projectMemory: (name: string) => get<MemoryEntry[]>(`/project/${encodeURIComponent(name)}/memory`),
  globalMemory: () => get<MemoryEntry[]>("/memory"),
  timeline: (limit = 100, offset = 0) => get<TimelinePoint[]>(`/timeline?limit=${limit}&offset=${offset}`),
  diff: (from: string, to: string) => get<{ from: string; to: string; diff: string }>(`/diff/${from}/${to}`),
  stateAt: (hash: string, file: string) => get<{ hash: string; file: string; content: string }>(`/state-at/${hash}?file=${encodeURIComponent(file)}`),
  hookLogs: () => get<{ sessions: HookLogSession[] }>("/hook-logs"),
  crossProject: () => get<CrossProjectData>("/cross-project"),
  sessions: () => get<LiveSession[]>("/sessions"),
  home: () => get<HomeResponse>("/home"),
  routingArchitecture: () => get<RoutingArchitecture>("/routing-architecture"),
  entryDatesRead,
  githubTrace: (name: string, refresh = false) =>
    get<GitHubTrace>(`/project/${encodeURIComponent(name)}/github-trace${refresh ? "?refresh=1" : ""}`),
  brainData: async (name: string) => {
    const [project, dates, hookLogs] = await Promise.all([
      get<ProjectState>(`/project/${encodeURIComponent(name)}`),
      entryDatesComplete(name),
      get<{ sessions: HookLogSession[] }>("/hook-logs"),
    ]);
    return { project, dates, hookLogs };
  },
};
