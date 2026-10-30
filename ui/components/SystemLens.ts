import { api } from "../api";
import type {
  ProjectSummary,
  ProjectState,
  CatalogueEntry,
  HookLogEntry,
  HookLogSession,
  ContributionRow,
  ContributionCell,
  EntryDate,
} from "../../shared/types";

interface LensState {
  projects: ProjectSummary[];
  selectedProject: string | null;
  projectState: ProjectState | null;
  hookSessions: HookLogSession[];
  entryDates: Record<string, EntryDate>;
  rows: ContributionRow[];
  collapsedGroups: Set<string>;
  loading: boolean;
}

const state: LensState = {
  projects: [],
  selectedProject: null,
  projectState: null,
  hookSessions: [],
  entryDates: {},
  rows: [],
  collapsedGroups: new Set(),
  loading: false,
};

let renderCb: (() => void) | null = null;

function buildRows(): void {
  if (!state.projectState) {
    state.rows = [];
    return;
  }

  const rows: ContributionRow[] = [];

  // Collect all fired patterns/invariants/boundaries per session
  const sessionFires = new Map<string, { patterns: Set<string>; invariants: Set<string>; boundaries: Set<string> }>();
  for (const session of state.hookSessions) {
    const fires = { patterns: new Set<string>(), invariants: new Set<string>(), boundaries: new Set<string>() };
    for (const entry of session.entries) {
      for (const p of entry.patterns) fires.patterns.add(p);
      for (const v of entry.invariants) fires.invariants.add(v);
      for (const b of entry.boundaries) fires.boundaries.add(b);
    }
    sessionFires.set(session.sid, fires);
  }

  const sessionIds = state.hookSessions.map((s) => s.sid);

  for (const catalogue of state.projectState.catalogues) {
    for (const entry of catalogue.entries) {
      const sessions: Record<string, ContributionCell> = {};
      let totalFires = 0;
      let lastFired: string | null = null;

      for (const sid of sessionIds) {
        const fires = sessionFires.get(sid);
        if (!fires) {
          sessions[sid] = { status: "not-relevant", fireCount: 0 };
          continue;
        }

        // Check if this entry was fired in this session
        let fireCount = 0;
        const session = state.hookSessions.find((s) => s.sid === sid);
        if (session) {
          for (const he of session.entries) {
            if (
              he.patterns.includes(entry.id) ||
              he.invariants.includes(entry.id) ||
              he.boundaries.includes(entry.id)
            ) {
              fireCount++;
            }
          }
        }

        if (fireCount > 0) {
          sessions[sid] = { status: "contributed", fireCount };
          totalFires += fireCount;
          // Find latest timestamp
          if (session) {
            for (const he of session.entries) {
              if (
                he.patterns.includes(entry.id) ||
                he.invariants.includes(entry.id) ||
                he.boundaries.includes(entry.id)
              ) {
                if (!lastFired || he.ts > lastFired) lastFired = he.ts;
              }
            }
          }
        } else {
          sessions[sid] = { status: "not-relevant", fireCount: 0 };
        }
      }

      // Mark stale if 0 fires across all sessions and sessions exist
      if (totalFires === 0 && sessionIds.length > 0) {
        for (const sid of sessionIds) {
          sessions[sid] = { status: "stale", fireCount: 0 };
        }
      }

      const dates = state.entryDates[entry.id];

      rows.push({
        entryId: entry.id,
        entryTitle: entry.title,
        catalogue: catalogue.name,
        sessions,
        totalFires,
        lastFired,
        created: dates?.created ?? null,
        why: entry.why || entry.sections["WHY"] || undefined,
      });
    }
  }

  // Sort: contributed entries first, then by catalogue
  rows.sort((a, b) => {
    if (b.totalFires !== a.totalFires) return b.totalFires - a.totalFires;
    return a.catalogue.localeCompare(b.catalogue);
  });

  state.rows = rows;
}

async function loadProject(name: string): Promise<void> {
  state.loading = true;
  state.selectedProject = name;
  renderCb?.();

  try {
    const [projectState, hookData, entryDates] = await Promise.all([
      api.project(name),
      api.hookLogs(),
      api.entryDates(name),
    ]);

    state.projectState = projectState;
    state.hookSessions = hookData.sessions;
    state.entryDates = entryDates;
    buildRows();
  } catch (err) {
    console.error("Failed to load system lens data:", err);
  }

  state.loading = false;
  renderCb?.();
}

