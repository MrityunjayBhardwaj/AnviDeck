---
phase: 5
title: System Lens Dashboard
goal: Visualize whether the cognitive framework is actually helping
status: planned
created: 2026-04-01
---

# Phase 5 Plan: System Lens Dashboard

## Goal

Answer the question: "Is the framework pulling its weight?" Show which catalogue entries caught bugs, which are stale, and whether the framework's cost is justified by its catches. This is the framework observing itself.

## Design Analysis

### Existence Gate

1. **Who uses this?** The framework author, deciding which entries to keep, prune, or strengthen.
2. **What breaks without it?** Catalogues grow indefinitely. Stale entries waste context tokens. No data-driven pruning — only gut feel.
3. **Simpler alternative?** A text-based session report exists (`/anvi:session-report`), but it's per-session and not aggregated. The dashboard needs the cross-session view.

### Data Model Decision (BUILD.md Open Question #7)

**Decision: Derive from hook logs + catalogues. No new persistent file for MVP.**

Rationale:
- Hook logs (`/tmp/anvi-hook-*.log`) already record which boundaries, patterns, and invariants fired per session. Phase 4's hook update populates these arrays.
- Catalogues (`.anvi/*.md`) define the full set of entries — the "universe" of possible contributions.
- Git history (`~/.claude/.git`) shows when entries were created (for axis evolution).
- The dashboard COMPUTES the contribution matrix at render time by cross-referencing logs with catalogues.

What we CAN show from existing data:
- **Fired this session** (from hook logs) → "contributed" (green)
- **Exists but didn't fire** (from catalogues minus logs) → "not relevant" (gray)
- **Entry age and creation date** (from git history) → "stale candidate" if old + never fired

What we CANNOT show without human annotation:
- **"Should have caught but didn't"** (red) — requires knowing a bug happened that the framework missed. Deferred to future annotation mechanism.

This avoids creating a new file format while delivering 80% of the value. The missing 20% (should-have-caught) can be added later via session report enrichment.

### Invariants

**V1: Read-only dashboard.** The system lens observes — it does not modify catalogues. The only write action is a "Retire" button that marks an entry (future — needs careful design since it modifies `.anvi/` files in other projects).

**V2: Hook logs are ephemeral.** `/tmp/` files don't survive reboots. The dashboard shows data from the CURRENT session and any still-present log files. For historical data, we'd need persistence — but that's beyond MVP scope.

**V3: Catalogue entries are the source of truth.** The dashboard reads catalogues to know what entries exist. If a catalogue is empty, the system lens is empty. No phantom entries.

**V4: No external infrastructure.** All data from filesystem. No database, no API keys.

### Lifecycle

```
1. User opens System Lens view in AnviDeck
2. Dashboard fetches all projects with catalogues (existing /api/projects)
3. For each project: fetch full catalogue data (existing /api/project/:name)
4. Scan /tmp/ for hook log files → parse all entries
5. Build contribution matrix: catalogue entries × sessions
6. Compute staleness: entries with 0 fires across all available logs
7. Compute axis evolution: git log for .anvi/ files → creation dates
8. Render: matrix heat map, pruning candidates, axis timeline
```

### Ownership Map

| Data | Created by | Consumed by | Source of truth |
|------|-----------|-------------|-----------------|
| Catalogue entries (full set) | `.anvi/*.md` files | System Lens dashboard | REST API `/api/project/:name` |
| Hook fire data (which entries fired) | `/tmp/anvi-hook-*.log` | System Lens dashboard | New API endpoint |
| Entry creation dates | Git history | Axis evolution view | New API endpoint |
| Staleness computation | Dashboard (client-side) | Pruning candidates panel | Computed at render |

### Pre-mortem

**F1: No hook log data available.** If no Claude Code session has been active since Phase 4 was deployed, `/tmp/` has no logs (or only pre-Phase-4 logs with empty patterns arrays). **Mitigation:** Show empty state with explanation. The dashboard is useful even without live data — it still shows catalogue inventory, entry counts, and creation dates from git.

**F2: Too many catalogue entries to display.** sonicPiWeb has 45 entries (14+13+9+9). A full matrix with 45 rows could be overwhelming. **Mitigation:** Group by catalogue type, collapse by default. Show summary counts first, expand on click.

**F3: Hook logs span multiple projects.** A single `/tmp/` directory may have logs from different projects in different sessions. **Mitigation:** Each log entry has `sid` (session ID) but not project name. Cross-reference boundaries in log entries with project dharana to attribute entries to projects.

**F4: Git history for .anvi/ is in project repos, not ~/.claude/.git.** Axis evolution needs "when was SP8 added?" — this is in the PROJECT's git history, not the framework repo. **Mitigation:** New API endpoint that runs `git log` on the project's `.anvi/` directory.

---

## Task Breakdown

### Wave 1: API Endpoints (server-side data)

#### Task 5.1: Hook log aggregation API — server/routes/api.ts

**New endpoint:** `GET /api/hook-logs`

Returns all parsed hook log entries from `/tmp/anvi-hook-*.log` files.

```typescript
interface HookLogSummary {
  sessions: {
    sid: string;
    entries: HookLogEntry[];
    boundaries: string[];
    totalFires: number;
    fatalityFires: number;
  }[];
}
```

