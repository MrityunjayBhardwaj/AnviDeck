import { api } from "../api";
import type {
  HookLogEntry,
  RouteLogEntry,
  ProjectState,
  BoundaryInfo,
} from "../../shared/types";

interface DhyanaState {
  project: string | null;
  boundaries: BoundaryInfo[];
  fireCounts: Map<string, number>;
  fatalityFires: number;
  contributions: Set<string>; // boundaries where fatality or new pattern detected
}

interface TraceState {
  hookEntries: HookLogEntry[];
  routeEntries: RouteLogEntry[];
  dhyana: DhyanaState;
  expandedEntry: number | null;
}

const state: TraceState = {
  hookEntries: [],
  routeEntries: [],
  dhyana: {
    project: null,
    boundaries: [],
    fireCounts: new Map(),
    fatalityFires: 0,
    contributions: new Set(),
  },
  expandedEntry: null,
};

let renderCallback: (() => void) | null = null;

/**
 * Add a hook log entry and update dhyana state.
 */
export function addHookEntry(entry: HookLogEntry): void {
  state.hookEntries.unshift(entry); // newest first
  if (state.hookEntries.length > 200) state.hookEntries.pop();

  // Update dhyana fire counts
  for (const b of entry.boundaries) {
    state.dhyana.fireCounts.set(
      b,
      (state.dhyana.fireCounts.get(b) ?? 0) + 1
    );
  }
  if (entry.fatality) {
    state.dhyana.fatalityFires++;
    for (const b of entry.boundaries) {
      state.dhyana.contributions.add(b);
    }
  }

  // Auto-detect project from first entry if not set
  if (!state.dhyana.project && entry.sid !== "unknown") {
    loadProjectDhyana(entry);
  }

  renderCallback?.();
}

/**
 * Add a route log entry.
 */
export function addRouteEntry(entry: RouteLogEntry): void {
  state.routeEntries.unshift(entry);
  if (state.routeEntries.length > 200) state.routeEntries.pop();
  renderCallback?.();
}

/**
 * Reset trace state (e.g., on session change).
 */
export function resetTrace(): void {
  state.hookEntries = [];
  state.routeEntries = [];
  state.dhyana = {
    project: null,
    boundaries: [],
    fireCounts: new Map(),
    fatalityFires: 0,
    contributions: new Set(),
  };
  state.expandedEntry = null;
}

/**
 * Try to load project dharana data via REST API.
 */
async function loadProjectDhyana(entry: HookLogEntry): Promise<void> {
  // The file path in the hook entry is relative to the project.
  // We need to find which project this session is working on.
  // Look at all projects and find one whose boundaries match.
  try {
    const projects = await api.projects();
    for (const p of projects) {
      const catCount = Object.values(p.catalogueCounts).reduce(
        (s, n) => s + n,
        0
      );
      if (catCount > 0) {
        const full: ProjectState = await api.project(p.name);
        if (full.boundaries.length > 0) {
          // Check if any of the entry's boundaries match this project
          const projectBoundaryIds = full.boundaries.map((b) => b.id);
          const hasMatch = entry.boundaries.some((b) =>
            projectBoundaryIds.includes(b)
          );
          if (hasMatch) {
            state.dhyana.project = p.name;
            state.dhyana.boundaries = full.boundaries;
            renderCallback?.();
            return;
          }
        }
      }
    }
  } catch {
    // API call failed — dhyana panel will show empty state
  }
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString("en-US", { hour12: false });
  } catch {
    return ts;
  }
}

function renderHookPanel(): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "trace-panel hook-panel";

  const header = document.createElement("div");
  header.className = "trace-panel-header";
  const totalFires = state.hookEntries.length;
  const fatalityFires = state.hookEntries.filter((e) => e.fatality).length;
  const uniqueBoundaries = new Set(
    state.hookEntries.flatMap((e) => e.boundaries)
  ).size;
  header.innerHTML = `
    <h3>Hook Activity</h3>
    <div class="trace-counters">
      <span class="counter">${totalFires} fires</span>
      <span class="counter fatality-count">${fatalityFires} fatality</span>
      <span class="counter">${uniqueBoundaries} boundaries</span>
    </div>
  `;
  panel.appendChild(header);

  const feed = document.createElement("div");
  feed.className = "trace-feed";

  if (state.hookEntries.length === 0) {
    feed.innerHTML = `<div class="trace-empty">No hook activity yet. Edit a file in a project with .anvi/ catalogues.</div>`;
  }

  for (let i = 0; i < state.hookEntries.length; i++) {
    const entry = state.hookEntries[i];
    const item = document.createElement("div");
    item.className = `hook-entry${entry.fatality ? " fatality" : ""}`;

    const isExpanded = state.expandedEntry === i;

    item.innerHTML = `
      <div class="entry-header">
        <span class="entry-time">${formatTime(entry.ts)}</span>
        <span class="entry-file">${entry.file}</span>
        <span class="entry-boundaries">${entry.boundaries
          .map(
            (b) =>
              `<span class="boundary-tag${entry.fatality ? " fatality-tag" : ""}">${b}</span>`
          )
          .join("")}</span>
        ${entry.fatality ? '<span class="fatality-badge">FATALITY</span>' : ""}
      </div>
      ${
        isExpanded
          ? `<div class="entry-details">
          ${entry.patterns.length > 0 ? `<div class="detail-row"><span class="detail-label">Patterns:</span> ${entry.patterns.join(", ")}</div>` : ""}
          ${entry.invariants.length > 0 ? `<div class="detail-row"><span class="detail-label">Invariants:</span> ${entry.invariants.join(", ")}</div>` : ""}
        </div>`
          : ""
      }
    `;

    item.addEventListener("click", () => {
      state.expandedEntry = state.expandedEntry === i ? null : i;
      renderCallback?.();
    });

    feed.appendChild(item);
  }

  panel.appendChild(feed);
  return panel;
}

