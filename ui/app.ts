import { api } from "./api";
import { CommandCenter } from "./components/CommandCenter";
import { ProjectView } from "./components/ProjectView";
import { Timeline, type TimelineState } from "./components/Timeline";
import { DiffViewer } from "./components/DiffViewer";
import type { ProjectSummary, ProjectState, TimelinePoint } from "../shared/types";

// State
let currentView: "home" | "project" = "home";
let projects: ProjectSummary[] = [];
let currentProject: ProjectState | null = null;
let timelinePoints: TimelinePoint[] = [];
let timelineState: TimelineState | null = null;
let diffContent: string | null = null;

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

  // Show diff viewer if in diff mode
  if (diffContent !== null) {
    main.appendChild(DiffViewer(diffContent));
  }

  body.appendChild(main);
  app.appendChild(body);

  // Timeline bar at the bottom
  if (timelinePoints.length > 0) {
    const initialIndex = timelineState?.selectedIndex ?? 0;
    const timeline = Timeline(timelinePoints, initialIndex, onTimelineChange);
    app.appendChild(timeline);
  }
}

async function onTimelineChange(state: TimelineState) {
  timelineState = state;

  if (state.diffFromIndex !== null) {
    // Diff mode: fetch diff between two commits
    const from = state.points[state.diffFromIndex];
    const to = state.points[state.selectedIndex];
    try {
      const result = await api.diff(from.hash, to.hash);
      diffContent = result.diff;
    } catch {
      diffContent = "Failed to load diff";
    }
  } else {
    diffContent = null;
  }

  render();
}

async function navigateToProject(name: string) {
  try {
    currentProject = await api.project(name);
    currentView = "project";
    diffContent = null;
    render();
  } catch (err) {
    console.error("Failed to load project:", err);
  }
}

function navigateHome() {
  currentView = "home";
  currentProject = null;
  diffContent = null;
  render();
}

// Initial load
async function init() {
  try {
    const [projectsData, timeline] = await Promise.all([
      api.projects(),
      api.timeline(200),
    ]);
    projects = projectsData;
    timelinePoints = timeline;
    render();
  } catch (err) {
    app.innerHTML = `<div style="padding:20px;color:var(--red)">Failed to connect to AnviDeck server. Is it running on port 3000?</div>`;
    console.error(err);
  }
}

init();
