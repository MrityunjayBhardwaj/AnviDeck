import type { ProjectState } from "../../shared/types";
import type { Nav } from "../app";
import { CatalogueTree } from "./CatalogueTree";

export function ProjectView(
  project: ProjectState,
  nav: Nav
): HTMLElement {
  const el = document.createElement("div");

  // Breadcrumb
  const breadcrumb = document.createElement("div");
  breadcrumb.className = "breadcrumb";
  const backLink = document.createElement("button");
  backLink.className = "breadcrumb-link";
  backLink.textContent = "Command Center";
  backLink.addEventListener("click", nav.toHome);
  breadcrumb.appendChild(backLink);
  breadcrumb.innerHTML += ` <span class="sep">/</span> <span class="breadcrumb-current">${project.name}</span>`;
  el.appendChild(breadcrumb);

  // Quick links for this project
  const quickLinks = document.createElement("div");
  quickLinks.className = "project-quick-links";

  const links: { label: string; onClick: () => void }[] = [
    { label: "Brain", onClick: () => nav.toBrain(project.name) },
    { label: "System Lens", onClick: () => nav.toSystemLens(project.name) },
    { label: "Live Trace", onClick: nav.toTrace },
    { label: "Cross-Project", onClick: nav.toCrossProject },
  ];

  for (const l of links) {
    const btn = document.createElement("button");
    btn.className = "quick-link-btn";
    btn.textContent = l.label;
    btn.addEventListener("click", l.onClick);
    quickLinks.appendChild(btn);
  }
  el.appendChild(quickLinks);

  // Health summary
  const catTotal = project.catalogues.reduce((s, c) => s + c.entries.length, 0);

  const healthCard = document.createElement("div");
  healthCard.className = "card";
  healthCard.innerHTML = `
    <div class="card-header">
      <h2>${project.name}</h2>
      <span style="font-size:11px;color:var(--text-2)">${project.path}</span>
    </div>
    <div class="card-body">
      <div class="grid-3">
        <div class="stat">
          <span class="value accent">${catTotal}</span>
          <span class="label">Catalogue Entries</span>
        </div>
        <div class="stat">
          <span class="value ${project.fatalitySignals > 0 ? "red" : "green"}">${project.fatalitySignals}</span>
          <span class="label">Fatality Signals</span>
        </div>
        <div class="stat">
          <span class="value ${project.misalignedInvariants > 0 ? "yellow" : "green"}">${project.misalignedInvariants}</span>
          <span class="label">Misaligned</span>
        </div>
        <div class="stat">
          <span class="value ${project.blindSpots > 0 ? "yellow" : "green"}">${project.blindSpots}</span>
          <span class="label">Blind Spots</span>
        </div>
        <div class="stat">
          <span class="value accent">${project.memory.length}</span>
          <span class="label">Memory Entries</span>
        </div>
        <div class="stat">
          <span class="value accent">${project.boundaries.length}</span>
          <span class="label">Boundaries</span>
        </div>
      </div>
    </div>
  `;
  el.appendChild(healthCard);

  // Boundaries panel
  if (project.boundaries.length > 0) {
    const boundaryCard = document.createElement("div");
    boundaryCard.className = "card";
    boundaryCard.innerHTML = `<div class="card-header"><h2>Boundaries (Dharana)</h2></div>`;
    const list = document.createElement("div");
    list.className = "card-body";

    for (const b of project.boundaries) {
      const item = document.createElement("div");
      item.className = `boundary-item${b.fatality ? " fatality" : ""}`;
      item.innerHTML = `
        <span class="boundary-id">${b.id}</span>
        <span class="boundary-name">${b.name}</span>
        ${b.fatality ? '<span class="tag fatality">FATALITY</span>' : ""}
        <span class="boundary-patterns">${b.patternCount} patterns</span>
      `;
      item.title = `${b.id}: ${b.name} — ${b.patternCount} error patterns${b.fatality ? " (FATALITY)" : ""}`;
      list.appendChild(item);
    }

    boundaryCard.appendChild(list);
    el.appendChild(boundaryCard);
  }

  // Catalogues
  const catCard = document.createElement("div");
  catCard.className = "card";
  catCard.innerHTML = `<div class="card-header"><h2>Catalogues</h2></div>`;
  const catBody = document.createElement("div");
  catBody.className = "card-body";
  catBody.appendChild(CatalogueTree(project.catalogues));
  catCard.appendChild(catBody);
  el.appendChild(catCard);

  // Memory
  if (project.memory.length > 0) {
    const memCard = document.createElement("div");
    memCard.className = "card";
    memCard.innerHTML = `<div class="card-header"><h2>Memory (${project.memory.length})</h2></div>`;
    const memBody = document.createElement("div");
    memBody.className = "card-body";

    for (const m of project.memory) {
      const item = document.createElement("div");
      item.className = "memory-item";
      item.title = m.description;
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
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
