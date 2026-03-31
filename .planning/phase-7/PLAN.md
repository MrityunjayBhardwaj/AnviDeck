---
phase: 7
title: Context Routing Visualization
goal: Visualize the three-tier context architecture and routing decisions
status: planned
created: 2026-04-01
---

# Phase 7 Plan: Context Routing Visualization

## Goal

Make the thesis visible: show the three-tier context architecture as an interactive diagram. For any activity type, show exactly which files get loaded, at which tier, and how much context they consume. This is the educational view — it teaches how the framework works.

## Design Analysis

### Existence Gate

1. **Who uses this?** Anyone trying to understand how the context routing protocol works — the framework author, new users, or anyone debugging why certain context wasn't loaded.
2. **What breaks without it?** The three-tier architecture is documented but not observable. You can't see which files are loaded or verify that every activity type has complete coverage.
3. **Simpler alternative?** The ContextBudget component (Phase 4) shows tier sizes but not the file-level detail or the routing logic.

### Data Sources (all existing)

- **Tier 1 files**: Known statically — CLAUDE.md, project CLAUDE.md, base-layer.md. Sizes can be measured.
- **Tier 2 mechanism**: The catalogue-context-injector hook. Behavior documented in hook source.
- **Tier 3 routing table**: The Context Routing Protocol table from ~/.claude/CLAUDE.md. Maps activity types to spec files.
- **Live routing data**: From `/tmp/anvi-route-*.log` via the route logger hook (Phase 4).
- **File sizes**: Can read actual file sizes from disk for accurate token estimates.

### Key insight

The routing table IS the data. It's defined in `~/.claude/CLAUDE.md` under "Context Routing Protocol." We can parse it directly to build the complete file chain for every activity type, then cross-reference with live route log data to show what actually loaded.

---

## Task Breakdown

### Wave 1: API

#### Task 7.1: Routing architecture API — server/routes/api.ts

**New endpoint:** `GET /api/routing-architecture`

Returns the complete three-tier architecture with file sizes:

```typescript
interface RoutingArchitecture {
  tiers: {
    tier: 1 | 2 | 3;
    name: string;
    description: string;
    files: { path: string; name: string; sizeBytes: number; estimatedTokens: number }[];
    totalTokens: number;
  }[];
  routingTable: {
    activity: string;
    files: string[];
    totalTokens: number;
  }[];
  totalCapacity: number;
}
```

**Logic:**
1. Tier 1: read `~/.claude/CLAUDE.md`, `base-layer.md`, measure sizes
2. Tier 2: describe the hook mechanism (no files to list — it's dynamic injection)
3. Tier 3: parse the routing table from `~/.claude/CLAUDE.md`, list all spec files per activity type, measure each file's size
4. Compute token estimates (~4 chars per token)

**Verification:** `curl localhost:3000/api/routing-architecture` returns all three tiers with file sizes.

### Wave 2: UI

#### Task 7.2: Types — Add routing types to shared/types.ts

#### Task 7.3: RoutingView component — ui/components/RoutingView.ts

**New file.** Four sections:

**Section 1: Architecture Diagram**
- Three horizontal tiers stacked vertically
- Each tier: name, description, file list with sizes, total tokens
- Color-coded: Tier 1 (dim/always), Tier 2 (yellow/hook), Tier 3 (cyan/routed)
- Visual token bars showing relative sizes

**Section 2: Routing Table**
- Interactive table: activity types as rows
- Click an activity → highlights which Tier 3 files get loaded
- Shows total context cost per activity (Tier 1 + Tier 3 files)
- Activities: Debugging, Planning, Implementing, Verifying, Resuming

**Section 3: Live Routing Log**
- Feed of actual routing decisions from `/tmp/anvi-route-*.log` (via existing WS)
- Each entry: timestamp, activity classification, files loaded, tier
- Correlates live data with the static routing table

**Section 4: Coverage Verification**
- For each activity type: is the file chain complete?
- Green check if all listed files exist on disk
- Red X if any file is missing
- Shows the classify→load→reason pipeline visually

#### Task 7.4: App integration + CSS

- Add "Routing" nav item in sidebar
- Add `currentView: "routing"`
- CSS for architecture diagram, routing table, coverage checks

---

## Execution Order

```
Wave 1:  7.1 API
              ↓
Wave 2:  7.2 Types → 7.3 RoutingView → 7.4 App + CSS
```

## Verification Criteria

1. Open AnviDeck → click "Routing" → see three-tier architecture diagram
2. Click an activity type → see which files get loaded with token costs
3. Coverage verification shows all files exist (green checks)
4. If route log data exists, live routing decisions appear in the log
5. All other views still work
