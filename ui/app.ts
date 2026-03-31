import { api } from "./api";
import { CommandCenter } from "./components/CommandCenter";
import { ProjectView } from "./components/ProjectView";
import type { ProjectSummary, ProjectState } from "../shared/types";

// State
let currentView: "home" | "project" = "home";
let projects: ProjectSummary[] = [];
let currentProject: ProjectState | null = null;

const app = document.getElementById("app")!;

function render() {
  app.innerHTML = "";

  // Header
  const header = document.createElement("div");
  header.className = "deck-header";
  header.innerHTML = `
    <h1>Anvi Deck</h1>
    <span class="status live">live</span>
  `;
  app.appendChild(header);

  // Body
  const body = document.createElement("div");
  body.className = "deck-body";

  // Sidebar
  const sidebar = document.createElement("div");
  sidebar.className = "sidebar";

  const section = document.createElement("div");
  section.className = "sidebar-section";
  section.innerHTML = `<h3>Projects</h3>`;

  const sorted = [...projects].sort((a, b) => {
    const aCount = Object.values(a.catalogueCounts).reduce((s, n) => s + n, 0);
    const bCount = Object.values(b.catalogueCounts).reduce((s, n) => s + n, 0);
    return bCount - aCount;
  });

  for (const p of sorted) {
    const catCount = Object.values(p.catalogueCounts).reduce((s, n) => s + n, 0);
    const item = document.createElement("div");
    item.className = `project-item${currentView === "project" && currentProject?.name === p.name ? " active" : ""}`;
    item.innerHTML = `
      <span class="name">${p.name}</span>
      ${catCount > 0 ? `<span class="badge has-catalogues">${catCount}</span>` : ""}
      ${p.fatalitySignals > 0 ? `<span class="badge fatality">!</span>` : ""}
    `;
    item.addEventListener("click", () => navigateToProject(p.name));
    section.appendChild(item);
  }

  sidebar.appendChild(section);
  body.appendChild(sidebar);

  // Main content
  const main = document.createElement("div");
  main.className = "main-content";

  if (currentView === "home") {
    main.appendChild(CommandCenter(projects, navigateToProject));
  } else if (currentView === "project" && currentProject) {
    main.appendChild(ProjectView(currentProject, navigateHome));
  }

  body.appendChild(main);
  app.appendChild(body);
}

async function navigateToProject(name: string) {
  try {
    currentProject = await api.project(name);
    currentView = "project";
    render();
  } catch (err) {
    console.error("Failed to load project:", err);
  }
}

function navigateHome() {
  currentView = "home";
  currentProject = null;
  render();
}

// Initial load
async function init() {
  try {
    projects = await api.projects();
    render();
  } catch (err) {
    app.innerHTML = `<div style="padding:20px;color:var(--red)">Failed to connect to AnviDeck server. Is it running on port 3000?</div>`;
    console.error(err);
  }
}

init();
