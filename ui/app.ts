import { api } from "./api";
import { HomeScreen, refreshHomeAgents, updateHomeScreen, type HomeInput } from "./components/HomeScreen";
import { ProjectView } from "./components/ProjectView";
import { Timeline, type TimelineState } from "./components/Timeline";
import { DiffViewer } from "./components/DiffViewer";
import { CognitiveTrace, addHookEntry, addRouteEntry } from "./components/CognitiveTrace";
import { SystemLens } from "./components/SystemLens";
import { CrossProject } from "./components/CrossProject";
import { RoutingView, addRouteToLog } from "./components/RoutingView";
import { ContextBudget, addHookToBudget, addRouteToBudget } from "./components/ContextBudget";
import { BrainView, addBrainHookEvent, addBrainRouteEvent } from "./components/BrainView";
import { GitHubTrace } from "./components/GitHubTrace";
import { LiveSessions } from "./components/LiveSessions";
import { AgentsView, parseAgentsHash } from "./components/AgentsView";
import { AgentsScreen, agentsScreenAgents, agentsScreenLine, agentsScreenReconnected } from "./components/AgentsScreen";
import { parseAgentsScreenParams } from "./components/agents-model";
import { needsCount, badgeText, stripText, type HostAsks, type NeedsCount } from "./home-count";
import { permissionQueue, type AskingAgent } from "../shared/permission-requests";
import type { HomeResponse } from "../shared/home-types";
import { MapView } from "./components/MapView";
import { WorkScreen } from "./components/WorkScreen";
import { ChangesScreen } from "./components/ChangesScreen";
import { NotesScreen } from "./components/NotesScreen";
import { DesignScreen } from "./components/DesignScreen";
import { HistoryScreen } from "./components/HistoryScreen";
import { HelpScreen } from "./components/HelpScreen";
import { createTour } from "./shell/tour";
import { createStartAgent } from "./shell/start-agent";
import { parseRoute, screen, type Route, type ScreenId } from "./shell/routes";
import type { AgentsRead, StripAgent } from "./shell/activity";
import { paletteEntries, screenHash, type PaletteEntry } from "./shell/palette-model";
import { createPalette } from "./shell/palette";
import { setPermissionAgents } from "./components/PermissionRequests";
import {
  closePopoversOnOutsideClick,
  olderViews,
  paintRail,
  paintStrip,
  paintTopBar,
  placeholder,
  unknownScreenNote,
} from "./shell/frame";
import type {
  ProjectSummary,
  ProjectState,
  TimelinePoint,
  WSMessage,
  HookLogEntry,
  RouteLogEntry,
} from "../shared/types";

// --- Navigation API (passed to all components for cross-linking) ---
// Every method sets the URL hash; the hashchange handler routes, so each screen has a URL
// that survives a reload (#80).
export interface Nav {
  toHome: () => void;
  toProject: (name: string) => void;
  toTrace: () => void;
  toSystemLens: (project?: string) => void;
  toCrossProject: () => void;
  toRouting: () => void;
  toBrain: (project: string) => void;
  toGitHubTrace: (project?: string) => void;
  toSessions: () => void;
  render: () => void;
}

// State
let route: Route = parseRoute(location.hash);
let projects: ProjectSummary[] = [];
/** When /api/projects was read: the date beside Home's "notes backed by source" (#81). */
let projectsReadAt: string | null = null;
/** The project switcher's pick: kept across reloads, overridden by a project named in the URL. */
const PROJECT_KEY = "anvideck.project";
let currentProjectName: string | null = localStorage.getItem(PROJECT_KEY);
let currentProject: ProjectState | null = null;
/** Set when the project deep dive could not be read: shown, never a blank screen. */
let projectError: string | null = null;
let timelinePoints: TimelinePoint[] = [];
/** Set when the history could not be read (#35): shown in the timeline strip, never as "no history". */
let timelineError: string | null = null;
let timelineState: TimelineState | null = null;
let diffContent: string | null = null;
let wsConnected = false;
let loading = false;
// Home (#18): the queue and its ONE count, set together in setHome() only.
let home: HomeResponse | null = null;
let count: NeedsCount = needsCount(null);
// The activity strip (#80): AnviDeck-started agents from /api/agents, updated by the WebSocket.
let hostAgents: AgentsRead = { state: "loading" };
let stripOpen = false;
const recentEvents: { kind: "ok" | "info" | "warn" | "bad"; text: string }[] = [];

function go(hash: string) {
  if (location.hash === hash) routeTo(parseRoute(hash));
  else location.hash = hash;
}

