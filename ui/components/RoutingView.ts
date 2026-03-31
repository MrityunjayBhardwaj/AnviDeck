import { api } from "../api";
import type {
  RoutingArchitecture,
  RoutingTier,
  RoutingTableEntry,
  RoutingFileInfo,
  RouteLogEntry,
} from "../../shared/types";

interface RVState {
  arch: RoutingArchitecture | null;
  loading: boolean;
  selectedActivity: string | null;
  routeLog: RouteLogEntry[];
}

const state: RVState = {
  arch: null,
  loading: false,
  selectedActivity: null,
  routeLog: [],
};

let renderCb: (() => void) | null = null;

async function loadArchitecture(): Promise<void> {
  state.loading = true;
  renderCb?.();
  try {
    state.arch = await api.routingArchitecture();
  } catch (err) {
    console.error("Failed to load routing architecture:", err);
  }
  state.loading = false;
  renderCb?.();
}

export function addRouteToLog(entry: RouteLogEntry): void {
  state.routeLog.unshift(entry);
  if (state.routeLog.length > 100) state.routeLog.pop();
  renderCb?.();
}

const TIER_COLORS = ["var(--dim)", "var(--yellow)", "var(--cyan)"];

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
}

function renderTierDiagram(): HTMLElement {
  const container = document.createElement("div");
  container.className = "routing-diagram";

  if (!state.arch) return container;

  const maxTokens = Math.max(...state.arch.tiers.map((t) => t.totalTokens), 1);

  for (const tier of state.arch.tiers) {
    const tierEl = document.createElement("div");
    tierEl.className = "tier-block";

    const color = TIER_COLORS[tier.tier - 1] ?? "var(--text-1)";
    const barWidth = Math.max((tier.totalTokens / maxTokens) * 100, 5);

    tierEl.innerHTML = `
      <div class="tier-header">
        <span class="tier-label" style="color:${color}">Tier ${tier.tier}</span>
        <span class="tier-name">${tier.name}</span>
        <span class="tier-tokens">${formatTokens(tier.totalTokens)} tokens</span>
      </div>
      <div class="tier-desc">${tier.description}</div>
      <div class="tier-bar-container">
        <div class="tier-bar-fill" style="width:${barWidth}%;background:${color}"></div>
      </div>
      <div class="tier-files">
        ${tier.files
          .map(
            (f) => `
          <div class="tier-file">
            <span class="file-name">${f.name}</span>
            <span class="file-size">${f.sizeBytes > 0 ? `${(f.sizeBytes / 1024).toFixed(1)}KB` : "dynamic"}</span>
            <span class="file-tokens">${formatTokens(f.estimatedTokens)}</span>
          </div>`
          )
          .join("")}
      </div>
    `;

    container.appendChild(tierEl);
  }

  return container;
}

function renderRoutingTable(): HTMLElement {
  const container = document.createElement("div");
  container.className = "routing-table-section";

  container.innerHTML = `<h3 class="section-header">Routing Table — classify → load → reason</h3>`;

  if (!state.arch) return container;

  const desc = document.createElement("div");
  desc.className = "cp-desc";
  desc.textContent = "Click an activity to see which files get loaded. Total = Tier 1 (always) + Tier 3 (activity-specific).";
  container.appendChild(desc);

  for (const route of state.arch.routingTable) {
    const isSelected = state.selectedActivity === route.activity;
    const card = document.createElement("div");
    card.className = `routing-card${isSelected ? " selected" : ""}`;

    const tier1 = state.arch.tiers[0]?.totalTokens ?? 0;
    const tier3 = route.fileDetails.reduce((s, f) => s + f.estimatedTokens, 0);

    card.innerHTML = `
      <div class="routing-card-header">
        <span class="activity-name">${route.activity}</span>
        <span class="activity-cost">${formatTokens(route.totalTokens)} total</span>
        <span class="activity-breakdown">T1: ${formatTokens(tier1)} + T3: ${formatTokens(tier3)}</span>
      </div>
      ${
        isSelected
          ? `<div class="routing-card-detail">
          <div class="file-chain">
            <div class="chain-section">
              <span class="chain-label" style="color:var(--dim)">Tier 1 (always):</span>
              ${state.arch!.tiers[0].files.map((f) => `<span class="chain-file">${f.name}</span>`).join(" → ")}
            </div>
            <div class="chain-arrow">↓</div>
            <div class="chain-section">
              <span class="chain-label" style="color:var(--yellow)">Tier 2 (hook):</span>
              <span class="chain-file">dharana injection (if Write|Edit)</span>
            </div>
            <div class="chain-arrow">↓</div>
            <div class="chain-section">
              <span class="chain-label" style="color:var(--cyan)">Tier 3 (routed):</span>
              ${route.fileDetails.map((f) => `<span class="chain-file">${f.name} <span class="chain-tokens">(${formatTokens(f.estimatedTokens)})</span></span>`).join(" + ")}
            </div>
            ${route.catalogues.length > 0 ? `
            <div class="chain-arrow">↓</div>
            <div class="chain-section">
              <span class="chain-label" style="color:var(--green)">Catalogues:</span>
              ${route.catalogues.map((c) => `<span class="chain-file">${c}</span>`).join(" + ")}
            </div>` : ""}
          </div>
          <div class="coverage-check">
            ${route.fileDetails.map((f) => `
              <span class="coverage-file ${f.sizeBytes > 0 ? "exists" : "missing"}">
                ${f.sizeBytes > 0 ? "✓" : "✗"} ${f.name}
              </span>
            `).join("")}
          </div>
        </div>`
          : ""
      }
    `;

    card.querySelector(".routing-card-header")?.addEventListener("click", () => {
      state.selectedActivity = state.selectedActivity === route.activity ? null : route.activity;
      renderCb?.();
    });

    container.appendChild(card);
  }

  return container;
}

function renderLiveLog(): HTMLElement {
  const container = document.createElement("div");
  container.className = "routing-log-section";

  container.innerHTML = `<h3 class="section-header">Live Routing Decisions</h3>`;

  if (state.routeLog.length === 0) {
    container.innerHTML += `<div class="trace-empty">No routing decisions captured yet. Start a Claude Code session to see live data.</div>`;
    return container;
  }

  const feed = document.createElement("div");
  feed.className = "trace-feed routing-feed";

  for (const entry of state.routeLog) {
    const item = document.createElement("div");
    item.className = "route-entry";
    const time = new Date(entry.ts).toLocaleTimeString("en-US", { hour12: false });
    item.innerHTML = `
      <span class="entry-time">${time}</span>
      <span class="category-badge" style="color:var(--cyan)">${entry.category.toUpperCase()}</span>
      <span class="entry-file">${entry.file}</span>
      <span class="tier-badge">T${entry.tier}</span>
    `;
    feed.appendChild(item);
  }

  container.appendChild(feed);
  return container;
}

export function RoutingView(onRender: () => void): HTMLElement {
  renderCb = onRender;

  const container = document.createElement("div");
  container.className = "routing-view";

  const header = document.createElement("div");
  header.className = "lens-header";
  header.innerHTML = `<h2>Context Routing</h2>`;
  container.appendChild(header);

  if (state.loading) {
    container.innerHTML += `<div class="trace-empty">Loading architecture...</div>`;
    return container;
  }

  if (!state.arch) {
    container.innerHTML += `<div class="trace-empty">Loading...</div>`;
    setTimeout(loadArchitecture, 0);
    return container;
  }

  container.appendChild(renderTierDiagram());
  container.appendChild(renderRoutingTable());
  container.appendChild(renderLiveLog());

  return container;
}