function toggleGroup(catalogue: string): void {
  if (state.collapsedGroups.has(catalogue)) {
    state.collapsedGroups.delete(catalogue);
  } else {
    state.collapsedGroups.add(catalogue);
  }
  renderCb?.();
}

function renderProjectSelector(): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "project-selector";

  const select = document.createElement("select");
  select.className = "lens-select";

  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";
  defaultOpt.textContent = "Select project...";
  select.appendChild(defaultOpt);

  // Sort by catalogue count descending
  const sorted = [...state.projects]
    .filter((p) => Object.values(p.catalogueCounts).reduce((s, n) => s + n, 0) > 0)
    .sort((a, b) => {
      const ac = Object.values(a.catalogueCounts).reduce((s, n) => s + n, 0);
      const bc = Object.values(b.catalogueCounts).reduce((s, n) => s + n, 0);
      return bc - ac;
    });

  for (const p of sorted) {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = `${p.name} (${Object.values(p.catalogueCounts).reduce((s, n) => s + n, 0)} entries)`;
    if (p.name === state.selectedProject) opt.selected = true;
    select.appendChild(opt);
  }

  select.addEventListener("change", () => {
    if (select.value) loadProject(select.value);
  });

  wrapper.appendChild(select);
  return wrapper;
}

function renderSummary(): HTMLElement {
  const summary = document.createElement("div");
  summary.className = "lens-summary";

  const total = state.rows.length;
  const active = state.rows.filter((r) => r.totalFires > 0).length;
  const stale = state.rows.filter((r) => r.totalFires === 0).length;
  const sessions = state.hookSessions.length;

  summary.innerHTML = `
    <div class="summary-stat"><span class="stat-value">${total}</span><span class="stat-label">entries</span></div>
    <div class="summary-stat"><span class="stat-value active">${active}</span><span class="stat-label">active</span></div>
    <div class="summary-stat"><span class="stat-value stale">${stale}</span><span class="stat-label">no fires</span></div>
    <div class="summary-stat"><span class="stat-value">${sessions}</span><span class="stat-label">sessions</span></div>
  `;

  return summary;
}

function renderMatrix(): HTMLElement {
  const container = document.createElement("div");
  container.className = "contribution-matrix";

  if (state.rows.length === 0) {
    container.innerHTML = `<div class="trace-empty">No catalogue entries found. Select a project with .anvi/ catalogues.</div>`;
    return container;
  }

  const sessionIds = state.hookSessions.map((s) => s.sid);

  // Group by catalogue
  const groups = new Map<string, ContributionRow[]>();
  for (const row of state.rows) {
    const existing = groups.get(row.catalogue) ?? [];
    existing.push(row);
    groups.set(row.catalogue, existing);
  }

  for (const [catalogue, rows] of groups) {
    const isCollapsed = state.collapsedGroups.has(catalogue);

    const groupEl = document.createElement("div");
    groupEl.className = "catalogue-group";

    const header = document.createElement("div");
    header.className = "group-header";
    header.innerHTML = `
      <span class="group-toggle">${isCollapsed ? "+" : "-"}</span>
      <span class="group-name">${catalogue}</span>
      <span class="group-count">${rows.length} entries</span>
      <span class="group-active">${rows.filter((r) => r.totalFires > 0).length} active</span>
    `;
    header.addEventListener("click", () => toggleGroup(catalogue));
    groupEl.appendChild(header);

    if (!isCollapsed) {
      const table = document.createElement("div");
      table.className = "matrix-table";

      // Header row with session IDs
      if (sessionIds.length > 0) {
        const headerRow = document.createElement("div");
        headerRow.className = "matrix-row matrix-header-row";
        headerRow.innerHTML = `<span class="matrix-entry-cell">Entry</span>`;
        for (const sid of sessionIds) {
          headerRow.innerHTML += `<span class="matrix-session-header" title="${sid}">${sid.slice(0, 6)}</span>`;
        }
        headerRow.innerHTML += `<span class="matrix-total-header">Total</span>`;
        table.appendChild(headerRow);
      }

      for (const row of rows) {
        const rowEl = document.createElement("div");
        rowEl.className = `matrix-row${row.totalFires === 0 ? " stale-row" : ""}`;

        let cells = `<span class="matrix-entry-cell" title="${row.entryTitle}">${row.entryId}</span>`;

        for (const sid of sessionIds) {
          const cell = row.sessions[sid];
          if (!cell) {
            cells += `<span class="matrix-cell no-data"></span>`;
            continue;
          }
          const cls =
            cell.status === "contributed"
              ? "contributed"
              : cell.status === "stale"
                ? "stale"
                : "not-relevant";
          cells += `<span class="matrix-cell ${cls}" title="${cell.fireCount} fires">${cell.fireCount > 0 ? cell.fireCount : ""}</span>`;
        }

        cells += `<span class="matrix-total-cell${row.totalFires > 0 ? " active" : ""}">${row.totalFires}</span>`;
        rowEl.innerHTML = cells;
        table.appendChild(rowEl);
      }

      groupEl.appendChild(table);
    }

    container.appendChild(groupEl);
  }

  return container;
}