const nav: Nav = {
  toHome: () => go("#home"),
  toProject: (name: string) => go(screenHash("project", name)),
  toTrace: () => go("#trace"),
  toSystemLens: (project?: string) => {
    // SystemLens picks this up when it mounts.
    if (project) (window as any).__systemLensProject = project;
    go("#system-lens");
  },
  toCrossProject: () => go("#cross-project"),
  toRouting: () => go("#routing"),
  toBrain: (project: string) => go(screenHash("brain", project)),
  toGitHubTrace: (project?: string) => go(screenHash("github-trace", project ?? currentProjectName)),
  toSessions: () => go("#sessions"),
  render,
};

// The frame: created once, never rebuilt. Only the main area swaps between screens.
let topEl: HTMLElement;
let railEl: HTMLElement;
let mainEl: HTMLElement;
let timelineEl: HTMLElement;
let stripEl: HTMLElement;

const app = document.getElementById("app")!;

function ensureStructure() {
  if (topEl) return;
  app.innerHTML = "";
  app.className = "sh-app";
  topEl = document.createElement("header");
  topEl.className = "sh-top";
  railEl = document.createElement("nav");
  railEl.className = "sh-rail";
  railEl.setAttribute("aria-label", "Screens");
  mainEl = document.createElement("main");
  mainEl.className = "sh-main main-content";
  timelineEl = document.createElement("div");
  timelineEl.className = "sh-timeline timeline-wrapper";
  stripEl = document.createElement("footer");
  stripEl.className = "sh-strip";
  stripEl.setAttribute("aria-label", "Live activity");
  app.append(topEl, railEl, mainEl, timelineEl, stripEl);
  closePopoversOnOutsideClick(topEl);
}

function render() {
  ensureStructure();
  renderTop();
  renderRail();
  renderMain();
  renderTimeline();
  renderStrip();
}

function sortedProjects(): ProjectSummary[] {
  const n = (p: ProjectSummary) => (p.sharesNotesWith ? 0 : Object.values(p.catalogueCounts).reduce((s, x) => s + x, 0));
  return [...projects].sort((a, b) => n(b) - n(a));
}

function renderTop() {
  paintTopBar(topEl, {
    projects: sortedProjects(),
    current: currentProjectName,
    onProject: setProject,
    onPalette: () => palette.open(),
  });
}

function renderRail() {
  paintRail(railEl, screen(route.screen).rail, { text: badgeText(count), zero: count.state === "ok" && count.n === 0 }, currentProjectName);
}

function renderStrip() {
  paintStrip(stripEl, {
    wsConnected,
    agents: hostAgents,
    terminals: stripText(count),
    events: recentEvents,
    open: stripOpen,
    onToggle: () => {
      stripOpen = !stripOpen;
      renderStrip();
    },
  });
}

function setProject(name: string) {
  if (!name || !projects.some((p) => p.name === name)) return;
  currentProjectName = name;
  localStorage.setItem(PROJECT_KEY, name);
  renderTop();
  renderRail();
  if (route.screen === "home") return repaintHome(); // Home's grounding row is the picked project's (#81).
  // Screens that show one project follow the switcher.
  const s = route.screen;
  if (s === "project" || s === "brain" || s === "github-trace" || s === "agents") go(screenHash(s, name));
  else if (s === "changes") go(`#changes?project=${encodeURIComponent(name)}`);
  else if (screen(s).group === "project" || s === "older" || s === "notes") renderMain();
}

