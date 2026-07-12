import { api } from "../api";
import type { LiveSession } from "../../shared/types";

interface LSState {
  sessions: LiveSession[] | null;
  error: string | null;
}

const state: LSState = { sessions: null, error: null };
let renderCb: (() => void) | null = null;
let pollStarted = false;

async function loadData(): Promise<void> {
  try {
    state.sessions = await api.sessions();
    state.error = null;
  } catch {
    state.error = "Failed to load sessions from the server.";
  }
  renderCb?.();
}

/**
 * Poll while the view is mounted. Refetching only when `.live-sessions` is in
 * the DOM keeps this self-contained — no nav lifecycle coupling — and avoids
 * churning the app when the user is looking at another view.
 */
function startPolling(): void {
  if (pollStarted) return;
  pollStarted = true;
  setInterval(() => {
    if (document.querySelector(".live-sessions")) loadData();
  }, 4000);
}

function relTime(ts: number): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function duration(fromTs: number): string {
  if (!fromTs) return "—";
  const s = Math.max(0, Math.floor((Date.now() - fromTs) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function statusClass(status: string): string {
  const s = status.toLowerCase();
  if (s === "busy") return "busy";
  if (s === "waiting") return "waiting"; // waiting for user input — needs attention
  if (s === "idle" || s === "ready") return "idle";
  return "unknown";
}

function card(s: LiveSession): string {
  const st = statusClass(s.status);
  return `
    <div class="session-card ${st}">
      <div class="session-card-top">
        <span class="session-status-dot ${st}" title="${esc(s.status)}"></span>
        <span class="session-name">${esc(s.name)}</span>
        <span class="session-status-label ${st}">${esc(s.status)}</span>
      </div>
      <div class="session-project">
        <span class="session-project-name">${esc(s.project)}</span>
        ${s.branch ? `<span class="session-branch">⑂ ${esc(s.branch)}</span>` : ""}
      </div>
      <div class="session-meta">
        <div class="session-meta-row"><span class="k">activity</span><span class="v">${relTime(s.updatedAt)}</span></div>
        <div class="session-meta-row"><span class="k">uptime</span><span class="v">${duration(s.startedAt)}</span></div>
        <div class="session-meta-row"><span class="k">pid</span><span class="v">${s.pid}</span></div>
        <div class="session-meta-row"><span class="k">version</span><span class="v">${esc(s.version || "—")}</span></div>
      </div>
      <div class="session-cwd" title="${esc(s.cwd)}">${esc(s.cwd)}</div>
    </div>`;
}

export function LiveSessions(nav: { render: () => void }): HTMLElement {
  renderCb = nav.render;

  const container = document.createElement("div");
  container.className = "live-sessions";

  const sessions = state.sessions;
  const busyCount = sessions?.filter((s) => s.status.toLowerCase() === "busy").length ?? 0;

  const header = document.createElement("div");
  header.className = "lens-header live-sessions-header";
  header.innerHTML = `
    <h2>Live Sessions</h2>
    ${
      sessions
        ? `<span class="live-sessions-count">${sessions.length} active${busyCount ? ` · ${busyCount} busy` : ""}</span>`
        : ""
    }
  `;
  container.appendChild(header);

  if (sessions === null) {
    container.innerHTML += `<div class="loading-state"><div class="loading-spinner"></div><span>Reading active sessions...</span></div>`;
    setTimeout(loadData, 0);
    startPolling();
    return container;
  }

  if (state.error) {
    container.innerHTML += `<div class="error-state">${esc(state.error)}</div>`;
    startPolling();
    return container;
  }

  if (sessions.length === 0) {
    container.innerHTML += `<div class="trace-empty">No live Claude Code sessions right now.</div>`;
    startPolling();
    return container;
  }

  const grid = document.createElement("div");
  grid.className = "session-grid";
  grid.innerHTML = sessions.map(card).join("");
  container.appendChild(grid);

  startPolling();
  return container;
}
