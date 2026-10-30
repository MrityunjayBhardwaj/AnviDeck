import type { ProjectSummary, ProjectState, MemoryEntry, TimelinePoint, HookLogSession, CrossProjectData, RoutingArchitecture, BrainFlowEvent, GitHubTrace, LiveSession, EntryDate } from "../shared/types";

import type { HomeResponse } from "../shared/home-types";

const BASE = "/api";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
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
  entryDates: (name: string) => get<Record<string, EntryDate>>(`/project/${encodeURIComponent(name)}/entry-dates`),
  githubTrace: (name: string, refresh = false) =>
    get<GitHubTrace>(`/project/${encodeURIComponent(name)}/github-trace${refresh ? "?refresh=1" : ""}`),
  brainData: async (name: string) => {
    const [project, dates, hookLogs] = await Promise.all([
      get<ProjectState>(`/project/${encodeURIComponent(name)}`),
      get<Record<string, EntryDate>>(`/project/${encodeURIComponent(name)}/entry-dates`),
      get<{ sessions: HookLogSession[] }>("/hook-logs"),
    ]);
    return { project, dates, hookLogs };
  },
};
