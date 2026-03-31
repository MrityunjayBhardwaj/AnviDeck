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

// --- Navigation API (passed to all components for cross-linking) ---
export interface Nav {
  toHome: () => void;
  toProject: (name: string) => void;
  toTrace: () => void;
  toSystemLens: (project?: string) => void;
  toCrossProject: () => void;
  toRouting: () => void;
  render: () => void;
}

// State
type ViewName = "home" | "project" | "trace" | "system-lens" | "cross-project" | "routing";
let currentView: ViewName = "home";
let projects: ProjectSummary[] = [];
let currentProject: ProjectState | null = null;
let timelinePoints: TimelinePoint[] = [];
let timelineState: TimelineState | null = null;
let diffContent: string | null = null;
let wsConnected = false;
let loading = false;
let firstVisit = true;

const nav: Nav = {
  toHome: () => navigateTo("home"),
  toProject: (name: string) => navigateToProject(name),
  toTrace: () => navigateTo("trace"),
  toSystemLens: (project?: string) => {
    navigateTo("system-lens");
    if (project) {
      // SystemLens will pick this up
      (window as any).__systemLensProject = project;
    }
  },
  toCrossProject: () => navigateTo("cross-project"),
  toRouting: () => navigateTo("routing"),
  render,
};

// DOM refs — preserved across renders to prevent flicker
let headerEl: HTMLElement | null = null;
let sidebarEl: HTMLElement | null = null;
let mainEl: HTMLElement | null = null;
let timelineEl: HTMLElement | null = null;

const app = document.getElementById("app")!;

function ensureStructure() {
  if (!headerEl) {
    app.innerHTML = "";

    headerEl = document.createElement("div");
    headerEl.className = "deck-header";
    app.appendChild(headerEl);

    const body = document.createElement("div");
    body.className = "deck-body";

    sidebarEl = document.createElement("div");
    sidebarEl.className = "sidebar";
    body.appendChild(sidebarEl);

    mainEl = document.createElement("div");
    mainEl.className = "main-content";
    body.appendChild(mainEl);

    app.appendChild(body);

    timelineEl = document.createElement("div");
    timelineEl.className = "timeline-wrapper";
    app.appendChild(timelineEl);
  }
}

function render() {
  ensureStructure();
  renderHeader();
  renderSidebar();
  renderMain();
  renderTimeline();
}

function renderHeader() {
  headerEl!.innerHTML = `
    <h1 class="header-title">ANVI DECK</h1>
    <span class="status ${wsConnected ? "live" : "disconnected"}" role="status" aria-label="WebSocket ${wsConnected ? "connected" : "disconnected"}">${wsConnected ? "live" : "disconnected"}</span>
  `;
}

function renderSidebar() {
  sidebarEl!.innerHTML = "";

  // Navigation
  const navSection = document.createElement("div");
  navSection.className = "sidebar-section";
  navSection.innerHTML = `<h3>Views</h3>`;

  const views: { id: ViewName; label: string; extra?: string }[] = [
    { id: "home", label: "Command Center" },
    { id: "trace", label: "Live Trace", extra: wsConnected ? '<span class="ws-indicator connected"></span>' : '<span class="ws-indicator"></span>' },
    { id: "system-lens", label: "System Lens" },
    { id: "cross-project", label: "Cross-Project" },
    { id: "routing", label: "Routing" },
  ];

  for (const v of views) {
    const item = document.createElement("button");
    item.className = `nav-item${currentView === v.id ? " active" : ""}`;
    item.innerHTML = `${v.label} ${v.extra ?? ""}`;
    item.addEventListener("click", () => navigateTo(v.id));
    navSection.appendChild(item);
  }

  sidebarEl!.appendChild(navSection);

  // Projects
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
    const item = document.createElement("button");
    item.className = `project-item${currentView === "project" && currentProject?.name === p.name ? " active" : ""}`;
    item.innerHTML = `
      <span class="name">${p.name}</span>
      ${catCount > 0 ? `<span class="badge has-catalogues">${catCount}</span>` : ""}
      ${p.fatalitySignals > 0 ? `<span class="badge fatality">!</span>` : ""}
    `;
    item.addEventListener("click", () => navigateToProject(p.name));
    section.appendChild(item);
  }

  sidebarEl!.appendChild(section);
}

function renderMain() {
  const prevView = mainEl!.dataset.view;
  const sameView = prevView === currentView;
  const scrollTop = sameView ? mainEl!.scrollTop : 0;

  mainEl!.innerHTML = "";
  mainEl!.dataset.view = currentView;

  if (loading) {
    mainEl!.innerHTML = `<div class="loading-state"><div class="loading-spinner"></div><span>Loading...</span></div>`;
    return;
  }

  if (currentView === "home") {
    mainEl!.appendChild(CommandCenter(projects, nav));
  } else if (currentView === "project" && currentProject) {
    mainEl!.appendChild(ProjectView(currentProject, nav));
  } else if (currentView === "trace") {
    mainEl!.appendChild(CognitiveTrace(nav));
    mainEl!.appendChild(ContextBudget());
  } else if (currentView === "system-lens") {
    mainEl!.appendChild(SystemLens(projects, nav));
  } else if (currentView === "cross-project") {
    mainEl!.appendChild(CrossProject(nav));
  } else if (currentView === "routing") {
    mainEl!.appendChild(RoutingView(nav));
  }

  if (diffContent !== null) {
    mainEl!.appendChild(DiffViewer(diffContent));
  }

  if (sameView) {
    mainEl!.scrollTop = scrollTop;
  }
}

function renderTimeline() {
  if (timelinePoints.length > 0) {
    timelineEl!.innerHTML = "";
    const initialIndex = timelineState?.selectedIndex ?? 0;
    const timeline = Timeline(timelinePoints, initialIndex, onTimelineChange);
    timelineEl!.appendChild(timeline);
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
  renderMain();
}

function navigateTo(view: ViewName) {
  currentView = view;
  currentProject = null;
  diffContent = null;
  loading = false;
  firstVisit = false;
  render();
}

async function navigateToProject(name: string) {
  currentView = "project";
  loading = true;
  diffContent = null;
  firstVisit = false;
  render();
  try {
    currentProject = await api.project(name);
  } catch (err) {
    console.error("Failed to load project:", err);
  }
  loading = false;
  render();
}

// WebSocket
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function connectWebSocket(): void {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${location.host}/ws`;
  try {
    ws = new WebSocket(url);
    ws.onopen = () => {
      wsConnected = true;
      renderHeader();
      renderSidebar();
    };
    ws.onclose = () => {
      wsConnected = false;
      ws = null;
      renderHeader();
      renderSidebar();
      reconnectTimer = setTimeout(connectWebSocket, 3000);
    };
    ws.onerror = () => {};
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
      } catch {}
    };
  } catch {
    reconnectTimer = setTimeout(connectWebSocket, 3000);
  }
}

async function init() {
  ensureStructure();
  mainEl!.innerHTML = `<div class="loading-state"><div class="loading-spinner"></div><span>Loading projects...</span></div>`;
  try {
    const [projectsData, timeline] = await Promise.all([
      api.projects(),
      api.timeline(200),
    ]);
    projects = projectsData;
    timelinePoints = timeline;
    render();
  } catch (err) {
    mainEl!.innerHTML = `<div class="error-state">Failed to connect to AnviDeck server. Is it running on port 3000?</div>`;
    console.error(err);
  }
  connectWebSocket();
}

init();
