---
phase: 8
title: Brain View — Project Cognitive State
goal: Single dense screen showing everything the framework knows about a project, how it's operating, and how understanding has evolved
status: planned
created: 2026-04-01
---

# Phase 8 Plan: Brain View

## Goal

Three-tab "Brain" view showing a project's full cognitive state: situation map (what it knows), flow (how it operates in real-time), and evolution (how it learned over time). The virtual brain of a project.

## Design Analysis

### Existence Gate

1. **Who uses this?** The framework author (you) and anyone auditing how the framework reasons about a specific project. This is the contestability view — it proves what the framework knew, when, and how that knowledge was activated.
2. **What breaks without it?** Project View already shows catalogue entries as collapsible trees, but it doesn't show the *relationships* between them — which traps belong to which boundary, which rules guard which sequences, how activation flows during a session. The shape of the project's knowledge is invisible.
3. **Simpler alternative?** Project View exists but shows catalogues as flat lists. Brain View shows them as strata with boundary-to-entry mapping — the structural representation the data actually has (stratified by cognitive function, per the Neo4j investigation).

### Key Design Insight: Strata, Not Graph

The 2026-04-01 investigation found: 41 nodes, 27 edges, 1.6% density, heavy clustering at 4-5 hotspots. Data is **stratified** (dharana → hetvabhasa ← krama → vyapti), not networked. Four horizontal strata is the correct representation.

### Invariants

- **IV1**: Every catalogue entry belongs to exactly one stratum (hetvabhasa → Traps, vyapti → Rules, krama → Sequences, dharana → Boundaries). No entry appears in two strata.
- **IV2**: Boundary-to-entry mapping is derived from dharana's ORIGIN field (references like SP8, SV12 link entries to boundaries). This is the same extraction `catalogue.ts:countPatterns()` already does.
- **IV3**: Severity coloring is derived from tags already extracted by the parser: FATALITY (red), MISALIGNED (yellow), BLIND SPOT (orange), everything else (green/dim).
- **IV4**: Flow tab data comes from hook logs + route logs (same WebSocket stream as Live Trace). No new data source needed — it's a different visualization of the same events.
- **IV5**: Evolution data comes from git history of `.anvi/` files — same git reader as Timeline. Entry creation dates from the existing `entry-dates` endpoint.

### Lifecycle (what renders when)

```
User clicks "Brain" in sidebar (or clicks brain icon from Project View)
  → BrainView mounts with project name
  → API call: GET /api/project/:name (existing — has catalogues + boundaries)
  → API call: GET /api/project/:name/entry-dates (existing — creation dates)
  → API call: GET /api/hook-logs (existing — session activation data)
  → State tab renders immediately from catalogue data (no new API needed)
  → Flow tab renders from hook log data + live WebSocket stream
  → Evolution tab renders from entry-dates + timeline data
```

**No new API endpoints needed.** All data exists. The Brain View is a new *visualization* of existing data, not a new data source.

### Ownership

| Data | Owner | Brain View's relationship |
|------|-------|--------------------------|
| Catalogue entries | `server/readers/catalogue.ts` | Read-only consumer via API |
| Boundary info | `extractBoundaries()` in catalogue.ts | Read-only consumer |
| Entry-to-boundary links | dharana ORIGIN field (parser) | Derive at render time |
| Hook log events | WebSocket stream + `/api/hook-logs` | Read-only consumer |
| Entry creation dates | `/api/project/:name/entry-dates` | Read-only consumer |
| Tab state, selection | BrainView component | Owns |

### Pre-mortem (most likely failure modes)

1. **Empty state**: Most projects have 0 catalogue entries. The Brain View must show something useful (or a clear "no data" state) for empty projects. Not just a blank screen.
2. **Boundary mapping**: Not all entries reference a boundary in dharana. Entries without boundary assignment should appear in an "Unassigned" group, not vanish.
3. **Flow tab without live data**: If no session is active, the flow tab shows only historical data from hook logs. It shouldn't say "no data" if historical logs exist.
4. **Large catalogues**: sonicPiWeb has 41 entries. Other projects may have 0-5. The layout must work for both extremes without collapsing or overflowing.