function renderDhyanaPanel(): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "trace-panel dhyana-panel";

  const header = document.createElement("div");
  header.className = "trace-panel-header";
  header.innerHTML = `
    <h3>Dhyana State</h3>
    ${state.dhyana.project ? `<span class="dhyana-project">${state.dhyana.project}</span>` : ""}
  `;
  panel.appendChild(header);

  const content = document.createElement("div");
  content.className = "dhyana-content";

  if (state.dhyana.boundaries.length === 0) {
    content.innerHTML = `<div class="trace-empty">Waiting for session data to detect active project boundaries...</div>`;
  } else {
    for (const boundary of state.dhyana.boundaries) {
      const fires = state.dhyana.fireCounts.get(boundary.id) ?? 0;
      const contributed = state.dhyana.contributions.has(boundary.id);

      const row = document.createElement("div");
      row.className = `dhyana-boundary${boundary.fatality ? " fatality" : ""}${contributed ? " contributed" : ""}`;
      row.innerHTML = `
        <div class="boundary-header">
          <span class="boundary-id">${boundary.id}</span>
          <span class="boundary-name">${boundary.name}</span>
          <span class="fire-count${fires > 0 ? " active" : ""}">${fires}</span>
          ${boundary.fatality ? '<span class="fatality-badge">FATALITY</span>' : ""}
          ${contributed ? '<span class="contribution-badge">CAUGHT</span>' : ""}
        </div>
        <div class="boundary-meta">
          <span>${boundary.patternCount} patterns</span>
        </div>
      `;
      content.appendChild(row);
    }
  }

  panel.appendChild(content);
  return panel;
}

const CATEGORY_COLORS: Record<string, string> = {
  diagnose: "var(--red)",
  design: "var(--blue)",
  review: "var(--yellow)",
  implement: "var(--green)",
  recover: "var(--magenta)",
  always: "var(--dim)",
  plan: "var(--cyan)",
  translate: "var(--dim)",
};

function renderRoutingPanel(): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "trace-panel routing-panel";

  const header = document.createElement("div");
  header.className = "trace-panel-header";
  header.innerHTML = `
    <h3>Routing Decisions</h3>
    <div class="trace-counters">
      <span class="counter">${state.routeEntries.length} loads</span>
    </div>
  `;
  panel.appendChild(header);

  const feed = document.createElement("div");
  feed.className = "trace-feed";

  if (state.routeEntries.length === 0) {
    feed.innerHTML = `<div class="trace-empty">No routing decisions yet. Trigger a debug/design/review activity.</div>`;
  }

  for (const entry of state.routeEntries) {
    const item = document.createElement("div");
    item.className = "route-entry";
    const color = CATEGORY_COLORS[entry.category] ?? "var(--fg)";
    item.innerHTML = `
      <span class="entry-time">${formatTime(entry.ts)}</span>
      <span class="category-badge" style="color:${color}">${entry.category.toUpperCase()}</span>
      <span class="entry-file">${entry.file}</span>
      <span class="tier-badge">T${entry.tier}</span>
    `;
    feed.appendChild(item);
  }

  panel.appendChild(feed);
  return panel;
}

/**
 * Render the full CognitiveTrace component.
 * Call with a render callback to enable live updates.
 */
export function CognitiveTrace(onRender: () => void): HTMLElement {
  renderCallback = onRender;

  const container = document.createElement("div");
  container.className = "cognitive-trace";

  container.appendChild(renderHookPanel());
  container.appendChild(renderDhyanaPanel());
  container.appendChild(renderRoutingPanel());

  return container;
}
