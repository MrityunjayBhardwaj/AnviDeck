import { api } from "../api";
import type {
  ProjectState,
  CatalogueEntry,
  BrainBoundaryNode,
  BrainStratum,
  BrainFlowEvent,
  HookLogEntry,
  HookLogSession,
  RouteLogEntry,
  GitHubTrace as GitHubTraceT,
  EntryTrace,
  GitHubArtifact,
} from "../../shared/types";
import type { Nav } from "../app";

// ============================================================
// State
// ============================================================

interface Selection {
  type: "entry" | "boundary" | "artifact";
  id: string;
}

interface BrainState {
  projectName: string | null;
  project: ProjectState | null;
  dates: Record<string, { created: string; lastModified: string }>;
  githubTrace: GitHubTraceT | null;
  sessions: HookLogSession[];
  flowEvents: BrainFlowEvent[];
  mode: "project" | "session";
  activeSessionId: string | null;
  obsStart: number;   // observation window 0-1 fraction of session
  obsEnd: number;
  selection: Selection | null;
  loading: boolean;
}

const S: BrainState = {
  projectName: null,
  project: null,
  dates: {},
  githubTrace: null,
  sessions: [],
  flowEvents: [],
  mode: "project",
  activeSessionId: null,
  obsStart: 0,
  obsEnd: 1,
  selection: null,
  loading: false,
};

let renderCb: (() => void) | null = null;

// ============================================================
// Data loading
// ============================================================

async function loadBrainData(name: string): Promise<void> {
  if (S.projectName === name && S.project) return;
  const isSwitch = S.projectName !== name;
  S.loading = true;
  S.projectName = name;
  // Only clear state on project switch — keep stale data visible during reload
  if (isSwitch) {
    S.project = null;
    S.dates = {};
    S.githubTrace = null;
    S.flowEvents = [];
    S.sessions = [];
    S.selection = null;
  }
  // No renderCb here — avoid flashing spinner over existing content

  try {
    const { project, dates, hookLogs } = await api.brainData(name);
    S.project = project;
    S.dates = dates;
    S.sessions = hookLogs.sessions ?? [];
    S.flowEvents = [];
    for (const sess of S.sessions) {
      for (const entry of sess.entries) {
        pushHookEvent(entry);
      }
    }
    if (S.sessions.length > 0) {
      S.activeSessionId = S.sessions[S.sessions.length - 1].sid;
    }
  } catch (err) {
    console.error("Failed to load brain data:", err);
  }
  S.loading = false;
  renderCb?.();

  // Load GitHub trace in background — single render when done
  try {
    S.githubTrace = await api.githubTrace(name);
  } catch {}
  renderCb?.();
}

function pushHookEvent(entry: HookLogEntry): void {
  S.flowEvents.push({
    ts: entry.ts,
    tier: 2,
    label: entry.boundaries.join(", ") || (entry.file.split("/").pop() || entry.file),
    fatality: entry.fatality,
    patterns: entry.patterns ?? [],
    source: "hook",
  });
}

// Public: called from app.ts WebSocket
export function addBrainHookEvent(entry: HookLogEntry): void {
  pushHookEvent(entry);
  if (S.flowEvents.length > 500) S.flowEvents.shift();
  renderCb?.();
}

export function addBrainRouteEvent(entry: RouteLogEntry): void {
  S.flowEvents.push({
    ts: entry.ts,
    tier: 3,
    label: entry.category,
    fatality: false,
    patterns: [],
    source: "route",
  });
  if (S.flowEvents.length > 500) S.flowEvents.shift();
  renderCb?.();
}

// ============================================================
// Selection helpers
// ============================================================

function select(type: Selection["type"], id: string): void {
  if (S.selection?.type === type && S.selection?.id === id) {
    S.selection = null;
  } else {
    S.selection = { type, id };
  }
  renderCb?.();
}

function isSelected(type: Selection["type"], id: string): boolean {
  return S.selection?.type === type && S.selection?.id === id;
}

function isHighlighted(entryId: string): boolean {
  if (!S.selection) return true;
  if (S.selection.type === "entry" && S.selection.id === entryId) return true;
  if (S.selection.type === "boundary") {
    const nodes = S.project ? buildBoundaryNodes(S.project) : [];
    const node = nodes.find((n) => n.id === S.selection!.id);
    return node ? node.linkedEntries.includes(entryId) : false;
  }
  if (S.selection.type === "artifact" && S.githubTrace) {
    for (const et of S.githubTrace.entries) {
      for (const a of et.artifacts) {
        if (a.id === S.selection.id && et.entryId === entryId) return true;
      }
    }
  }
  return false;
}

// ============================================================
// Data builders
// ============================================================

const BOUNDARY_ID_RE = /\b(B\d+)\b/g;

function extractBoundaryRefs(entry: CatalogueEntry): string[] {
  const text = [entry.origin ?? "", entry.why ?? "", ...Object.values(entry.sections)].join(" ");
  const m = text.match(BOUNDARY_ID_RE);
  return m ? [...new Set(m)] : [];
}