### Chesterton Check

- `ProjectView.ts` already renders catalogue entries with CatalogueTree. Brain View is additive — it doesn't replace Project View. Both coexist. Brain View is the *structural* view (relationships), Project View is the *content* view (full entry text).
- `CognitiveTrace.ts` already renders live hook/route events. Flow tab reuses the same WebSocket data but renders it as a timeline with tier lanes, not a log feed.
- Entry dates endpoint already exists and works.

---

## Task Breakdown

### Wave 1: Types + API Client (parallel-safe, no server changes)

#### Task 8.1: Brain View types — shared/types.ts

Add types for the Brain View's internal data model. No new API response types needed — we're composing from existing types.

```typescript
// Brain View internal types (used only by BrainView.ts)
export interface BrainStratum {
  name: string;                    // "Boundaries" | "Traps" | "Rules" | "Sequences"
  catalogue: string;               // "dharana" | "hetvabhasa" | "vyapti" | "krama"
  entries: CatalogueEntry[];
  color: string;                   // CSS variable for stratum color
}

export interface BrainBoundaryNode {
  id: string;                      // "B1", "B2", etc.
  name: string;
  patternCount: number;
  fatality: boolean;
  linkedEntries: string[];         // IDs of entries that reference this boundary
}

export interface BrainFlowEvent {
  ts: string;
  tier: number;
  label: string;                   // boundary name, activity type, or pattern IDs
  fatality: boolean;
  patterns: string[];
  source: "hook" | "route";
}
```

#### Task 8.2: API client addition — ui/api.ts

Add `brainState` convenience method that fetches all required data in parallel:

```typescript
brainData: async (name: string) => {
  const [project, dates, hookLogs] = await Promise.all([
    api.project(name),
    api.entryDates(name),
    api.hookLogs(),
  ]);
  return { project, dates, hookLogs };
}
```

### Wave 2: BrainView component (depends on Wave 1)

#### Task 8.3: BrainView.ts — Tab shell + State tab

**New file:** `ui/components/BrainView.ts`

**Tab shell:**
- Three tabs: State | Flow | Evolution
- Tab state managed in module-level state (same pattern as RoutingView)
- Project name passed as parameter, triggers data load on mount
- `renderCb` pattern for re-renders from WebSocket events

**State tab (8.1 from BUILD.md) — the situation map:**

```
┌─────────────────────────────────────────────────────────┐
│ BRAIN: sonicPiWeb                    [State] Flow  Evo  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ BOUNDARIES                                              │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐    │
│ │ B2 ██████│ │ B1 ████  │ │ B3 ██    │ │ B4 █     │    │
│ │ Engine↔  │ │ App↔     │ │ Build↔   │ │ State↔   │    │
│ │ External │ │ Engine   │ │ Pipeline │ │ Runtime  │    │
│ │ 5 traps  │ │ 2 traps  │ │ 1 trap   │ │ 0 traps  │    │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘    │
│                                                         │
│ TRAPS (hetvabhasa)                     14 entries       │
│ ● SP8 Param name mismatch          → B2  ▒▒▒▒▒▒▒▒▒    │
│ ● SP9 Return value identity         → B2  ▒▒▒▒▒▒       │
│ ● SP10 Constructor timing           → B2  ▒▒▒▒          │
│ ...                                                     │
│                                                         │
│ RULES (vyapti)                         13 entries       │
│ ● SV12 Framework creates instances   MISALIGNED         │
│ ● SV13 Build transforms args         ALIGNED            │
│ ...                                                     │
│                                                         │
│ SEQUENCES (krama)                       9 entries       │
│ ● SK1 Engine init lifecycle          4 steps            │
│ ● SK4 Build pipeline                 6 steps            │
│ ...                                                     │
│                                                         │
├─────────────────────────────────────────────────────────┤
│ MEMORY (sidebar-right)               │ SESSION SUMMARY  │
│ 3 feedback, 2 project, 1 reference   │ Last active: 2h  │
│                                      │ Hook fires: 12   │
│                                      │ Fatalities: 3    │
└──────────────────────────────────────┴──────────────────┘
```

