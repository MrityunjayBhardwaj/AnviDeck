import { api } from "../api";
import type { ProjectSummary, HookLogSession } from "../../shared/types";
import type { Nav } from "../app";

export function CommandCenter(
  projects: ProjectSummary[],
  nav: Nav
): HTMLElement {
  const el = document.createElement("div");
  el.className = "command-center";

  // Aggregate stats
  const withCatalogues = projects.filter(
    (p) => Object.values(p.catalogueCounts).length > 0
  );
  const totalEntries = projects.reduce(
    (s, p) => s + Object.values(p.catalogueCounts).reduce((a, b) => a + b, 0),
    0
  );
  const totalFatality = projects.reduce((s, p) => s + p.fatalitySignals, 0);
  const totalMisaligned = projects.reduce((s, p) => s + p.misalignedInvariants, 0);
  const totalMemories = projects.reduce((s, p) => s + p.memoryCount, 0);

  // Quick actions banner
  const actions = document.createElement("div");
  actions.className = "quick-actions";

  const actionItems: { label: string; desc: string; onClick: () => void; icon: string }[] = [
    { icon: "~", label: "Live Trace", desc: "Watch the framework operate in real-time", onClick: nav.toTrace },
    { icon: "#", label: "System Lens", desc: "See which entries are pulling their weight", onClick: () => nav.toSystemLens() },
    { icon: "&", label: "Cross-Project", desc: "Find patterns across all projects", onClick: nav.toCrossProject },
    { icon: ">", label: "Routing", desc: "Understand the three-tier architecture", onClick: nav.toRouting },
  ];

  for (const a of actionItems) {
    const btn = document.createElement("button");
    btn.className = "action-card";
    btn.innerHTML = `
      <span class="action-icon">${a.icon}</span>
      <span class="action-label">${a.label}</span>
      <span class="action-desc">${a.desc}</span>
    `;
    btn.addEventListener("click", a.onClick);
    actions.appendChild(btn);
  }

  el.appendChild(actions);

  // Insights section — surface actionable signals
  const insights = buildInsights(projects, nav);
  if (insights.children.length > 0) {
    el.appendChild(insights);
  }

  // Health overview
  const healthCard = document.createElement("div");
  healthCard.className = "card";
  healthCard.innerHTML = `
    <div class="card-header"><h2>Framework Health</h2></div>
    <div class="card-body">
      <div class="grid-3">
        <div class="stat">
          <span class="value accent">${totalEntries}</span>
          <span class="label">Catalogue Entries</span>
        </div>
        <div class="stat">
          <span class="value ${totalFatality > 0 ? "red" : "green"}">${totalFatality}</span>
          <span class="label">Fatality Signals</span>
        </div>
        <div class="stat">
          <span class="value ${totalMisaligned > 0 ? "yellow" : "green"}">${totalMisaligned}</span>
          <span class="label">Misaligned Invariants</span>
        </div>
        <div class="stat">
          <span class="value accent">${totalMemories}</span>
          <span class="label">Memory Entries</span>
        </div>
        <div class="stat">
          <span class="value accent">${withCatalogues.length}</span>
          <span class="label">Monitored Projects</span>
        </div>
        <div class="stat">
          <span class="value accent">${projects.length}</span>
          <span class="label">Total Projects</span>
        </div>
      </div>
    </div>
  `;
  el.appendChild(healthCard);

  // Top projects — only those with catalogues, ranked by entry count
  const topCard = document.createElement("div");
  topCard.className = "card";
  topCard.innerHTML = `<div class="card-header"><h2>Projects</h2></div>`;
  const topBody = document.createElement("div");
  topBody.className = "card-body";

  const sorted = [...projects].sort((a, b) => {
    const aCount = Object.values(a.catalogueCounts).reduce((s, n) => s + n, 0);
    const bCount = Object.values(b.catalogueCounts).reduce((s, n) => s + n, 0);
    return bCount - aCount;
  });

  for (const p of sorted) {
    const catTotal = Object.values(p.catalogueCounts).reduce((s, n) => s + n, 0);
    const row = document.createElement("button");
    row.className = "project-row";
    row.innerHTML = `
      <span class="project-row-name">${p.name}</span>
      <span class="project-row-stats">
        ${catTotal > 0 ? `<span class="badge has-catalogues">${catTotal} entries</span>` : '<span class="badge dim">no catalogues</span>'}
        ${p.memoryCount > 0 ? `<span class="badge">${p.memoryCount} mem</span>` : ""}
        ${p.fatalitySignals > 0 ? `<span class="badge fatality">FATALITY</span>` : ""}
        ${p.misalignedInvariants > 0 ? `<span class="badge warn">MISALIGNED</span>` : ""}
      </span>
    `;
    row.addEventListener("click", () => nav.toProject(p.name));
    topBody.appendChild(row);
  }

  topCard.appendChild(topBody);
  el.appendChild(topCard);

  // Load hook log data async for insights
  loadSessionInsights(el, nav);

  return el;
}