function buildBoundaryNodes(project: ProjectState): BrainBoundaryNode[] {
  const dharana = project.catalogues.find((c) => c.name === "dharana");
  if (!dharana) return [];
  const nodes: BrainBoundaryNode[] = dharana.entries
    .filter((e) => e.id.startsWith("B"))
    .map((e) => ({ id: e.id, name: e.title, patternCount: 0, fatality: e.tags.includes("FATALITY"), linkedEntries: [] as string[] }));
  for (const cat of project.catalogues) {
    for (const entry of cat.entries) {
      for (const ref of extractBoundaryRefs(entry)) {
        const node = nodes.find((n) => n.id === ref);
        if (node) { node.patternCount++; if (!node.linkedEntries.includes(entry.id)) node.linkedEntries.push(entry.id); }
      }
    }
  }
  return nodes.sort((a, b) => b.patternCount - a.patternCount);
}

function buildStrata(project: ProjectState): BrainStratum[] {
  return [
    { name: "Traps", catalogue: "hetvabhasa", entries: project.catalogues.find((c) => c.name === "hetvabhasa")?.entries ?? [], color: "var(--red)" },
    { name: "Rules", catalogue: "vyapti", entries: project.catalogues.find((c) => c.name === "vyapti")?.entries ?? [], color: "var(--cyan)" },
    { name: "Sequences", catalogue: "krama", entries: project.catalogues.find((c) => c.name === "krama")?.entries ?? [], color: "var(--yellow)" },
  ];
}

function sevColor(entry: CatalogueEntry): string {
  if (entry.tags.includes("FATALITY")) return "var(--red)";
  if (entry.tags.includes("MISALIGNED")) return "var(--yellow)";
  if (entry.tags.includes("BLIND SPOT")) return "var(--orange)";
  return "var(--text-2)";
}

const CAT_COLORS: Record<string, string> = { hetvabhasa: "var(--red)", vyapti: "var(--cyan)", krama: "var(--yellow)", dharana: "var(--text-1)" };

// ============================================================
// PROJECT MODE
// ============================================================