**Logic:** Reuse the same file scanning logic from `hook-logger.ts` watcher, but as a one-shot read (not watch). Read all `/tmp/anvi-hook-*.log` files, parse JSON lines, group by session ID.

**Verification:** `curl localhost:3000/api/hook-logs` returns grouped session data.

#### Task 5.2: Catalogue entry creation dates API — server/routes/api.ts

**New endpoint:** `GET /api/project/:name/entry-dates`

Returns creation dates for catalogue entries by scanning project git history.

```typescript
interface EntryDates {
  [entryId: string]: {
    created: string; // ISO date of first commit containing this entry
    lastModified: string; // ISO date of last commit touching this entry
  };
}
```

**Logic:** Run `git log --diff-filter=A --format="%aI" -- .anvi/hetvabhasa.md` etc. on the project directory. Parse the git log to find when each entry ID (SP1, SV1, etc.) first appeared.

**Simplification:** If git parsing per-entry is too expensive, fall back to file-level dates: when was `hetvabhasa.md` last modified? This is less granular but still useful.

**Verification:** `curl localhost:3000/api/project/sonicPiWeb/entry-dates` returns dates for SP1-SP14 etc.

### Wave 2: UI Components

#### Task 5.3: Types — Add system lens types to shared/types.ts

```typescript
export interface ContributionCell {
  status: "contributed" | "not-relevant" | "stale";
  fireCount: number;
}

export interface ContributionRow {
  entryId: string;
  entryTitle: string;
  catalogue: string; // "hetvabhasa" | "vyapti" | "krama" | "dharana"
  sessions: Record<string, ContributionCell>; // sid → cell
  totalFires: number;
  lastFired: string | null; // ISO date
  created: string | null; // ISO date
  why?: string; // WHY field from catalogue (for pruning review)
}

export interface SystemLensData {
  project: string;
  rows: ContributionRow[];
  sessionIds: string[];
  staleCandidates: ContributionRow[];
  summary: {
    totalEntries: number;
    activeEntries: number; // fired at least once
    staleEntries: number; // 0 fires
    fatalityBoundaries: number;
  };
}
```

#### Task 5.4: SystemLens component — ui/components/SystemLens.ts

**New file.** The main system lens view with three sections:

**Section 1: Contribution Matrix (heat map)**
- Project selector dropdown (defaults to project with most catalogues)
- Table: rows = catalogue entries, columns = sessions from hook logs
- Cell colors: green (fired), gray (not relevant), dim (no data)
- Fire count shown in each cell
- Row sorting: by total fires (descending), then by catalogue type
- Grouped by catalogue type (hetvabhasa, vyapti, krama, dharana) with collapsible headers

**Section 2: Pruning Candidates**
- Entries with 0 fires across all available sessions
- Each shows: entry ID, title, WHY field (from catalogue provenance)
- Visual emphasis: the WHY field helps decide "keep or retire?"
- No "Retire" button for MVP — this is observability, not modification

**Section 3: Entry Timeline**
- Simple list of entries sorted by creation date (from git)
- Shows: entry ID, title, created date, total fires since creation
- Highlights: entries created recently (last 7 days) vs. old entries

**Data flow:**
1. On mount: fetch project list → select default project
2. Fetch `/api/project/:name` (catalogues) + `/api/hook-logs` (fire data)
3. Optionally fetch `/api/project/:name/entry-dates` (creation dates)
4. Compute contribution matrix client-side
5. Render

**Verification:** Open System Lens, select sonicPiWeb, see 45 entries in matrix grouped by catalogue type. If hook logs exist, cells are colored.

#### Task 5.5: App integration — wire SystemLens into app.ts

**Modified:** `ui/app.ts`

- Add "system-lens" view: `currentView: "home" | "project" | "trace" | "system-lens"`
- Add "System Lens" nav item in sidebar
- Import and render SystemLens when in system-lens view

**Verification:** Click "System Lens" in sidebar → component renders.

### Wave 3: Styles

#### Task 5.6: CSS — Add system lens styles to deck.css

**New sections:**
- `.system-lens` — main container
- `.contribution-matrix` — table/grid styles
- `.matrix-cell` — color-coded cells (green, gray, dim)
- `.catalogue-group` — collapsible section per catalogue type
- `.pruning-candidates` — list of stale entries with WHY display
- `.entry-timeline` — chronological entry list
- `.project-selector` — dropdown styling

**Colors:** Fired = `var(--green)`, not relevant = `var(--bg-3)`, stale = `var(--yellow)` outline, fatality = `var(--red)`.

---

## Execution Order

```
Wave 1 (parallel):  5.1 Hook Log API  |  5.2 Entry Dates API
                              ↓
Wave 2 (sequential): 5.3 Types → 5.4 SystemLens → 5.5 App Integration
                              ↓
Wave 3:              5.6 CSS
```

## Verification Criteria (Phase Goal)

The phase is DONE when:
1. Open AnviDeck → click "System Lens" → see the dashboard
2. Select a project with catalogues (e.g., sonicPiWeb) → matrix shows all entries grouped by type
3. If hook log data exists: cells show fire counts with green coloring
4. Entries with 0 fires listed as pruning candidates with WHY fields visible
5. Entry timeline shows creation dates (from git or file modification)
6. REST API still works, Live Trace still works (backward compatible)