function renderMain() {
  const id = route.screen;
  const prevView = mainEl.dataset.view;
  const sameView = prevView === id;
  const scrollTop = sameView ? mainEl.scrollTop : 0;

  mainEl.innerHTML = "";
  mainEl.dataset.view = id;

  if (loading) {
    mainEl.innerHTML = `<div class="loading-state"><div class="loading-spinner"></div><span>Loading...</span></div>`;
    return;
  }
  if (route.unknown) mainEl.appendChild(unknownScreenNote(route.unknown));

  const def = screen(id);
  if (def.buildsIn) {
    mainEl.appendChild(placeholder(id, currentProjectName));
  } else if (id === "home") {
    mainEl.appendChild(HomeScreen(homeInput()));
  } else if (id === "older") {
    mainEl.appendChild(olderViews(currentProjectName));
  } else if (id === "project") {
    if (currentProject) mainEl.appendChild(ProjectView(currentProject, nav));
    else mainEl.appendChild(message(projectError ? `Could not read the project — ${projectError}` : "Pick a project in the switcher above."));
  } else if (id === "trace") {
    mainEl.appendChild(CognitiveTrace(nav));
    mainEl.appendChild(ContextBudget());
  } else if (id === "system-lens") {
    mainEl.appendChild(SystemLens(projects, nav));
  } else if (id === "cross-project") {
    mainEl.appendChild(CrossProject(nav));
  } else if (id === "sessions") {
    mainEl.appendChild(LiveSessions(nav));
  } else if (id === "agents" && !parseAgentsScreenParams(route.params).replay) {
    // The Agents screen (#82); the replay view below stays reachable at #agents?view=replay.
    mainEl.appendChild(AgentsScreen({ project: currentProjectName, route: parseAgentsScreenParams(route.params), hostAgents, go, newAgent: () => startAgent.open(currentProjectName) }));
  } else if (id === "agents") {
    const r = parseAgentsHash(`#agents${location.hash.includes("?") ? location.hash.slice(location.hash.indexOf("?")) : ""}`) ?? {};
    if (!r.project && currentProjectName) r.project = currentProjectName;
    mainEl.appendChild(AgentsView(projects.map((p) => p.name), r));
  } else if (id === "map") {
    mainEl.appendChild(MapView(nav));
  } else if (id === "work") {
    mainEl.appendChild(WorkScreen(currentProjectName, route.params, { startAgent: (p, n) => startAgent.open(p, n) }));
  } else if (id === "notes") {
    mainEl.appendChild(NotesScreen(currentProjectName, route.params));
  } else if (id === "design") {
    mainEl.appendChild(DesignScreen(currentProjectName, route.params));
  } else if (id === "history") {
    mainEl.appendChild(HistoryScreen(currentProjectName, route.params));
  } else if (id === "flows") {
    mainEl.appendChild(HelpScreen((i) => tour.start(i)));
  } else if (id === "changes") {
    mainEl.appendChild(ChangesScreen(route.params.get("project") ?? currentProjectName, route.params.get("pr")));
  } else if (id === "routing") {
    mainEl.appendChild(RoutingView(nav));
  } else if (id === "github-trace") {
    const gtProject = route.params.get("project") ?? currentProjectName ?? projects[0]?.name ?? "";
    mainEl.appendChild(GitHubTrace(projects.map((p) => p.name), gtProject, nav));
  } else if (id === "brain") {
    const brainProject = route.params.get("project") ?? currentProjectName ?? projects[0]?.name;
    if (brainProject) mainEl.appendChild(BrainView(brainProject, nav, projects.map((p) => p.name)));
    else mainEl.innerHTML = `<div class="brain-empty"><div class="brain-empty-title">No project selected</div><div class="brain-empty-desc">Pick a project in the switcher above to view its brain.</div></div>`;
  }

  if (diffContent !== null) mainEl.appendChild(DiffViewer(diffContent));
  if (sameView) mainEl.scrollTop = scrollTop;
}

function message(text: string): HTMLElement {
  const d = document.createElement("div");
  d.className = "sh-message";
  d.textContent = text;
  return d;
}

function renderTimeline() {
  const showTimeline = route.screen === "home" || route.screen === "project";
  if (timelineError && showTimeline) {
    timelineEl.innerHTML = "";
    timelineEl.style.display = "";
    const bar = document.createElement("div");
    bar.className = "timeline-bar";
    const msg = document.createElement("div");
    msg.className = "timeline-empty";
    msg.textContent = `Could not read the history — ${timelineError}`;
    bar.appendChild(msg);
    timelineEl.appendChild(bar);
  } else if (timelinePoints.length > 0 && showTimeline) {
    timelineEl.innerHTML = "";
    timelineEl.style.display = "";
    const initialIndex = timelineState?.selectedIndex ?? 0;
    timelineEl.appendChild(Timeline(timelinePoints, initialIndex, onTimelineChange));
  } else {
    timelineEl.innerHTML = "";
    timelineEl.style.display = "none";
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
    } catch (err) {
      diffContent = `Failed to load diff — ${(err as Error).message}`;
    }
  } else {
    diffContent = null;
  }
  renderMain();
}

/** Bumped on every route: a project read that comes back after the user moved on is dropped. */
let routeSeq = 0;