function renderPruningCandidates(): HTMLElement {
  const container = document.createElement("div");
  container.className = "pruning-candidates";

  const header = document.createElement("h3");
  header.textContent = "Pruning Candidates";
  header.className = "section-header";
  container.appendChild(header);

  const candidates = state.rows.filter((r) => r.totalFires === 0);

  if (candidates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "trace-empty";
    empty.textContent =
      state.hookSessions.length === 0
        ? "No hook data available yet. Run a session to populate."
        : "All entries have contributed. No pruning candidates.";
    container.appendChild(empty);
    return container;
  }

  for (const row of candidates) {
    const item = document.createElement("div");
    item.className = "prune-item";
    item.innerHTML = `
      <div class="prune-header">
        <span class="prune-id">${row.entryId}</span>
        <span class="prune-title">${row.entryTitle}</span>
        <span class="prune-catalogue">${row.catalogue}</span>
      </div>
      ${row.why ? `<div class="prune-why"><span class="detail-label">WHY:</span> ${row.why}</div>` : '<div class="prune-why no-why">No WHY field — consider adding provenance.</div>'}
    `;
    container.appendChild(item);
  }

  return container;
}

function renderEntryTimeline(): HTMLElement {
  const container = document.createElement("div");
  container.className = "entry-timeline";

  const header = document.createElement("h3");
  header.textContent = "Entry Timeline";
  header.className = "section-header";
  container.appendChild(header);

  const withDates = state.rows
    .filter((r) => r.created)
    .sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));

  if (withDates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "trace-empty";
    empty.textContent = "No creation date data available (requires git history).";
    container.appendChild(empty);
    return container;
  }

  for (const row of withDates) {
    const item = document.createElement("div");
    item.className = "timeline-item";
    const created = row.created ? new Date(row.created).toLocaleDateString() : "?";
    item.innerHTML = `
      <span class="timeline-date">${created}</span>
      <span class="timeline-id">${row.entryId}</span>
      <span class="timeline-title">${row.entryTitle}</span>
      <span class="timeline-fires${row.totalFires > 0 ? " active" : ""}">${row.totalFires} fires</span>
    `;
    container.appendChild(item);
  }

  return container;
}

export function SystemLens(
  projects: ProjectSummary[],
  nav: { render: () => void }
): HTMLElement {
  renderCb = nav.render;
  state.projects = projects;

  // Check if navigated here with a specific project
  const preselected = (window as any).__systemLensProject;
  if (preselected && preselected !== state.selectedProject) {
    delete (window as any).__systemLensProject;
    setTimeout(() => loadProject(preselected), 0);
  }

  const container = document.createElement("div");
  container.className = "system-lens";

  const header = document.createElement("div");
  header.className = "lens-header";
  header.innerHTML = `<h2>System Lens</h2>`;
  header.appendChild(renderProjectSelector());
  container.appendChild(header);

  if (state.loading) {
    container.innerHTML += `<div class="loading-state"><div class="loading-spinner"></div><span>Loading...</span></div>`;
    return container;
  }

  if (!state.selectedProject) {
    // Auto-select best project
    const best = [...state.projects]
      .filter((p) => Object.values(p.catalogueCounts).reduce((s, n) => s + n, 0) > 0)
      .sort((a, b) => {
        const ac = Object.values(a.catalogueCounts).reduce((s, n) => s + n, 0);
        const bc = Object.values(b.catalogueCounts).reduce((s, n) => s + n, 0);
        return bc - ac;
      })[0];
    if (best) {
      setTimeout(() => loadProject(best.name), 0);
    }
    container.innerHTML += `<div class="loading-state"><div class="loading-spinner"></div><span>Loading project data...</span></div>`;
    return container;
  }

  container.appendChild(renderSummary());
  container.appendChild(renderMatrix());
  container.appendChild(renderPruningCandidates());
  container.appendChild(renderEntryTimeline());

  return container;
}
