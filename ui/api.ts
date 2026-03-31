import type { ProjectSummary, ProjectState, MemoryEntry, TimelinePoint } from "../shared/types";

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
};