function routeTo(next: Route) {
  const prev = route;
  route = next;
  // A project named in the URL wins over the stored pick.
  const named = next.params.get(next.screen === "project" ? "name" : "project");
  if (named && named !== currentProjectName && projects.some((p) => p.name === named)) {
    currentProjectName = named;
    localStorage.setItem(PROJECT_KEY, named);
    renderTop();
  }
  // The Map keeps its own state in its hash and listens for its own changes.
  if (prev.screen === "map" && next.screen === "map" && mainEl.dataset.view === "map") return;
  if (prev.screen !== next.screen) diffContent = null;
  const seq = ++routeSeq;
  if (next.screen === "project") {
    const name = next.params.get("name") ?? currentProjectName;
    currentProject = null;
    projectError = null;
    if (name) {
      loading = true;
      renderRail();
      renderMain();
      renderTimeline();
      api.project(name).then(
        (p) => {
          if (seq !== routeSeq) return;
          currentProject = p;
        },
        (err: Error) => {
          if (seq !== routeSeq) return;
          projectError = err.message;
          console.error("Failed to load project:", err);
        },
      ).finally(() => {
        if (seq !== routeSeq) return;
        loading = false;
        renderMain();
      });
      return;
    }
  }
  loading = false;
  renderRail();
  renderMain();
  renderTimeline();
}

// The palette (#80)
function paletteData(): PaletteEntry[] {
  return paletteEntries({
    projects: sortedProjects().map((p) => ({ name: p.name, path: p.path })),
    currentProject: currentProjectName,
    hostAgents: hostAgents.state === "ok" ? hostAgents.agents : null,
    terminalAgents: home?.agents ?? [],
  });
}

// "Start an agent on an issue" (#78): its dialog, opened from the palette.
const startAgent = createStartAgent({
  projects: () => sortedProjects().map((p) => p.name),
  started: () => void loadAgents(),
});

const palette = createPalette({
  entries: paletteData,
  choose: (e) => {
    if (e.command === "start-from-issue") startAgent.open(currentProjectName);
    else if (e.flow !== undefined) tour.start(e.flow);
    else if (e.project) setProject(e.project);
    else if (e.hash) go(e.hash);
    else if (e.href) location.href = e.href;
  },
});

// Help's guided flows (#91): they open screens and highlight, never press.
const tour = createTour({ go, project: () => currentProjectName, finished: () => go("#flows") });

// WebSocket
function pushEvent(kind: "ok" | "info" | "warn" | "bad", text: string) {
  recentEvents.unshift({ kind, text });
  recentEvents.length = Math.min(recentEvents.length, 3);
  renderStrip();
}

function upsertAgent(a: StripAgent) {
  if (hostAgents.state !== "ok") return; // the next full read brings it in
  const i = hostAgents.agents.findIndex((x) => x.id === a.id);
  const prev = i === -1 ? null : hostAgents.agents[i];
  if (i === -1) hostAgents.agents.unshift(a);
  else hostAgents.agents[i] = a;
  setPermissionAgents(hostAgents);
  agentsScreenAgents(hostAgents);
  recountAsks();
  if (!prev || prev.status !== a.status) {
    const kind = a.status === "failed" ? "bad" : a.pendingPermissions.length ? "warn" : a.status === "done" ? "ok" : "info";
    pushEvent(kind, `${a.id} · ${a.pendingPermissions.length ? "waiting for permission" : a.status}`);
  } else renderStrip();
}

