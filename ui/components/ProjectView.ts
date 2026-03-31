import type { ProjectState } from "../../shared/types";
import { CatalogueTree } from "./CatalogueTree";

export function ProjectView(
  project: ProjectState,
  onBack: () => void
): HTMLElement {
  const el = document.createElement("div");

  // Breadcrumb
  const breadcrumb = document.createElement("div");
  breadcrumb.className = "breadcrumb";
  breadcrumb.innerHTML = `<a class="back-link">Command Center</a> <span class="sep">/</span> <span>${project.name}</span>`;
  breadcrumb.querySelector(".back-link")!.addEventListener("click", onBack);
  el.appendChild(breadcrumb);

  // Project health summary
  const catTotal = project.catalogues.reduce(
    (s, c) => s + c.entries.length,
    0
  );

  const healthCard = document.createElement("div");
  healthCard.className = "card";
  healthCard.innerHTML = `
    <div class="card-header">
      <h2>${project.name}</h2>
      <span style="font-size:12px;color:var(--text-2)">${project.path}</span>
    </div>
    <div class="card-body">
      <div class="grid-3">
        <div class="stat">
          <span class="label">Catalogue Entries</span>
          <span class="value accent">${catTotal}</span>
        </div>
        <div class="stat">
          <span class="label">Fatality Signals</span>
          <span class="value ${project.fatalitySignals > 0 ? "red" : "green"}">${project.fatalitySignals}</span>
        </div>
        <div class="stat">
          <span class="label">Misaligned</span>
          <span class="value ${project.misalignedInvariants > 0 ? "yellow" : "green"}">${project.misalignedInvariants}</span>
        </div>
        <div class="stat">
          <span class="label">Blind Spots</span>
          <span class="value ${project.blindSpots > 0 ? "yellow" : "green"}">${project.blindSpots}</span>
        </div>
        <div class="stat">
          <span class="label">Memory Entries</span>
          <span class="value accent">${project.memory.length}</span>
        </div>
        <div class="stat">
          <span class="label">Boundaries</span>
          <span class="value accent">${project.boundaries.length}</span>
        </div>
      </div>
    </div>
  `;
  el.appendChild(healthCard);

  // Boundaries panel (if any)
  if (project.boundaries.length > 0) {
    const boundaryCard = document.createElement("div");
    boundaryCard.className = "card";
    boundaryCard.innerHTML = `
      <div class="card-header"><h2>Boundaries (Dharana)</h2></div>
      <div class="card-body" id="boundaries-list"></div>
    `;

    const list = boundaryCard.querySelector("#boundaries-list")!;
    for (const b of project.boundaries) {
      const item = document.createElement("div");
      item.className = "boundary-item";
      item.innerHTML = `
        <span class="boundary-id">${b.id}</span>
        <span class="boundary-name">${b.name}</span>
        ${b.fatality ? '<span class="tag fatality">FATALITY</span>' : ""}
        <span class="boundary-patterns">${b.patternCount} patterns</span>
      `;
      list.appendChild(item);
    }

    el.appendChild(boundaryCard);
  }

  // Catalogues panel
  const catCard = document.createElement("div");
  catCard.className = "card";
  catCard.innerHTML = `<div class="card-header"><h2>Catalogues</h2></div>`;
  const catBody = document.createElement("div");
  catBody.className = "card-body";
  catBody.appendChild(CatalogueTree(project.catalogues));
  catCard.appendChild(catBody);
  el.appendChild(catCard);

  // Memory panel
  if (project.memory.length > 0) {
    const memCard = document.createElement("div");
    memCard.className = "card";
    memCard.innerHTML = `<div class="card-header"><h2>Memory</h2></div>`;
    const memBody = document.createElement("div");
    memBody.className = "card-body";

    for (const m of project.memory) {
      const item = document.createElement("div");
      item.className = "memory-item";
      item.innerHTML = `
        <span class="memory-type ${m.type}">${m.type}</span>
        <span class="memory-name">${escapeHtml(m.name)}</span>
        <span class="memory-desc">${escapeHtml(m.description)}</span>
      `;
      memBody.appendChild(item);
    }

    memCard.appendChild(memBody);
    el.appendChild(memCard);
  }

  return el;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
