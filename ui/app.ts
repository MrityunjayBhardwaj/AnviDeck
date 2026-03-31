import { api } from "./api";
import { CommandCenter } from "./components/CommandCenter";
import { ProjectView } from "./components/ProjectView";
import { Timeline, type TimelineState } from "./components/Timeline";
import { DiffViewer } from "./components/DiffViewer";
import {
  CognitiveTrace,
  addHookEntry,
  addRouteEntry,
  resetTrace,
} from "./components/CognitiveTrace";
import { SystemLens } from "./components/SystemLens";
import { CrossProject } from "./components/CrossProject";
import { RoutingView, addRouteToLog } from "./components/RoutingView";
import {
  ContextBudget,
  addHookToBudget,
  addRouteToBudget,
  resetBudget,
} from "./components/ContextBudget";
import type {
  ProjectSummary,
  ProjectState,
  TimelinePoint,
  WSMessage,
  HookLogEntry,
  RouteLogEntry,
} from "../shared/types";

// State
let currentView: "home" | "project" | "trace" | "system-lens" | "cross-project" | "routing" = "home";
let projects: ProjectSummary[] = [];
let currentProject: ProjectState | null = null;
let timelinePoints: TimelinePoint[] = [];
let timelineState: TimelineState | null = null;
let diffContent: string | null = null;
let wsConnected = false;

const app = document.getElementById("app")!;

function render() {
  app.innerHTML = "";

  // Header
  const header = document.createElement("div");
  header.className = "deck-header";
  header.innerHTML = `
    <h1>Anvi Deck</h1>
    <span class="status ${wsConnected ? "live" : "disconnected"}">${wsConnected ? "live" : "disconnected"}</span>
  `;
  app.appendChild(header);

  // Body
  const body = document.createElement("div");
  body.className = "deck-body";

  // Sidebar
  const sidebar = document.createElement("div");
  sidebar.className = "sidebar";

  // Navigation section
  const nav = document.createElement("div");
  nav.className = "sidebar-section";
  nav.innerHTML = `<h3>Views</h3>`;

  const homeItem = document.createElement("div");
  homeItem.className = `nav-item${currentView === "home" ? " active" : ""}`;
  homeItem.textContent = "Command Center";
  homeItem.addEventListener("click", navigateHome);
  nav.appendChild(homeItem);

  const traceItem = document.createElement("div");
  traceItem.className = `nav-item${currentView === "trace" ? " active" : ""}`;
  traceItem.innerHTML = `Live Trace ${wsConnected ? '<span class="ws-indicator connected"></span>' : '<span class="ws-indicator"></span>'}`;
  traceItem.addEventListener("click", navigateToTrace);
  nav.appendChild(traceItem);

  const lensItem = document.createElement("div");
  lensItem.className = `nav-item${currentView === "system-lens" ? " active" : ""}`;
  lensItem.textContent = "System Lens";
  lensItem.addEventListener("click", navigateToSystemLens);
  nav.appendChild(lensItem);

  const cpItem = document.createElement("div");
  cpItem.className = `nav-item${currentView === "cross-project" ? " active" : ""}`;
  cpItem.textContent = "Cross-Project";
  cpItem.addEventListener("click", navigateToCrossProject);
  nav.appendChild(cpItem);

  const routingItem = document.createElement("div");
  routingItem.className = `nav-item${currentView === "routing" ? " active" : ""}`;
  routingItem.textContent = "Routing";
  routingItem.addEventListener("click", navigateToRouting);
  nav.appendChild(routingItem);

  sidebar.appendChild(nav);

  // Projects section
  const section = document.createElement("div");
  section.className = "sidebar-section";
  section.innerHTML = `<h3>Projects</h3>`;

  const sorted = [...projects].sort((a, b) => {
    const aCount = Object.values(a.catalogueCounts).reduce((s, n) => s + n, 0);
    const bCount = Object.values(b.catalogueCounts).reduce((s, n) => s + n, 0);
    return bCount - aCount;
  });

  for (const p of sorted) {
    const catCount = Object.values(p.catalogueCounts).reduce(
      (s, n) => s + n,
      0
    );
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
  } else if (currentView === "trace") {
    main.appendChild(CognitiveTrace(render));
    main.appendChild(ContextBudget());
  } else if (currentView === "system-lens") {
    main.appendChild(SystemLens(projects, render));
  } else if (currentView === "cross-project") {
    main.appendChild(CrossProject(render));
  } else if (currentView === "routing") {
    main.appendChild(RoutingView(render));
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

function navigateToTrace() {
  currentView = "trace";
  currentProject = null;
  diffContent = null;
  render();
}

function navigateToSystemLens() {
  currentView = "system-lens";
  currentProject = null;
  diffContent = null;
  render();
}

function navigateToCrossProject() {
  currentView = "cross-project";
  currentProject = null;
  diffContent = null;
  render();
}

function navigateToRouting() {
  currentView = "routing";
  currentProject = null;
  diffContent = null;
  render();
}

// WebSocket connection
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function connectWebSocket(): void {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${location.host}/ws`;

  try {
    ws = new WebSocket(url);

    ws.onopen = () => {
      wsConnected = true;
      console.log("[ws] connected");
      render();
    };

    ws.onclose = () => {
      wsConnected = false;
      ws = null;
      console.log("[ws] disconnected, reconnecting in 3s...");
      render();
      reconnectTimer = setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => {
      // onclose will fire after this
    };

    ws.onmessage = (evt) => {
      try {
        const msg: WSMessage = JSON.parse(evt.data);

        if (msg.type === "heartbeat") return;

        if (msg.type === "hook") {
          const entry = msg.data as HookLogEntry;
          addHookEntry(entry);
          addHookToBudget(entry);
        } else if (msg.type === "route") {
          const entry = msg.data as RouteLogEntry;
          addRouteEntry(entry);
          addRouteToBudget(entry);
          addRouteToLog(entry);
        }
      } catch {
        // Ignore malformed messages
      }
    };
  } catch {
    reconnectTimer = setTimeout(connectWebSocket, 3000);
  }
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

  // Start WebSocket connection
  connectWebSocket();
}

init();