function renderProjectMode(project: ProjectState): HTMLElement {
  const el = document.createElement("div");
  el.className = "brain-project-mode";

  const nodes = buildBoundaryNodes(project);
  const strata = buildStrata(project);
  const totalEntries = strata.reduce((s, st) => s + st.entries.length, 0);

  if (nodes.length === 0 && totalEntries === 0) {
    el.innerHTML = `<div class="brain-empty"><div class="brain-empty-title">No catalogues found</div><div class="brain-empty-desc">Run /anvi:init on this project to initialize catalogues.</div></div>`;
    return el;
  }

  // ---- Boundaries ----
  if (nodes.length > 0) {
    const sec = document.createElement("div");
    sec.className = "brain-section";
    sec.innerHTML = `<div class="brain-stratum-header"><span class="stratum-label" style="color:var(--text-1)">BOUNDARIES</span><span class="stratum-count">${nodes.length}</span></div>`;
    const cards = document.createElement("div");
    cards.className = "boundary-cards";
    const maxCount = Math.max(...nodes.map((n) => n.patternCount), 1);
    for (const node of nodes) {
      const color = node.fatality ? "var(--red)" : node.patternCount > 2 ? "var(--yellow)" : "var(--green)";
      // Check if boundary has Ground Truth coverage
      const gtDocs = project.grounding?.groundTruthDocs ?? [];
      const boundaryWords = node.name.toLowerCase().split(/[\s↔←→\-]+/).filter((w) => w.length > 2);
      const hasGT = gtDocs.some((doc) => {
        const sys = doc.system.toLowerCase();
        if (sys.length <= 2) return false;
        // Bidirectional: a boundary identifier concatenates the GT subject with a
        // suffix (e.g. "SuperSonicBridge" ⊇ "supersonic"), so the doc system is a
        // substring of the boundary word — not the reverse. Match either direction.
        return boundaryWords.some((w) => sys.includes(w) || w.includes(sys));
      });

      const card = document.createElement("div");
      card.className = `boundary-card${node.fatality ? " fatality" : ""}${isSelected("boundary", node.id) ? " selected" : ""}${hasGT ? "" : " opaque"}`;
      card.innerHTML = `<div class="boundary-id" style="color:${color}">${node.id}${hasGT ? "" : ' <span class="opaque-tag">OPAQUE</span>'}</div><div class="boundary-name">${node.name}</div><div class="boundary-bar-container"><div class="boundary-bar-fill" style="width:${Math.max((node.patternCount / maxCount) * 100, 4)}%;background:${color}"></div></div><div class="boundary-meta">${node.patternCount} entries${node.fatality ? ' <span class="fatality-tag">FATALITY</span>' : ""}</div>`;
      card.addEventListener("click", () => select("boundary", node.id));
      cards.appendChild(card);
    }
    sec.appendChild(cards);
    el.appendChild(sec);
  }

  // ---- Strata (3 columns) ----
  const strataRow = document.createElement("div");
  strataRow.className = "brain-strata-row";
  for (const stratum of strata) {
    const col = document.createElement("div");
    col.className = "brain-stratum-col";
    col.innerHTML = `<div class="brain-stratum-header"><span class="stratum-label" style="color:${stratum.color}">${stratum.name.toUpperCase()}</span><span class="stratum-count">${stratum.entries.length}</span></div>`;
    if (stratum.entries.length === 0) {
      col.innerHTML += `<div class="brain-empty-inline">None yet.</div>`;
    } else {
      const list = document.createElement("div");
      list.className = "stratum-list";
      for (const entry of stratum.entries) {
        const hl = isHighlighted(entry.id);
        const row = document.createElement("div");
        row.className = `stratum-entry${hl ? "" : " dimmed"}${isSelected("entry", entry.id) ? " sel" : ""}`;
        const refs = extractBoundaryRefs(entry).map((r) => `<span class="boundary-dot">${r}</span>`).join("");
        const tags = entry.tags.filter((t) => ["FATALITY", "MISALIGNED", "BLIND SPOT"].includes(t)).map((t) => `<span class="entry-tag" style="color:${sevColor({ tags: [t] } as CatalogueEntry)}">${t}</span>`).join("");
        row.innerHTML = `<span class="entry-id" style="color:${sevColor(entry)}">${entry.id}</span><span class="entry-title">${entry.title}</span>${refs ? `<span class="entry-boundary-refs">${refs}</span>` : ""}${tags}`;
        row.addEventListener("click", () => select("entry", entry.id));
        list.appendChild(row);
      }
      col.appendChild(list);
    }
    strataRow.appendChild(col);
  }
  el.appendChild(strataRow);

  // ---- Flow aggregate ----
  if (S.sessions.length > 0) {
    const sec = document.createElement("div");
    sec.className = "brain-section";
    sec.innerHTML = `<div class="brain-stratum-header"><span class="stratum-label" style="color:var(--accent)">FLOW</span><span class="stratum-count">${S.sessions.length} sessions · ${S.flowEvents.filter((e) => e.source === "hook").length} fires</span></div>`;
    const flowGrid = document.createElement("div");
    flowGrid.className = "brain-flow-grid";

    // Fires by boundary bar chart
    const boundaryFires: Record<string, number> = {};
    for (const ev of S.flowEvents) {
      if (ev.source !== "hook") continue;
      for (const b of ev.label.split(", ").filter(Boolean)) {
        boundaryFires[b] = (boundaryFires[b] ?? 0) + 1;
      }
    }
    const sortedBoundaries = Object.entries(boundaryFires).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const maxFires = sortedBoundaries[0]?.[1] ?? 1;

    const barsDiv = document.createElement("div");
    barsDiv.className = "flow-agg-bars";
    barsDiv.innerHTML = `<div class="flow-agg-title">Fires by boundary</div>`;
    for (const [bid, count] of sortedBoundaries) {
      const w = Math.max((count / maxFires) * 100, 3);
      const row = document.createElement("div");
      row.className = `flow-agg-bar-row${isSelected("boundary", bid) ? " sel" : ""}`;
      row.innerHTML = `<span class="flow-agg-bid">${bid}</span><div class="flow-agg-bar"><div class="flow-agg-bar-fill" style="width:${w}%;background:var(--accent)"></div></div><span class="flow-agg-count">${count}</span>`;
      row.addEventListener("click", () => select("boundary", bid));
      barsDiv.appendChild(row);
    }
    flowGrid.appendChild(barsDiv);

    // Top activated entries
    const entryFires: Record<string, number> = {};
    for (const ev of S.flowEvents) {
      for (const p of ev.patterns) { entryFires[p] = (entryFires[p] ?? 0) + 1; }
    }
    const sortedEntries = Object.entries(entryFires).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const maxEFires = sortedEntries[0]?.[1] ?? 1;

    const entriesDiv = document.createElement("div");
    entriesDiv.className = "flow-agg-bars";
    entriesDiv.innerHTML = `<div class="flow-agg-title">Top activated entries</div>`;
    for (const [eid, count] of sortedEntries) {
      const w = Math.max((count / maxEFires) * 100, 3);
      const row = document.createElement("div");
      row.className = `flow-agg-bar-row${isSelected("entry", eid) ? " sel" : ""}`;
      row.innerHTML = `<span class="flow-agg-bid">${eid}</span><div class="flow-agg-bar"><div class="flow-agg-bar-fill" style="width:${w}%;background:var(--cyan)"></div></div><span class="flow-agg-count">${count}</span>`;
      row.addEventListener("click", () => select("entry", eid));
      entriesDiv.appendChild(row);
    }
    flowGrid.appendChild(entriesDiv);

    // Fatality stats
    const fatalityFires = S.flowEvents.filter((e) => e.fatality).length;
    const totalHookFires = S.flowEvents.filter((e) => e.source === "hook").length;
    const pct = totalHookFires > 0 ? Math.round((fatalityFires / totalHookFires) * 100) : 0;
    const statsDiv = document.createElement("div");
    statsDiv.className = "flow-agg-stats";
    statsDiv.innerHTML = `<div class="flow-agg-title">Stats</div><div class="sidebar-meta-row"><span>Fatality fires</span><span class="val ${fatalityFires > 0 ? "red" : ""}">${fatalityFires} (${pct}%)</span></div><div class="sidebar-meta-row"><span>Sessions</span><span class="val">${S.sessions.length}</span></div>`;
    flowGrid.appendChild(statsDiv);

    sec.appendChild(flowGrid);
    el.appendChild(sec);
  }

  // ---- Bottom row: GitHub + Evolution ----
  const bottomRow = document.createElement("div");
  bottomRow.className = "brain-bottom-row";

  // GitHub
  const ghSec = document.createElement("div");
  ghSec.className = "brain-section brain-bottom-half";
  ghSec.innerHTML = `<div class="brain-stratum-header"><span class="stratum-label" style="color:var(--green)">GITHUB ARTIFACTS</span></div>`;
  if (!S.githubTrace && S.loading) {
    ghSec.innerHTML += `<div class="brain-empty-inline">Loading GitHub trace...</div>`;
  } else if (S.githubTrace && S.githubTrace.entries.length > 0) {
    const linked = S.githubTrace.entries.filter((e) => e.artifacts.length > 0);
    const filtered = S.selection ? linked.filter((e) => isHighlighted(e.entryId)) : linked;
    const list = document.createElement("div");
    list.className = "brain-gh-list";
    for (const et of filtered.slice(0, 8)) {
      for (const a of et.artifacts.slice(0, 3)) {
        const row = document.createElement("div");
        row.className = `brain-gh-row${isSelected("artifact", a.id) ? " sel" : ""}`;
        const aColor = a.type === "issue" ? "var(--red)" : a.type === "pr" ? "var(--cyan)" : "var(--yellow)";
        row.innerHTML = `<span class="entry-id" style="color:${CAT_COLORS[et.catalogue] ?? "var(--text-2)"}">${et.entryId}</span><span style="color:var(--text-2)">→</span><span style="color:${aColor}">${a.id}</span><span class="artifact-conf ${a.confidence}">${a.confidence.toUpperCase()}</span><span class="entry-title">${a.title.slice(0, 40)}${a.title.length > 40 ? "…" : ""}</span>`;
        row.addEventListener("click", () => select("artifact", a.id));
        list.appendChild(row);
      }
    }
    ghSec.appendChild(list);
    const summary = document.createElement("div");
    summary.className = "brain-empty-inline";
    summary.textContent = `${S.githubTrace.correlationCount} linked · ${S.githubTrace.artifactCount.issues} issues · ${S.githubTrace.artifactCount.prs} PRs · ${S.githubTrace.artifactCount.commits} commits`;
    ghSec.appendChild(summary);
  } else {
    ghSec.innerHTML += `<div class="brain-empty-inline">No GitHub artifacts linked.</div>`;
  }
  bottomRow.appendChild(ghSec);

  // Evolution
  const evoSec = document.createElement("div");
  evoSec.className = "brain-section brain-bottom-half";
  evoSec.innerHTML = `<div class="brain-stratum-header"><span class="stratum-label" style="color:var(--accent)">EVOLUTION</span></div>`;

  const dated: { ts: number; catalogue: string; id: string; tags: string[] }[] = [];
  for (const cat of project.catalogues) {
    for (const entry of cat.entries) {
      const d = S.dates[entry.id];
      if (d) dated.push({ ts: new Date(d.created).getTime(), catalogue: cat.name, id: entry.id, tags: entry.tags });
    }
  }
  dated.sort((a, b) => a.ts - b.ts);

  if (dated.length > 0) {
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", "evo-chart");
    svg.setAttribute("viewBox", "0 0 300 80");
    svg.setAttribute("preserveAspectRatio", "none");
    const minTs = dated[0].ts;
    const maxTs = dated[dated.length - 1].ts;
    const span = Math.max(maxTs - minTs, 1);
    const pts: string[] = [];
    for (let i = 0; i < dated.length; i++) {
      const x = 4 + ((dated[i].ts - minTs) / span) * 290;
      const y = 72 - ((i + 1) / dated.length) * 62;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      const hl = isHighlighted(dated[i].id);
      const circle = document.createElementNS(svgNS, "circle");
      circle.setAttribute("cx", x.toFixed(1));
      circle.setAttribute("cy", y.toFixed(1));
      circle.setAttribute("r", hl ? "2.5" : "1.5");
      circle.setAttribute("fill", hl ? "var(--accent)" : "var(--bg-3)");
      svg.appendChild(circle);
    }
    const path = document.createElementNS(svgNS, "path");
    path.setAttribute("d", `M4,72 L${pts.join(" L")}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "var(--accent)");
    path.setAttribute("stroke-width", "1.5");
    svg.appendChild(path);
    // Y label
    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("x", "2");
    label.setAttribute("y", "12");
    label.setAttribute("fill", "var(--text-2)");
    label.setAttribute("font-size", "7");
    label.textContent = String(dated.length);
    svg.appendChild(label);
    evoSec.appendChild(svg);

    // Key moments
    const moments = dated.filter((e) => e.tags.some((t) => ["FATALITY", "MISALIGNED", "BLIND SPOT"].includes(t)));
    if (moments.length > 0) {
      const mList = document.createElement("div");
      mList.className = "evo-moments";
      for (const m of moments.slice(0, 4)) {
        const mEl = document.createElement("div");
        mEl.className = `evo-moment-row${isHighlighted(m.id) ? "" : " dimmed"}`;
        mEl.innerHTML = `<span class="evo-star">★</span><span class="evo-entry-id">${m.id}</span><span class="evo-tags" style="color:${m.tags.includes("FATALITY") ? "var(--red)" : "var(--yellow)"}">${m.tags.filter((t) => ["FATALITY", "MISALIGNED", "BLIND SPOT"].includes(t)).join(", ")}</span>`;
        mEl.addEventListener("click", () => select("entry", m.id));
        mList.appendChild(mEl);
      }
      evoSec.appendChild(mList);
    }
    evoSec.innerHTML += `<div class="brain-empty-inline">${dated.length} entries across ${S.sessions.length || "?"} sessions</div>`;
  } else {
    evoSec.innerHTML += `<div class="brain-empty-inline">No creation dates available.</div>`;
  }
  bottomRow.appendChild(evoSec);
  el.appendChild(bottomRow);

  return el;
}

// ============================================================
// SESSION MODE
// ============================================================

function getSessionEvents(sid: string): BrainFlowEvent[] {
  const session = S.sessions.find((s) => s.sid === sid);
  if (!session) return S.flowEvents; // fallback to all
  // Rebuild from session entries
  const events: BrainFlowEvent[] = [];
  for (const entry of session.entries) {
    events.push({
      ts: entry.ts,
      tier: 2,
      label: entry.boundaries.join(", ") || (entry.file.split("/").pop() || entry.file),
      fatality: entry.fatality,
      patterns: entry.patterns ?? [],
      source: "hook",
    });
  }
  // Also include route events that fall within session time range
  if (events.length > 0) {
    const minTs = new Date(events[0].ts).getTime() - 60000;
    const maxTs = new Date(events[events.length - 1].ts).getTime() + 60000;
    for (const ev of S.flowEvents) {
      if (ev.source === "route") {
        const t = new Date(ev.ts).getTime();
        if (t >= minTs && t <= maxTs) events.push(ev);
      }
    }
    events.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  }
  return events;
}

function renderSessionMode(): HTMLElement {
  const el = document.createElement("div");
  el.className = "brain-session-mode";

  const sid = S.activeSessionId;
  if (!sid || S.sessions.length === 0) {
    el.innerHTML = `<div class="brain-empty"><div class="brain-empty-title">No session data</div><div class="brain-empty-desc">Start a Claude session on this project to see cognitive flow.</div></div>`;
    return el;
  }

  // Session selector bar
  const sessBar = document.createElement("div");
  sessBar.className = "brain-sess-bar";
  const sessSel = document.createElement("select");
  sessSel.className = "brain-project-select";
  for (const sess of S.sessions) {
    const opt = document.createElement("option");
    opt.value = sess.sid;
    opt.textContent = `${sess.sid.slice(0, 8)} (${sess.totalFires} fires)`;
    if (sess.sid === sid) opt.selected = true;
    sessSel.appendChild(opt);
  }
  sessSel.addEventListener("change", () => {
    S.activeSessionId = sessSel.value;
    S.obsStart = 0;
    S.obsEnd = 1;
    renderCb?.();
  });
  const sessLabel = document.createElement("span");
  sessLabel.className = "brain-sess-label";
  sessLabel.textContent = "Session:";
  sessBar.appendChild(sessLabel);
  sessBar.appendChild(sessSel);

  const isLive = S.sessions[S.sessions.length - 1]?.sid === sid;
  if (isLive) {
    const liveBadge = document.createElement("span");
    liveBadge.className = "brain-live-badge";
    liveBadge.textContent = "● LIVE";
    sessBar.appendChild(liveBadge);
  }

  const events = getSessionEvents(sid);
  const sessStats = document.createElement("span");
  sessStats.className = "brain-sess-stats";
  sessStats.textContent = `${events.filter((e) => e.source === "hook").length} fires · ${events.filter((e) => e.source === "route").length} routes`;
  sessBar.appendChild(sessStats);
  el.appendChild(sessBar);

  if (events.length === 0) {
    el.innerHTML += `<div class="brain-empty-inline">No events in this session.</div>`;
    return el;
  }

  // ---- Spike trail (global view) ----
  const allTs = events.map((e) => new Date(e.ts).getTime());
  const minTs = Math.min(...allTs);
  const maxTs = Math.max(...allTs);
  const span = Math.max(maxTs - minTs, 1);
  const toFrac = (ts: string) => (new Date(ts).getTime() - minTs) / span;

  const trail = document.createElement("div");
  trail.className = "spike-trail";

  // T1 lane
  const t1 = document.createElement("div");
  t1.className = "spike-lane";
  t1.innerHTML = `<span class="spike-lane-label">T1</span><div class="spike-lane-track"><div class="spike-t1-bar"></div></div>`;
  trail.appendChild(t1);

  // T3 lane
  const t3 = document.createElement("div");
  t3.className = "spike-lane";
  const t3Track = document.createElement("div");
  t3Track.className = "spike-lane-track";
  for (const ev of events.filter((e) => e.source === "route")) {
    const left = toFrac(ev.ts) * 100;
    const block = document.createElement("div");
    block.className = "spike-route-block";
    block.style.left = `${left}%`;
    block.textContent = ev.label.slice(0, 5).toUpperCase();
    t3Track.appendChild(block);
  }
  t3.innerHTML = `<span class="spike-lane-label">T3</span>`;
  t3.appendChild(t3Track);
  trail.appendChild(t3);

  // T2 lane (spikes)
  const t2 = document.createElement("div");
  t2.className = "spike-lane spike-lane-tall";
  const t2Track = document.createElement("div");
  t2Track.className = "spike-lane-track spike-track-tall";

  const hookEvts = events.filter((e) => e.source === "hook");
  const maxPatterns = Math.max(...hookEvts.map((e) => e.patterns.length), 1);

  for (const ev of hookEvts) {
    const left = toFrac(ev.ts) * 100;
    const h = Math.max((ev.patterns.length / maxPatterns) * 100, 15);
    const inWindow = toFrac(ev.ts) >= S.obsStart && toFrac(ev.ts) <= S.obsEnd;
    const matchesSelection = !S.selection || (S.selection.type === "entry" && ev.patterns.includes(S.selection.id)) || (S.selection.type === "boundary" && ev.label.includes(S.selection.id));

    const spike = document.createElement("div");
    spike.className = `spike-mark${ev.fatality ? " fatality" : ""}${inWindow ? " in-window" : ""}${matchesSelection ? "" : " dimmed"}`;
    spike.style.left = `${left}%`;
    spike.style.height = `${h}%`;

    if (ev.fatality) {
      const warn = document.createElement("div");
      warn.className = "spike-warn";
      warn.textContent = "⚠";
      spike.appendChild(warn);
    }

    const lbl = document.createElement("div");
    lbl.className = "spike-label";
    lbl.textContent = ev.label.split(", ")[0] || "";
    spike.appendChild(lbl);

    t2Track.appendChild(spike);
  }

  t2.innerHTML = `<span class="spike-lane-label">T2</span>`;
  t2.appendChild(t2Track);
  trail.appendChild(t2);

  // Time axis
  const axis = document.createElement("div");
  axis.className = "spike-axis";
  const tickCount = Math.min(events.length, 6);
  for (let i = 0; i < tickCount; i++) {
    const idx = Math.floor((i / (tickCount - 1 || 1)) * (events.length - 1));
    const ev = events[idx];
    const tick = document.createElement("div");
    tick.className = "spike-tick";
    tick.style.left = `${toFrac(ev.ts) * 100}%`;
    tick.textContent = new Date(ev.ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
    axis.appendChild(tick);
  }
  trail.appendChild(axis);

  // Observation window overlay (draggable)
  const obsOverlay = document.createElement("div");
  obsOverlay.className = "spike-obs-window";
  obsOverlay.style.left = `${S.obsStart * 100}%`;
  obsOverlay.style.width = `${(S.obsEnd - S.obsStart) * 100}%`;

  // Left handle
  const handleL = document.createElement("div");
  handleL.className = "obs-handle obs-handle-l";
  obsOverlay.appendChild(handleL);
  // Right handle
  const handleR = document.createElement("div");
  handleR.className = "obs-handle obs-handle-r";
  obsOverlay.appendChild(handleR);

  // Drag logic — attached after mount
  let dragType: "move" | "left" | "right" | null = null;
  let dragStartX = 0;
  let dragStartObs = { start: S.obsStart, end: S.obsEnd };

  function onMouseDown(e: MouseEvent, type: "move" | "left" | "right") {
    e.preventDefault();
    dragType = type;
    dragStartX = e.clientX;
    dragStartObs = { start: S.obsStart, end: S.obsEnd };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  function onMouseMove(e: MouseEvent) {
    if (!dragType) return;
    const trackWidth = t2Track.getBoundingClientRect().width || 1;
    const dx = (e.clientX - dragStartX) / trackWidth;
    const minW = 0.05;
    if (dragType === "move") {
      let newStart = dragStartObs.start + dx;
      let newEnd = dragStartObs.end + dx;
      const w = newEnd - newStart;
      if (newStart < 0) { newStart = 0; newEnd = w; }
      if (newEnd > 1) { newEnd = 1; newStart = 1 - w; }
      S.obsStart = newStart;
      S.obsEnd = newEnd;
    } else if (dragType === "left") {
      S.obsStart = Math.max(0, Math.min(dragStartObs.start + dx, S.obsEnd - minW));
    } else {
      S.obsEnd = Math.min(1, Math.max(dragStartObs.end + dx, S.obsStart + minW));
    }
    // Update overlay position directly — no full re-render during drag
    obsOverlay.style.left = `${S.obsStart * 100}%`;
    obsOverlay.style.width = `${(S.obsEnd - S.obsStart) * 100}%`;
    // Update spike highlight classes directly
    t2Track.querySelectorAll(".spike-mark").forEach((el, idx) => {
      const ev = hookEvts[idx];
      if (!ev) return;
      const f = toFrac(ev.ts);
      const inW = f >= S.obsStart && f <= S.obsEnd;
      (el as HTMLElement).classList.toggle("in-window", inW);
    });
  }

  function onMouseUp() {
    dragType = null;
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    // Full re-render on release to update prompt cards
    renderCb?.();
  }

  obsOverlay.addEventListener("mousedown", (e) => {
    if (e.target === handleL) onMouseDown(e, "left");
    else if (e.target === handleR) onMouseDown(e, "right");
    else onMouseDown(e, "move");
  });

  // Attach to t2Track (the spike lane, which spans the full width)
  t2Track.style.position = "relative";
  t2Track.appendChild(obsOverlay);

  el.appendChild(trail);

  // ---- Prompt cards (observation window) ----
  const promptSec = document.createElement("div");
  promptSec.className = "brain-section";
  promptSec.innerHTML = `<div class="brain-stratum-header"><span class="stratum-label" style="color:var(--text-1)">PROMPT TRACE</span><span class="stratum-count">observation window</span></div>`;

  // Cluster events into "prompts" (groups separated by >30s gap)
  const windowEvents = events.filter((e) => {
    const f = toFrac(e.ts);
    return f >= S.obsStart && f <= S.obsEnd;
  });

  const prompts: BrainFlowEvent[][] = [];
  let currentPrompt: BrainFlowEvent[] = [];
  for (const ev of windowEvents) {
    if (currentPrompt.length > 0) {
      const prevTs = new Date(currentPrompt[currentPrompt.length - 1].ts).getTime();
      const curTs = new Date(ev.ts).getTime();
      if (curTs - prevTs > 30000) {
        prompts.push(currentPrompt);
        currentPrompt = [];
      }
    }
    currentPrompt.push(ev);
  }
  if (currentPrompt.length > 0) prompts.push(currentPrompt);

  // Build boundary→linked entries lookup for pattern derivation
  const boundaryNodes = S.project ? buildBoundaryNodes(S.project) : [];
  const boundaryToEntries: Record<string, string[]> = {};
  for (const node of boundaryNodes) {
    boundaryToEntries[node.id] = node.linkedEntries;
  }

  // Find nearest route events for classification (routes may not cluster exactly with hooks)
  function findNearestRoute(ts: string): BrainFlowEvent | null {
    const t = new Date(ts).getTime();
    let best: BrainFlowEvent | null = null;
    let bestDist = Infinity;
    for (const ev of events) {
      if (ev.source !== "route") continue;
      const dist = Math.abs(new Date(ev.ts).getTime() - t);
      if (dist < bestDist && dist < 120000) { // within 2 min
        bestDist = dist;
        best = ev;
      }
    }
    return best;
  }

  if (prompts.length === 0) {
    promptSec.innerHTML += `<div class="brain-empty-inline">No events in this window. Drag the observation window over spikes.</div>`;
  } else {
    const promptCards = document.createElement("div");
    promptCards.className = "prompt-cards";

    for (let pi = 0; pi < prompts.length; pi++) {
      const evts = prompts[pi];
      const hooks = evts.filter((e) => e.source === "hook");
      const routes = evts.filter((e) => e.source === "route");
      const time = new Date(evts[0].ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
      const hasFatality = hooks.some((e) => e.fatality);

      // Classification: from route events in this cluster, or nearest route
      const routeInCluster = routes[0];
      const nearestRoute = routeInCluster || findNearestRoute(evts[0].ts);
      const classify = nearestRoute?.label?.replace(/\.md$/, "").toUpperCase() || "—";

      // Deduplicate boundaries and derive linked patterns per boundary
      const boundaryMap = new Map<string, { fatality: boolean; files: Set<string>; patterns: string[] }>();
      for (const h of hooks) {
        for (const b of h.label.split(", ").filter(Boolean)) {
          if (!boundaryMap.has(b)) {
            boundaryMap.set(b, { fatality: false, files: new Set(), patterns: boundaryToEntries[b] ?? [] });
          }
          const entry = boundaryMap.get(b)!;
          if (h.fatality) entry.fatality = true;
          // Extract filename from the original hook event — find matching flowEvent
          const origHook = S.flowEvents.find((fe) => fe.ts === h.ts && fe.source === "hook");
          // Hook patterns from data, or derive from boundary
          for (const p of h.patterns) {
            if (!entry.patterns.includes(p)) entry.patterns.push(p);
          }
        }
      }

      // Unique edited files from hook events
      // Hook label is "B2" or "B2, B3" — original file is in the HookLogEntry but we only have BrainFlowEvent
      // We stored file in label when no boundaries matched — check session entries for file info
      const editedFiles: string[] = [];
      const promptStart = new Date(evts[0].ts).getTime();
      const promptEnd = new Date(evts[evts.length - 1].ts).getTime();
      const activeSession = S.sessions.find((s) => s.sid === sid);
      if (activeSession) {
        for (const entry of activeSession.entries) {
          const t = new Date(entry.ts).getTime();
          if (t >= promptStart - 1000 && t <= promptEnd + 1000) {
            const fname = entry.file.split("/").pop() || entry.file;
            if (!editedFiles.includes(fname)) editedFiles.push(fname);
          }
        }
      }

      // T3 loaded files from route events
      const t3Files = routes.map((r) => r.label).filter(Boolean);
      // Also check nearest route
      if (t3Files.length === 0 && nearestRoute) {
        t3Files.push(nearestRoute.label);
      }

      const card = document.createElement("div");
      card.className = `prompt-card${hasFatality ? " fatality" : ""}`;

      // Build boundary fire HTML
      let boundaryHtml = "";
      for (const [bid, info] of boundaryMap) {
        const patternsSlice = info.patterns.slice(0, 5);
        const patternSpans = patternsSlice.map((p) => {
          const hl = !S.selection || (S.selection.type === "entry" && S.selection.id === p);
          return `<span class="prompt-pattern${hl ? "" : " dimmed"}" data-id="${p}">${p}</span>`;
        }).join(", ");
        boundaryHtml += `<div class="prompt-boundary-fire"><span class="prompt-bid${isSelected("boundary", bid) ? " sel" : ""}" data-bid="${bid}">${bid}</span>${patternSpans ? ` → ${patternSpans}` : ""}${info.fatality ? ' <span class="fatality-tag">FATALITY</span>' : ""}</div>`;
      }

      card.innerHTML = `
        <div class="prompt-card-header">
          <span class="prompt-classify">${classify}</span>
          ${hasFatality ? '<span class="fatality-tag">FATALITY</span>' : ""}
        </div>
        <div class="prompt-time-label">${time}</div>
        ${t3Files.length > 0 ? `<div class="prompt-section"><div class="prompt-section-title">T3 loaded:</div>${t3Files.map((f) => `<div class="prompt-file">${f}</div>`).join("")}</div>` : ""}
        ${boundaryMap.size > 0 ? `<div class="prompt-section"><div class="prompt-section-title">T2 hook fires:</div>${boundaryHtml}</div>` : ""}
        ${editedFiles.length > 0 ? `<div class="prompt-section"><div class="prompt-section-title">Produced:</div>${editedFiles.map((f) => `<div class="prompt-file">edit: ${f}</div>`).join("")}</div>` : ""}
      `;

      // Click handlers
      card.querySelectorAll(".prompt-pattern").forEach((span) => {
        span.addEventListener("click", (e) => { e.stopPropagation(); select("entry", (span as HTMLElement).dataset.id!); });
      });
      card.querySelectorAll(".prompt-bid").forEach((span) => {
        span.addEventListener("click", (e) => { e.stopPropagation(); select("boundary", (span as HTMLElement).dataset.bid!); });
      });

      promptCards.appendChild(card);
    }
    promptSec.appendChild(promptCards);
  }

  el.appendChild(promptSec);
  return el;
}

// ============================================================
// Selection bar
// ============================================================

function renderSelectionBar(): HTMLElement | null {
  if (!S.selection) return null;
  const bar = document.createElement("div");
  bar.className = "brain-selection-bar";

  let info = "";
  if (S.selection.type === "entry") {
    const id = S.selection.id;
    // Find entry
    let entryTitle = "";
    let entryCat = "";
    for (const cat of S.project?.catalogues ?? []) {
      const e = cat.entries.find((e) => e.id === id);
      if (e) { entryTitle = e.title; entryCat = cat.name; break; }
    }
    const boundaryRefs = S.project ? buildBoundaryNodes(S.project).filter((n) => n.linkedEntries.includes(id)).map((n) => n.id).join(", ") : "";
    const fires = S.flowEvents.filter((e) => e.patterns.includes(id)).length;
    const created = S.dates[id]?.created ? new Date(S.dates[id].created).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "?";
    const ghLinks = S.githubTrace?.entries.find((e) => e.entryId === id)?.artifacts.slice(0, 3).map((a) => a.id).join(" ") ?? "";

    info = `<span class="sel-id" style="color:${CAT_COLORS[entryCat] ?? "var(--text-1)"}">${id}</span> ${entryTitle}${boundaryRefs ? ` · ${boundaryRefs}` : ""} · ${fires} fires · Created ${created}${ghLinks ? ` · ${ghLinks}` : ""}`;
  } else if (S.selection.type === "boundary") {
    const id = S.selection.id;
    const node = S.project ? buildBoundaryNodes(S.project).find((n) => n.id === id) : null;
    const fires = S.flowEvents.filter((e) => e.label.includes(id)).length;
    info = `<span class="sel-id" style="color:var(--text-1)">${id}</span> ${node?.name ?? ""} · ${node?.patternCount ?? 0} entries · ${fires} fires${node?.fatality ? " · FATALITY" : ""}`;
  } else if (S.selection.type === "artifact") {
    const id = S.selection.id;
    // Find which entries link to this artifact
    const linkedEntries: string[] = [];
    if (S.githubTrace) {
      for (const et of S.githubTrace.entries) {
        for (const a of et.artifacts) {
          if (a.id === id && !linkedEntries.includes(et.entryId)) linkedEntries.push(et.entryId);
        }
      }
    }
    info = `<span class="sel-id" style="color:var(--cyan)">${id}</span> → ${linkedEntries.join(", ") || "no entries linked"}`;
  }

  bar.innerHTML = `<span class="sel-info">${info}</span>`;
  const clearBtn = document.createElement("button");
  clearBtn.className = "sel-clear";
  clearBtn.textContent = "clear ✕";
  clearBtn.addEventListener("click", () => { S.selection = null; renderCb?.(); });
  bar.appendChild(clearBtn);
  return bar;
}

// ============================================================
// Main export
// ============================================================

export function BrainView(projectName: string, nav: Nav, allProjectNames?: string[]): HTMLElement {
  renderCb = nav.render;

  if (S.projectName !== projectName || !S.project) {
    setTimeout(() => loadBrainData(projectName), 0);
  }

  const container = document.createElement("div");
  container.className = "brain-view";

  // Header
  const header = document.createElement("div");
  header.className = "brain-header";

  const titleRow = document.createElement("div");
  titleRow.className = "brain-title-row";
  const title = document.createElement("h2");
  title.className = "brain-title";
  title.textContent = "Brain:";
  titleRow.appendChild(title);

  if (allProjectNames && allProjectNames.length > 1) {
    const sel = document.createElement("select");
    sel.className = "brain-project-select";
    for (const p of allProjectNames) {
      const opt = document.createElement("option");
      opt.value = p;
      opt.textContent = p;
      if (p === projectName) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => nav.toBrain(sel.value));
    titleRow.appendChild(sel);
  } else {
    const nameSpan = document.createElement("span");
    nameSpan.className = "brain-title-name";
    nameSpan.textContent = projectName;
    titleRow.appendChild(nameSpan);
  }
  header.appendChild(titleRow);

  // Mode toggle
  const modeToggle = document.createElement("div");
  modeToggle.className = "brain-mode-toggle";
  for (const m of [{ id: "project" as const, label: "Project" }, { id: "session" as const, label: "Session" }]) {
    const btn = document.createElement("button");
    btn.className = `brain-mode-btn${S.mode === m.id ? " active" : ""}`;
    btn.textContent = m.label;
    btn.addEventListener("click", () => { S.mode = m.id; renderCb?.(); });
    modeToggle.appendChild(btn);
  }
  header.appendChild(modeToggle);
  container.appendChild(header);

  // Show content if we have data, even if loading a refresh
  if (S.project) {
    if (S.mode === "project") {
      container.appendChild(renderProjectMode(S.project));
    } else {
      container.appendChild(renderSessionMode());
    }
  } else if (S.loading) {
    container.innerHTML += `<div class="loading-state"><div class="loading-spinner"></div><span>Loading brain data...</span></div>`;
    return container;
  } else {
    container.innerHTML += `<div class="error-state">Failed to load project data.</div>`;
    return container;
  }

  // Selection bar
  const selBar = renderSelectionBar();
  if (selBar) container.appendChild(selBar);

  return container;
}