**Layout implementation:**
- Boundaries as a row of cards at the top — size proportional to pattern count, color by severity
- Three strata below: Traps, Rules, Sequences — each as a compact list
- Each entry shows: ID, title, boundary link (dot + B-ID), severity tag
- Boundary-to-entry linking: scan each entry's `sections` and `origin` for boundary IDs (B1, B2, etc.)
- Right sidebar: memory summary + session stats from hook logs
- Empty state: "No catalogues found. This project hasn't been analyzed with the framework yet."

#### Task 8.4: BrainView.ts — Flow tab

**Flow tab (8.2 from BUILD.md) — cognitive trace timeline:**

```
┌─────────────────────────────────────────────────────────┐
│ BRAIN: sonicPiWeb                     State [Flow] Evo  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ Tier 1 ████████████████████████████████████████████      │
│ (always)    always active                                │
│                                                         │
│ Tier 3 ░░░░░██DIAGNOSE██░░░░██IMPLEMENT██░░░░░░░░       │
│ (routed)                                                 │
│                                                         │
│ Tier 2    ▲        ▲  ▲          ▲                       │
│ (hook)   B2       B2  B1        B2                       │
│         SP8,9    SP10  SV4      SP8                      │
│                                                         │
│ Stars:          ★SP14                  ★SV13             │
│ (new entries)                                            │
│                                                         │
│ ─────────┬──────────┬──────────┬──────────┬───────      │
│        10:02      10:15      10:31      10:45            │
│                                                         │
│ Selected: ▲ B2 fire at 10:15                            │
│ Injected: SP8 (param mismatch), SP9 (return identity)   │
│ File: SuperSonicBridge.ts                                │
│ Fatality: YES — 5 patterns cluster at this boundary     │
└─────────────────────────────────────────────────────────┘
```

**Implementation:**
- Horizontal time axis (CSS grid or flex)
- Three lanes: Tier 1 (solid bar), Tier 3 (colored blocks per routing decision), Tier 2 (spike marks per hook fire)
- Data source: `/api/hook-logs` for historical + WebSocket for live
- Click any spike → detail panel below showing full injection details
- Stars for new entries created during session (from entry-dates where created date falls within session range)
- If no hook log data: "No session data yet. Start a Claude session on this project to see cognitive flow."

#### Task 8.5: BrainView.ts — Evolution tab

**Evolution tab (8.3 from BUILD.md) — learning over time:**

```
┌─────────────────────────────────────────────────────────┐
│ BRAIN: sonicPiWeb                     State Flow [Evo]  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ ENTRY GROWTH                                            │
│ 45│                                          ●──── 41   │
│   │                                    ●────●           │
│ 30│                              ●────●                 │
│   │                        ●────●                       │
│ 15│                  ●────●                             │
│   │           ●────●                                    │
│  0│────●────●                                           │
│   └──────────┬──────────┬──────────┬──────────          │
│           Session 1   Session 3   Session 5              │
│                                                         │
│ KEY MOMENTS                                             │
│ ★ Session 2: Fatality detected at B2 (3 patterns)      │
│ ★ Session 3: New axis — param vocabulary mismatch       │
│ ★ Session 5: Consolidation planned for B2               │
│                                                         │
│ ENTRY TIMELINE                                          │
│ hetvabhasa ██████░░░░██████░░██████████░░████████        │
│ vyapti     ░░░░░░██████░░░░░░██████████░░░░░░░░░        │
│ krama      ░░░░░░░░░░░░██████░░░░░░░░░░░░██████░        │
│ dharana    ░░░░░░░░░░░░░░░░░░████████████████████        │
│            ──────────┬──────────┬──────────┬─────        │
│                   Session 1   Session 3   Session 5      │
└─────────────────────────────────────────────────────────┘
```

**Implementation:**
- Entry count chart: simple SVG or canvas — X axis = time (from entry creation dates), Y axis = cumulative count
- Key moments: entries tagged FATALITY, BLIND SPOT, or CONSOLIDATION PLANNED — extracted from tags + creation dates
- Entry timeline: horizontal bars per catalogue showing when entries were created (colored blocks)
- Data: all from `entry-dates` endpoint + catalogue tags
- If no dates: "No creation dates available (project not tracked in git)."