function buildInsights(projects: ProjectSummary[], nav: Nav): HTMLElement {
  const container = document.createElement("div");
  container.className = "insights-section";

  // Fatality projects
  const fatalityProjects = projects.filter((p) => p.fatalitySignals > 0);
  if (fatalityProjects.length > 0) {
    for (const p of fatalityProjects) {
      const insight = createInsight(
        "red",
        `${p.name} has ${p.fatalitySignals} fatality signal${p.fatalitySignals > 1 ? "s" : ""} — 3+ error patterns cluster at a boundary`,
        "View project",
        () => nav.toProject(p.name)
      );
      container.appendChild(insight);
    }
  }

  // Misaligned invariants
  const misalignedProjects = projects.filter((p) => p.misalignedInvariants > 0);
  if (misalignedProjects.length > 0) {
    for (const p of misalignedProjects) {
      const insight = createInsight(
        "yellow",
        `${p.name} has ${p.misalignedInvariants} misaligned invariant${p.misalignedInvariants > 1 ? "s" : ""} — module boundaries don't match invariant spans`,
        "View project",
        () => nav.toProject(p.name)
      );
      container.appendChild(insight);
    }
  }

  return container;
}

function createInsight(
  severity: "red" | "yellow" | "cyan",
  message: string,
  actionLabel: string,
  onClick: () => void
): HTMLElement {
  const el = document.createElement("div");
  el.className = `insight insight-${severity}`;
  el.innerHTML = `
    <span class="insight-dot" style="background:var(--${severity})"></span>
    <span class="insight-message">${message}</span>
  `;
  const btn = document.createElement("button");
  btn.className = "insight-action";
  btn.textContent = actionLabel;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  el.appendChild(btn);
  return el;
}

async function loadSessionInsights(container: HTMLElement, nav: Nav): Promise<void> {
  try {
    const data = await api.hookLogs();
    if (data.sessions.length > 0) {
      const insightsEl = container.querySelector(".insights-section") ?? container;

      // Most recent session summary
      const latestSession = data.sessions.sort(
        (a, b) => (b.entries[0]?.ts ?? "").localeCompare(a.entries[0]?.ts ?? "")
      )[0];

      if (latestSession && latestSession.entries.length > 0) {
        const lastEntry = latestSession.entries[0];
        const time = new Date(lastEntry.ts).toLocaleString();
        const insight = createInsight(
          "cyan",
          `Last session: ${latestSession.totalFires} hook fires, ${latestSession.fatalityFires} fatality — ${time}`,
          "View in Live Trace",
          nav.toTrace
        );

        // Insert at top of insights
        if (insightsEl.firstChild) {
          insightsEl.insertBefore(insight, insightsEl.firstChild);
        } else {
          insightsEl.appendChild(insight);
        }
      }
    }
  } catch {
    // Hook log API not critical — fail silently
  }
}
