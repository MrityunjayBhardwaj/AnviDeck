import { api } from "../api";
import type { GitHubTrace, EntryTrace, GitHubArtifact } from "../../shared/types";
import type { Nav } from "../app";

// ---- Module state ----

interface GTState {
  projectName: string | null;
  trace: GitHubTrace | null;
  loading: boolean;
  direction: "forward" | "reverse";   // forward = entry→artifacts, reverse = artifact→entries
  expandedId: string | null;          // expanded artifact chip or entry row
  selectedProject: string | null;
}

const state: GTState = {
  projectName: null,
  trace: null,
  loading: false,
  direction: "forward",
  expandedId: null,
  selectedProject: null,
};

let renderCb: (() => void) | null = null;

async function loadTrace(name: string, refresh = false): Promise<void> {
  if (!refresh && state.projectName === name && state.trace) return;
  state.loading = true;
  state.projectName = name;
  if (refresh) state.trace = null;
  renderCb?.();

  try {
    state.trace = await api.githubTrace(name, refresh);
  } catch (err) {
    console.error("Failed to load GitHub trace:", err);
  }

  state.loading = false;
  renderCb?.();
}

// ---- Helpers ----

function timeAgo(isoDate: string): string {
  const diff = (Date.now() - new Date(isoDate).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function artifactTypeLabel(type: GitHubArtifact["type"]): string {
  return type === "issue" ? "issue" : type === "pr" ? "PR" : "commit";
}

function artifactTypeColor(type: GitHubArtifact["type"]): string {
  return type === "issue" ? "var(--red)" : type === "pr" ? "var(--cyan)" : "var(--yellow)";
}

// ---- Loop Diagram ----

function renderLoopDiagram(trace: GitHubTrace): HTMLElement {
  const container = document.createElement("div");
  container.className = "loop-diagram";

  const totalEntries = trace.entries.length;
  const linked = trace.correlationCount;
  const { issues, prs, commits } = trace.artifactCount;
  const artifacts = issues + prs + commits;

  const steps: { label: string; sub: string; count: string; color: string }[] = [
    { label: "OBSERVE",   sub: "session",   count: "",           color: "var(--text-2)" },
    { label: "LEARN",     sub: "entry",     count: `${totalEntries}`,  color: "var(--accent)" },
    { label: "ACTIVATE",  sub: "hook",      count: "",           color: "var(--yellow)" },
    { label: "ACT",       sub: "Claude",    count: "",           color: "var(--text-2)" },
    { label: "PRODUCE",   sub: "artifact",  count: `${artifacts}`,    color: "var(--cyan)" },
    { label: "VERIFY",    sub: "test",      count: "",           color: "var(--text-2)" },
    { label: "REFINE",    sub: "update",    count: `${linked} linked`, color: "var(--green)" },
  ];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    const node = document.createElement("div");
    node.className = "loop-node";
    node.innerHTML = `
      <div class="loop-node-label" style="color:${step.color}">${step.label}</div>
      <div class="loop-node-sub">${step.sub}</div>
      ${step.count ? `<div class="loop-node-count" style="color:${step.color}">${step.count}</div>` : ""}
    `;
    container.appendChild(node);

    if (i < steps.length - 1) {
      const arrow = document.createElement("div");
      arrow.className = "loop-arrow";
      arrow.textContent = "→";
      container.appendChild(arrow);
    }
  }

  return container;
}

// ---- Forward view: entry → artifacts ----

function renderArtifactChip(artifact: GitHubArtifact, entryId: string): HTMLElement {
  const chipId = `${entryId}:${artifact.id}`;
  const isExpanded = state.expandedId === chipId;
  const color = artifactTypeColor(artifact.type);
  const confidenceClass = artifact.confidence === "high" ? "high" : "medium";

  const chip = document.createElement("div");
  chip.className = `artifact-chip ${confidenceClass}`;

  const header = document.createElement("div");
  header.className = "artifact-chip-header";
  header.innerHTML = `
    <span class="artifact-type" style="color:${color}">${artifactTypeLabel(artifact.type)}</span>
    <span class="artifact-id" style="color:${color}">${artifact.id}</span>
    <span class="artifact-conf ${confidenceClass}">${artifact.confidence.toUpperCase()}</span>
    <span class="artifact-title">${artifact.title.slice(0, 60)}${artifact.title.length > 60 ? "…" : ""}</span>
  `;
  header.addEventListener("click", () => {
    state.expandedId = isExpanded ? null : chipId;
    renderCb?.();
  });
  chip.appendChild(header);

  if (isExpanded) {
    const detail = document.createElement("div");
    detail.className = "artifact-detail";
    detail.innerHTML = `
      <div class="artifact-detail-row">
        <span class="adr-key">Keywords:</span>
        <span class="adr-val">${artifact.matchedKeywords.join(", ")}</span>
      </div>
      <div class="artifact-detail-row">
        <span class="adr-key">Date:</span>
        <span class="adr-val">${new Date(artifact.date).toLocaleDateString()}</span>
      </div>
      ${artifact.url ? `<div class="artifact-detail-row"><a class="artifact-link" href="${artifact.url}" target="_blank" rel="noopener">${artifact.url}</a></div>` : ""}
    `;
    chip.appendChild(detail);
  }

  return chip;
}

function renderForwardView(trace: GitHubTrace): HTMLElement {
  const container = document.createElement("div");
  container.className = "trace-forward";

  // Filter to only entries that have at least the catalogue of interest
  const withArtifacts = trace.entries.filter((e) => e.artifacts.length > 0);
  const withoutArtifacts = trace.entries.filter((e) => e.artifacts.length === 0);

  if (trace.entries.length === 0) {
    container.innerHTML = `<div class="trace-empty">No catalogue entries found for this project.</div>`;
    return container;
  }

  // Stats bar
  const stats = document.createElement("div");
  stats.className = "trace-stats";
  stats.innerHTML = `
    <span>${trace.entries.length} entries</span>
    <span class="trace-stat-sep">·</span>
    <span>${withArtifacts.length} linked</span>
    <span class="trace-stat-sep">·</span>
    <span>${trace.artifactCount.issues} issues · ${trace.artifactCount.prs} PRs · ${trace.artifactCount.commits} commits</span>
  `;
  container.appendChild(stats);

  if (withArtifacts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "trace-empty";
    empty.innerHTML = `No links found between catalogue entries and GitHub artifacts.<br><span class="trace-empty-hint">Links improve as more entries are created and commits/issues use matching technical language.</span>`;
    container.appendChild(empty);
    return container;
  }

  // Table: linked entries first
  const table = document.createElement("div");
  table.className = "trace-table";

  for (const entry of withArtifacts) {
    const row = renderForwardRow(entry);
    table.appendChild(row);
  }

  // Collapsed section for unlinked entries
  if (withoutArtifacts.length > 0) {
    const unlinked = document.createElement("details");
    unlinked.className = "trace-unlinked";
    unlinked.innerHTML = `<summary class="trace-unlinked-summary">${withoutArtifacts.length} entries with no links</summary>`;
    const inner = document.createElement("div");
    inner.className = "trace-table trace-table-dim";
    for (const entry of withoutArtifacts) {
      const row = document.createElement("div");
      row.className = "trace-entry-row";
      row.innerHTML = `
        <div class="trace-entry-id" style="color:var(--text-2)">${entry.entryId}</div>
        <div class="trace-entry-title dim">${entry.entryTitle}</div>
        <div class="trace-entry-cat dim">${entry.catalogue}</div>
        <div class="trace-artifact-list"><span class="trace-no-link">—</span></div>
      `;
      inner.appendChild(row);
    }
    unlinked.appendChild(inner);
    table.appendChild(unlinked);
  }

  container.appendChild(table);
  return container;
}

function renderForwardRow(entry: EntryTrace): HTMLElement {
  const catColor: Record<string, string> = {
    hetvabhasa: "var(--red)",
    vyapti: "var(--cyan)",
    krama: "var(--yellow)",
    dharana: "var(--text-1)",
  };
  const color = catColor[entry.catalogue] ?? "var(--text-2)";

  const row = document.createElement("div");
  row.className = "trace-entry-row";

  const meta = document.createElement("div");
  meta.className = "trace-entry-meta";
  meta.innerHTML = `
    <span class="trace-entry-id" style="color:${color}">${entry.entryId}</span>
    <span class="trace-entry-cat" style="color:${color}">${entry.catalogue}</span>
    <span class="trace-entry-title">${entry.entryTitle}</span>
  `;
  row.appendChild(meta);

  const artifactList = document.createElement("div");
  artifactList.className = "trace-artifact-list";

  for (const artifact of entry.artifacts.slice(0, 8)) {
    artifactList.appendChild(renderArtifactChip(artifact, entry.entryId));
  }

  if (entry.artifacts.length > 8) {
    const more = document.createElement("span");
    more.className = "trace-more";
    more.textContent = `+${entry.artifacts.length - 8} more`;
    artifactList.appendChild(more);
  }

  row.appendChild(artifactList);
  return row;
}

// ---- Reverse view: artifact → entries ----

function renderReverseView(trace: GitHubTrace): HTMLElement {
  const container = document.createElement("div");
  container.className = "trace-reverse";

  // Build artifact→entries map
  const artifactMap = new Map<string, {
    artifact: GitHubArtifact;
    entries: { entryId: string; entryTitle: string; catalogue: string; confidence: "high" | "medium"; keywords: string[] }[];
  }>();

  for (const entry of trace.entries) {
    for (const artifact of entry.artifacts) {
      const key = `${artifact.type}:${artifact.id}`;
      if (!artifactMap.has(key)) {
        artifactMap.set(key, { artifact, entries: [] });
      }
      artifactMap.get(key)!.entries.push({
        entryId: entry.entryId,
        entryTitle: entry.entryTitle,
        catalogue: entry.catalogue,
        confidence: artifact.confidence,
        keywords: artifact.matchedKeywords,
      });
    }
  }

  if (artifactMap.size === 0) {
    container.innerHTML = `<div class="trace-empty">No artifacts linked to catalogue entries.</div>`;
    return container;
  }

  // Sort: most entries first
  const sorted = [...artifactMap.values()].sort((a, b) => b.entries.length - a.entries.length);

  const list = document.createElement("div");
  list.className = "trace-reverse-list";

  for (const { artifact, entries } of sorted) {
    const block = document.createElement("div");
    block.className = "trace-reverse-block";

    const color = artifactTypeColor(artifact.type);
    const header = document.createElement("div");
    header.className = "trace-reverse-header";
    header.innerHTML = `
      <span class="artifact-type" style="color:${color}">${artifactTypeLabel(artifact.type)}</span>
      <span class="artifact-id" style="color:${color}">${artifact.id}</span>
      <span class="reverse-title">${artifact.title.slice(0, 72)}${artifact.title.length > 72 ? "…" : ""}</span>
      ${artifact.url ? `<a class="artifact-link-inline" href="${artifact.url}" target="_blank" rel="noopener">↗</a>` : ""}
    `;
    block.appendChild(header);

    const entryList = document.createElement("div");
    entryList.className = "trace-reverse-entries";

    const catColor: Record<string, string> = {
      hetvabhasa: "var(--red)", vyapti: "var(--cyan)",
      krama: "var(--yellow)", dharana: "var(--text-1)",
    };

    for (const e of entries) {
      const eRow = document.createElement("div");
      eRow.className = "trace-reverse-entry";
      const ec = catColor[e.catalogue] ?? "var(--text-2)";
      const confClass = e.confidence === "high" ? "high" : "medium";
      eRow.innerHTML = `
        <span class="trace-entry-id" style="color:${ec}">${e.entryId}</span>
        <span class="artifact-conf ${confClass}">${e.confidence.toUpperCase()}</span>
        <span class="trace-entry-title">${e.entryTitle}</span>
        <span class="reverse-keywords">${e.keywords.join(", ")}</span>
      `;
      entryList.appendChild(eRow);
    }

    block.appendChild(entryList);
    list.appendChild(block);
  }

  container.appendChild(list);
  return container;
}

// ---- Project selector ----

function renderProjectSelector(projects: string[], currentProject: string): HTMLElement {
  const sel = document.createElement("select");
  sel.className = "trace-project-select";
  for (const p of projects) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    if (p === currentProject) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => {
    state.selectedProject = sel.value;
    state.trace = null;
    loadTrace(sel.value);
  });
  return sel;
}

