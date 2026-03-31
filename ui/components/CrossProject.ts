import { api } from "../api";
import type { CrossProjectData, CrossProjectPattern } from "../../shared/types";

interface CPState {
  data: CrossProjectData | null;
  loading: boolean;
  expandedPattern: number | null;
  expandedInvariant: number | null;
}

const state: CPState = {
  data: null,
  loading: false,
  expandedPattern: null,
  expandedInvariant: null,
};

let renderCb: (() => void) | null = null;

async function loadData(): Promise<void> {
  state.loading = true;
  renderCb?.();
  try {
    state.data = await api.crossProject();
  } catch (err) {
    console.error("Failed to load cross-project data:", err);
  }
  state.loading = false;
  renderCb?.();
}

// Project badge colors
const PROJECT_COLORS: Record<string, string> = {};
const PALETTE = [
  "var(--cyan)", "var(--green)", "var(--yellow)", "var(--accent)",
  "var(--orange)", "var(--red)", "var(--text-1)",
];
let colorIdx = 0;

function projectColor(name: string): string {
  if (!PROJECT_COLORS[name]) {
    PROJECT_COLORS[name] = PALETTE[colorIdx % PALETTE.length];
    colorIdx++;
  }
  return PROJECT_COLORS[name];
}

function renderPatternCard(
  pattern: CrossProjectPattern,
  index: number,
  expandedKey: "expandedPattern" | "expandedInvariant"
): HTMLElement {
  const card = document.createElement("div");
  card.className = "pattern-card";

  const projects = [...new Set(pattern.entries.map((e) => e.project))];
  const isExpanded = state[expandedKey] === index;

  card.innerHTML = `
    <div class="pattern-header">
      <span class="pattern-keyword">${pattern.keyword}</span>
      <span class="pattern-count">${pattern.entries.length} entries across ${projects.length} projects</span>
      <div class="pattern-projects">
        ${projects.map((p) => `<span class="project-badge" style="color:${projectColor(p)}">${p}</span>`).join("")}
      </div>
    </div>
    ${
      isExpanded
        ? `<div class="pattern-entries">
        ${pattern.entries
          .map(
            (e) => `
          <div class="pattern-entry">
            <span class="project-badge" style="color:${projectColor(e.project)}">${e.project}</span>
            <span class="entry-id">${e.entryId}</span>
            <span class="entry-title-text">${e.title}</span>
            ${e.content ? `<div class="entry-preview">${e.content}</div>` : ""}
          </div>`
          )
          .join("")}
      </div>`
        : ""
    }
  `;

  card.querySelector(".pattern-header")?.addEventListener("click", () => {
    state[expandedKey] = state[expandedKey] === index ? null : index;
    renderCb?.();
  });

  return card;
}

function renderRecurringPatterns(): HTMLElement {
  const section = document.createElement("div");
  section.className = "cp-section";

  section.innerHTML = `<h3 class="section-header">Recurring Error Patterns</h3>`;

  if (!state.data || state.data.recurringPatterns.length === 0) {
    section.innerHTML += `<div class="trace-empty">No recurring patterns found across projects.</div>`;
    return section;
  }

  const desc = document.createElement("div");
  desc.className = "cp-desc";
  desc.textContent = "Error patterns (hetvabhasa) that appear in multiple projects — universal traps worth learning from.";
  section.appendChild(desc);

  for (let i = 0; i < Math.min(state.data.recurringPatterns.length, 20); i++) {
    section.appendChild(
      renderPatternCard(state.data.recurringPatterns[i], i, "expandedPattern")
    );
  }

  return section;
}

function renderSharedInvariants(): HTMLElement {
  const section = document.createElement("div");
  section.className = "cp-section";

  section.innerHTML = `<h3 class="section-header">Shared Invariants</h3>`;

  if (!state.data || state.data.sharedInvariants.length === 0) {
    section.innerHTML += `<div class="trace-empty">No shared invariants found across projects.</div>`;
    return section;
  }

  const desc = document.createElement("div");
  desc.className = "cp-desc";
  desc.textContent = "Structural invariants (vyapti) that hold across multiple projects — universal rules.";
  section.appendChild(desc);

  for (let i = 0; i < Math.min(state.data.sharedInvariants.length, 20); i++) {
    section.appendChild(
      renderPatternCard(state.data.sharedInvariants[i], i, "expandedInvariant")
    );
  }

  return section;
}

function renderMemoryOverview(): HTMLElement {
  const section = document.createElement("div");
  section.className = "cp-section";

  section.innerHTML = `<h3 class="section-header">Memory Network</h3>`;

  if (!state.data || state.data.memoryNetwork.totalCount === 0) {
    section.innerHTML += `<div class="trace-empty">No memory entries found across projects.</div>`;
    return section;
  }

  const desc = document.createElement("div");
  desc.className = "cp-desc";
  desc.textContent = `${state.data.memoryNetwork.totalCount} memory entries across ${state.data.projectCount} projects.`;
  section.appendChild(desc);

  const types = state.data.memoryNetwork.byType;
  for (const [type, entries] of Object.entries(types)) {
    const group = document.createElement("div");
    group.className = "memory-group";

    const projects = [...new Set(entries.map((e) => e.project))];
    group.innerHTML = `
      <div class="memory-group-header">
        <span class="memory-type">${type}</span>
        <span class="memory-count">${entries.length} entries from ${projects.length} projects</span>
      </div>
      <div class="memory-entries">
        ${entries
          .slice(0, 10)
          .map(
            (e) => `
          <div class="memory-entry">
            <span class="project-badge" style="color:${projectColor(e.project)}">${e.project}</span>
            <span class="memory-name">${e.name}</span>
          </div>`
          )
          .join("")}
        ${entries.length > 10 ? `<div class="memory-more">+${entries.length - 10} more</div>` : ""}
      </div>
    `;

    section.appendChild(group);
  }

  return section;
}

export function CrossProject(nav: { render: () => void }): HTMLElement {
  renderCb = nav.render;

  const container = document.createElement("div");
  container.className = "cross-project";

  const header = document.createElement("div");
  header.className = "lens-header";
  header.innerHTML = `<h2>Cross-Project Intelligence</h2>`;
  container.appendChild(header);

  if (state.loading) {
    container.innerHTML += `<div class="loading-state"><div class="loading-spinner"></div><span>Analyzing patterns across projects...</span></div>`;
    return container;
  }

  if (!state.data) {
    container.innerHTML += `<div class="loading-state"><div class="loading-spinner"></div><span>Loading cross-project data...</span></div>`;
    setTimeout(loadData, 0);
    return container;
  }

  container.appendChild(renderRecurringPatterns());
  container.appendChild(renderSharedInvariants());
  container.appendChild(renderMemoryOverview());

  return container;
}
