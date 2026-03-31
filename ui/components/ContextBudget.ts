import type { HookLogEntry, RouteLogEntry } from "../../shared/types";

// Estimated token sizes for context tiers
const TIER1_BASE = 39_000; // CLAUDE.md + project CLAUDE.md + base-layer.md
const DEFAULT_CAPACITY = 200_000;

// Approximate token sizes for spec files loaded by routing
const SPEC_FILE_SIZES: Record<string, number> = {
  "adaptive-observation.md": 8_000,
  "diagnose.md": 4_000,
  "design.md": 5_000,
  "review.md": 4_000,
  "recover.md": 3_000,
  "base-layer.md": 5_000,
  "context-rot.md": 2_000,
  "translation.md": 3_000,
  "dharana-spec.md": 4_000,
  "dhyana-spec.md": 3_000,
  "hetvabhasa.md": 6_000,
  "vyapti.md": 5_000,
  "krama.md": 4_000,
  "dharana.md": 5_000,
};

// Average hook injection size in tokens
const HOOK_INJECTION_SIZE = 500;

interface BudgetState {
  tier1: number;
  tier2: number; // accumulated hook injections
  tier3: number; // accumulated routing loads
  capacity: number;
  hookCount: number;
  routeFiles: Set<string>; // deduplicate per-session
}

const state: BudgetState = {
  tier1: TIER1_BASE,
  tier2: 0,
  tier3: 0,
  capacity: DEFAULT_CAPACITY,
  hookCount: 0,
  routeFiles: new Set(),
};

export function addHookToBudget(_entry: HookLogEntry): void {
  state.hookCount++;
  state.tier2 = state.hookCount * HOOK_INJECTION_SIZE;
}

export function addRouteToBudget(entry: RouteLogEntry): void {
  if (!state.routeFiles.has(entry.file)) {
    state.routeFiles.add(entry.file);
    state.tier3 += SPEC_FILE_SIZES[entry.file] ?? 3_000;
  }
}

export function setCapacity(capacity: number): void {
  state.capacity = capacity;
}

export function resetBudget(): void {
  state.tier1 = TIER1_BASE;
  state.tier2 = 0;
  state.tier3 = 0;
  state.hookCount = 0;
  state.routeFiles.clear();
}

function renderBar(
  label: string,
  value: number,
  max: number,
  color: string
): HTMLElement {
  const row = document.createElement("div");
  row.className = "budget-row";

  const pct = Math.min((value / max) * 100, 100);
  const kValue = (value / 1000).toFixed(0);

  row.innerHTML = `
    <span class="budget-label">${label}</span>
    <div class="budget-bar">
      <div class="budget-fill" style="width:${pct}%;background:${color}"></div>
    </div>
    <span class="budget-value">${kValue}k</span>
  `;

  return row;
}

export function ContextBudget(): HTMLElement {
  const container = document.createElement("div");
  container.className = "context-budget";

  const header = document.createElement("div");
  header.className = "budget-header";
  const total = state.tier1 + state.tier2 + state.tier3;
  const totalPct = ((total / state.capacity) * 100).toFixed(0);
  header.innerHTML = `
    <h3>Context Budget</h3>
    <span class="budget-total${total / state.capacity > 0.8 ? " warning" : ""}">${(total / 1000).toFixed(0)}k / ${(state.capacity / 1000).toFixed(0)}k (${totalPct}%)</span>
  `;
  container.appendChild(header);

  const bars = document.createElement("div");
  bars.className = "budget-bars";

  bars.appendChild(
    renderBar("Tier 1 (always)", state.tier1, state.capacity, "var(--dim)")
  );
  bars.appendChild(
    renderBar(
      `Tier 2 (hook x${state.hookCount})`,
      state.tier2,
      state.capacity,
      "var(--yellow)"
    )
  );
  bars.appendChild(
    renderBar(
      `Tier 3 (routed x${state.routeFiles.size})`,
      state.tier3,
      state.capacity,
      "var(--cyan)"
    )
  );

  // Total bar
  const totalBar = renderBar("Total", total, state.capacity, "var(--green)");
  if (total / state.capacity > 0.8) {
    totalBar.classList.add("budget-warning");
  }
  bars.appendChild(totalBar);

  container.appendChild(bars);
  return container;
}