// ---- Main export ----

export function GitHubTrace(projectNames: string[], initialProject: string, nav: Nav): HTMLElement {
  renderCb = nav.render;

  const project = state.selectedProject ?? initialProject;

  if (!state.trace && !state.loading) {
    setTimeout(() => loadTrace(project), 0);
  }

  const container = document.createElement("div");
  container.className = "github-trace-view";

  // Header
  const header = document.createElement("div");
  header.className = "gt-header";

  const title = document.createElement("h2");
  title.className = "gt-title";
  title.textContent = "GitHub Trace";
  header.appendChild(title);

  const controls = document.createElement("div");
  controls.className = "gt-controls";

  if (projectNames.length > 1) {
    controls.appendChild(renderProjectSelector(projectNames, project));
  }

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "trace-toggle";
  toggleBtn.textContent = state.direction === "forward" ? "Entry → Artifacts" : "Artifact → Entries";
  toggleBtn.addEventListener("click", () => {
    state.direction = state.direction === "forward" ? "reverse" : "forward";
    state.expandedId = null;
    renderCb?.();
  });
  controls.appendChild(toggleBtn);

  header.appendChild(controls);
  container.appendChild(header);

  // Loading
  if (state.loading) {
    container.innerHTML += `<div class="loading-state"><div class="loading-spinner"></div><span>Fetching commits and GitHub artifacts...</span></div>`;
    return container;
  }

  if (!state.trace) {
    container.innerHTML += `<div class="loading-state"><div class="loading-spinner"></div><span>Loading trace data...</span></div>`;
    return container;
  }

  const trace = state.trace;

  // Error banner
  if (trace.error) {
    const errBanner = document.createElement("div");
    errBanner.className = "gt-error-banner";
    errBanner.innerHTML = `⚠ GitHub API unavailable: <span class="gt-error-msg">${trace.error.slice(0, 120)}</span> — showing commit links only.`;
    container.appendChild(errBanner);
  }

  // Loop diagram
  container.appendChild(renderLoopDiagram(trace));

  // Meta bar
  const meta = document.createElement("div");
  meta.className = "trace-meta";
  meta.innerHTML = `
    <span class="trace-cached">Refreshed ${timeAgo(trace.cachedAt)}</span>
    ${trace.repoUrl ? `<a class="trace-repo-link" href="${trace.repoUrl}" target="_blank" rel="noopener">${trace.repoUrl.replace("https://github.com/", "")}</a>` : ""}
  `;

  const refreshBtn = document.createElement("button");
  refreshBtn.className = "trace-refresh-btn";
  refreshBtn.textContent = "Refresh";
  refreshBtn.addEventListener("click", () => loadTrace(project, true));
  meta.appendChild(refreshBtn);
  container.appendChild(meta);

  // Main content
  if (state.direction === "forward") {
    container.appendChild(renderForwardView(trace));
  } else {
    container.appendChild(renderReverseView(trace));
  }

  return container;
}