### Wave 3: Integration (depends on Wave 2)

#### Task 8.6: App integration — ui/app.ts

- Import BrainView
- Add `"brain"` to ViewName union
- Add brain to Nav interface: `toBrain: (project: string) => void`
- Add brain case in `renderMain()`:
  ```typescript
  } else if (currentView === "brain" && currentProject) {
    mainEl!.appendChild(BrainView(currentProject.name, nav));
  }
  ```
- Add "Brain" to sidebar views list (between "Live Trace" and "System Lens")
- Add brain icon/link in ProjectView for quick navigation

#### Task 8.7: CSS — ui/styles/deck.css

Styles for all Brain View elements:

- `.brain-view` — container
- `.brain-tabs` — tab bar (State | Flow | Evolution)
- `.brain-tab.active` — selected tab
- `.brain-strata` — four-layer stacked layout
- `.boundary-cards` — horizontal flex row for boundary boxes
- `.boundary-card` — box with severity color, pattern count bar
- `.boundary-card.fatality` — red border/glow
- `.stratum` — section for each catalogue layer
- `.stratum-header` — layer name + entry count
- `.stratum-entry` — compact entry row (ID, title, boundary dot, tag)
- `.brain-sidebar` — right column for memory + session stats
- `.flow-timeline` — horizontal timeline container
- `.flow-lane` — single tier lane
- `.flow-spike` — hook fire marker (triangle)
- `.flow-spike.fatality` — red spike
- `.flow-block` — routing decision block (colored by activity)
- `.flow-star` — new entry marker
- `.flow-detail` — expanded spike detail panel
- `.evo-chart` — growth chart container
- `.evo-moments` — key moments list
- `.evo-bars` — horizontal catalogue timeline bars

Color scheme (consistent with existing):
- Boundaries/Fatality: `var(--red)` / `#ff4444`
- Warning/MISALIGNED: `var(--yellow)` / `#ffcc00`
- Clean/ALIGNED: `var(--green)` / `#44ff88`
- Traps (hetvabhasa): `var(--red)` dimmed
- Rules (vyapti): `var(--cyan)`
- Sequences (krama): `var(--yellow)` dimmed
- Boundaries (dharana): `var(--text-1)` / white

---

## Execution Order

```
Wave 1:  8.1 Types  ←→  8.2 API client     (parallel, independent)
              ↓
Wave 2:  8.3 State tab → 8.4 Flow tab → 8.5 Evolution tab  (sequential within BrainView.ts)
              ↓
Wave 3:  8.6 App integration + 8.7 CSS      (parallel, both depend on Wave 2)
```

## Verification Criteria

1. **State tab**: Open Brain view for a project with catalogues → see 4 strata with entries grouped by catalogue type. Boundary cards at top with severity coloring. Click a boundary card → entries linked to it are highlighted.
2. **State tab (empty)**: Open Brain view for a project without catalogues → see clear "no data" message, not a blank screen.
3. **Flow tab**: If hook log data exists for the project → see timeline with tier lanes and spike markers. Click a spike → see injection details.
4. **Flow tab (empty)**: No hook data → see "no session data" message with guidance.
5. **Evolution tab**: If entry dates exist → see growth chart and key moments. Catalogue bars show when entries were created.
6. **Navigation**: "Brain" appears in sidebar. Clicking it asks for a project selection (or uses the last viewed project). Brain link in Project View works.
7. **Live updates**: While a Claude session is active on the project, Flow tab updates via WebSocket as new hook/route events arrive.
8. **All existing views still work** — no regressions.

## Estimated Scope

- **New files**: 1 (`ui/components/BrainView.ts`, ~400-500 lines)
- **Modified files**: 3 (`shared/types.ts` ~20 lines, `ui/api.ts` ~8 lines, `ui/app.ts` ~25 lines, `ui/styles/deck.css` ~200 lines)
- **New API endpoints**: 0 (all data from existing endpoints)
- **Total new code**: ~650-750 lines
