import type { ProjectSummary } from "../../shared/types";

export function CommandCenter(
  projects: ProjectSummary[],
  onProjectClick: (name: string) => void
): HTMLElement {
  const el = document.createElement("div");

  // Compute aggregate stats
  const totalProjects = projects.length;
  const withCatalogues = projects.filter(
    (p) => Object.keys(p.catalogueCounts).length > 0
  ).length;
  const totalMemories = projects.reduce((s, p) => s + p.memoryCount, 0);
  const totalFatality = projects.reduce((s, p) => s + p.fatalitySignals, 0);
  const totalMisaligned = projects.reduce(
    (s, p) => s + p.misalignedInvariants,
    0
  );
  const totalBlindSpots = projects.reduce((s, p) => s + p.blindSpots, 0);
  const totalEntries = projects.reduce((s, p) => {
    return s + Object.values(p.catalogueCounts).reduce((a, b) => a + b, 0);
  }, 0);

  el.innerHTML = `
    <div class="grid-2">
      <div class="card">
        <div class="card-header"><h2>Framework Health</h2></div>
        <div class="card-body">
          <div class="grid-3">
            <div class="stat">
              <span class="label">Catalogue Entries</span>
              <span class="value accent">${totalEntries}</span>
            </div>
            <div class="stat">
              <span class="label">Fatality Signals</span>
              <span class="value ${totalFatality > 0 ? "red" : "green"}">${totalFatality}</span>
            </div>
            <div class="stat">
              <span class="label">Misaligned</span>
              <span class="value ${totalMisaligned > 0 ? "yellow" : "green"}">${totalMisaligned}</span>
            </div>
            <div class="stat">
              <span class="label">Blind Spots</span>
              <span class="value ${totalBlindSpots > 0 ? "yellow" : "green"}">${totalBlindSpots}</span>
            </div>
            <div class="stat">
              <span class="label">Total Memories</span>
              <span class="value accent">${totalMemories}</span>
            </div>
            <div class="stat">
              <span class="label">With Catalogues</span>
              <span class="value accent">${withCatalogues}/${totalProjects}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><h2>Cross-Project Overview</h2></div>
        <div class="card-body">
          <div class="grid-3">
            <div class="stat">
              <span class="label">Projects</span>
              <span class="value accent">${totalProjects}</span>
            </div>
            <div class="stat">
              <span class="label">Hetvabhasa</span>
              <span class="value">${projects.reduce((s, p) => s + (p.catalogueCounts.hetvabhasa ?? 0), 0)}</span>
            </div>
            <div class="stat">
              <span class="label">Vyapti</span>
              <span class="value">${projects.reduce((s, p) => s + (p.catalogueCounts.vyapti ?? 0), 0)}</span>
            </div>
            <div class="stat">
              <span class="label">Krama</span>
              <span class="value">${projects.reduce((s, p) => s + (p.catalogueCounts.krama ?? 0), 0)}</span>
            </div>
            <div class="stat">
              <span class="label">Dharana</span>
              <span class="value">${projects.reduce((s, p) => s + (p.catalogueCounts.dharana ?? 0), 0)}</span>
            </div>
            <div class="stat">
              <span class="label">Feedback</span>
              <span class="value">${totalMemories}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h2>All Projects</h2></div>
      <div class="card-body" id="project-table"></div>
    </div>
  `;

  // Build project table
  const tableEl = el.querySelector("#project-table")!;
  const sorted = [...projects].sort((a, b) => {
    const aCount = Object.values(a.catalogueCounts).reduce((s, n) => s + n, 0);
    const bCount = Object.values(b.catalogueCounts).reduce((s, n) => s + n, 0);
    return bCount - aCount;
  });

  for (const p of sorted) {
    const catTotal = Object.values(p.catalogueCounts).reduce(
      (s, n) => s + n,
      0
    );
    const row = document.createElement("div");
    row.className = "project-item";
    row.innerHTML = `
      <span class="name">${p.name}</span>
      ${catTotal > 0 ? `<span class="badge has-catalogues">${catTotal} entries</span>` : ""}
      ${p.memoryCount > 0 ? `<span class="badge">${p.memoryCount} mem</span>` : ""}
      ${p.fatalitySignals > 0 ? `<span class="badge fatality">FATALITY</span>` : ""}
    `;
    row.addEventListener("click", () => onProjectClick(p.name));
    tableEl.appendChild(row);
  }

  return el;
}