function connectWebSocket(): void {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${location.host}/ws`;
  try {
    const ws = new WebSocket(url);
    ws.onopen = () => {
      wsConnected = true;
      renderStrip();
      loadAgents(); // anything missed while disconnected
      agentsScreenReconnected(); // and agents' transcript lines sent meanwhile
    };
    ws.onclose = () => {
      wsConnected = false;
      renderStrip();
      setTimeout(connectWebSocket, 3000);
    };
    ws.onerror = () => {};
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data) as WSMessage | { type: "agent"; data: StripAgent };
        if (msg.type === "heartbeat") return;
        if (msg.type === "agent") {
          upsertAgent(msg.data as StripAgent);
        } else if ((msg as { type: string }).type === "agent-message") {
          const m = (msg as unknown as { data: { id: string; line: Parameters<typeof agentsScreenLine>[1] } }).data;
          agentsScreenLine(m.id, m.line);
        } else if (msg.type === "hook") {
          const entry = msg.data as HookLogEntry;
          addHookEntry(entry);
          addHookToBudget(entry);
          addBrainHookEvent(entry);
          pushEvent(entry.fatality ? "warn" : "info", `hook · ${entry.file.split("/").pop()}`);
        } else if (msg.type === "route") {
          const entry = msg.data as RouteLogEntry;
          addRouteEntry(entry);
          addRouteToBudget(entry);
          addRouteToLog(entry);
          addBrainRouteEvent(entry);
        }
      } catch {}
    };
  } catch {
    setTimeout(connectWebSocket, 3000);
  }
}

/** The host's parked requests, for the one Home count (#131): unread when the host could not be read. */
function hostAsks(): HostAsks | undefined {
  if (hostAgents.state === "loading") return undefined;
  if (hostAgents.state !== "ok") return { state: hostAgents.state === "off" ? "off" : "failed" };
  const q = permissionQueue(hostAgents.agents as unknown as AskingAgent[]);
  return { state: "ok", requests: q.requests.length, unreadable: q.unreadable };
}

/** Re-derive Home's one count after the host's agents changed (a request parked or answered). */
function recountAsks() {
  refreshHomeAgents(hostAgents); // Home's agents and answer rows follow the host (#81).
  if (!home) return;
  const next = needsCount(home, false, hostAsks());
  const changed = next.n !== count.n || next.state !== count.state || next.unread !== count.unread;
  count = next;
  renderRail();
  if (changed && route.screen === "home" && !loading) repaintHome();
}

/** What Home is drawn from (#81). */
function homeInput(): HomeInput {
  const project = projects.find((p) => p.name === currentProjectName) ?? null;
  return { home, count, failed: count.state === "failed", host: hostAgents, project, projectsReadAt };
}

/** Patch Home in place (an open permission card keeps focus); build it if it is not on the page. */
function repaintHome() {
  if (loading || !updateHomeScreen(homeInput())) renderMain();
}

async function loadAgents() {
  hostAgents = await api.agentsRead();
  setPermissionAgents(hostAgents);
  agentsScreenAgents(hostAgents);
  recountAsks();
  renderStrip();
}

// Home (#18): the queue loads after the page, so a slow source never holds up the first paint.
function setHome(next: HomeResponse | null, failed = false) {
  home = next;
  count = needsCount(home, failed, hostAsks());
  renderRail();
  renderStrip();
  if (route.screen === "home" && !loading) repaintHome();
}

/** A load that came back with sources still reading asks again soon, not in a minute (#61). */
let homeRetry: ReturnType<typeof setTimeout> | null = null;
const HOME_READING_RETRY_MS = 5_000;

/**
 * Home's count shows in the rail and the strip on every screen, so it is re-read every minute
 * while the tab is visible. A hidden tab asks nothing (each read asks GitHub); it catches up as
 * soon as it is shown again (#46).
 */
const HOME_REFRESH_MS = 60_000;
let homeLoadedAt = 0;
const tabHidden = () => document.visibilityState === "hidden";

async function loadHome() {
  homeLoadedAt = Date.now();
  try {
    const home = await api.home();
    setHome(home);
    if (homeRetry) clearTimeout(homeRetry);
    homeRetry = needsCount(home).reading > 0 ? setTimeout(loadHome, HOME_READING_RETRY_MS) : null;
  } catch (err) {
    console.error("Failed to load /api/home:", err);
    setHome(null, true);
  }
}

async function init() {
  ensureStructure();
  renderStrip();
  mainEl.innerHTML = `<div class="loading-state"><div class="loading-spinner"></div><span>Loading projects...</span></div>`;
  try {
    // The history loads on its own: a git failure must not read as "server down" (#35).
    const [projectsData, timeline] = await Promise.all([
      api.projects(),
      api.timeline(200).then(
        (points) => ({ points, error: null }),
        (err: Error) => ({ points: [] as TimelinePoint[], error: err.message }),
      ),
    ]);
    projects = projectsData;
    projectsReadAt = new Date().toISOString();
    timelinePoints = timeline.points;
    timelineError = timeline.error;
    if (!currentProjectName || !projects.some((p) => p.name === currentProjectName)) currentProjectName = sortedProjects()[0]?.name ?? null;
    renderTop();
    routeTo(parseRoute(location.hash));
  } catch (err) {
    mainEl.innerHTML = `<div class="error-state">Failed to connect to the AnviDeck server: ${(err as Error).message}</div>`;
    console.error(err);
  }
  window.addEventListener("hashchange", () => routeTo(parseRoute(location.hash)));
  connectWebSocket();
  loadAgents();
  loadHome();
  setInterval(() => {
    if (!tabHidden()) loadHome();
  }, HOME_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!tabHidden() && Date.now() - homeLoadedAt >= HOME_REFRESH_MS) loadHome();
  });
}

init();
