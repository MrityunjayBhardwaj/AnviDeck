# AnviDeck — Cognitive Framework Observability Deck

## What This Is

A browser-based observability dashboard for the Ānvīkṣikī cognitive framework. The primary observation instrument for watching the framework operate across all projects, all sessions, in real-time and historically.

Open `localhost:3000` in a browser. See everything. Click anything. Slide the timeline. Understand what led to every cognition and action.

## Why This Exists (Design-Entailed)

The Anvi framework accumulates state: catalogues grow, dharana entries multiply, memory evolves, sessions produce observations. A system that accumulates state NECESSARILY needs observability — or that state rots undetected.

This is not speculative. It's deductively necessary from the architecture:
- 4 catalogues × N projects = growing knowledge base that needs audit
- Dharana instantiation per project = instantiated checks that can go stale
- Dhyana runtime checks per session = enforcement that may or may not fire
- System lens per session = contribution data that needs visualization
- Framework git repo = version history that needs diffing

The CLI dashboard (`anvi-dashboard.sh`) is the minimal viable version. AnviDeck is the real instrument.

---

## What It Shows

### Primary Views

#### 1. Command Center (Home)
The landing page. Everything at a glance.

```
┌─────────────────────────────────────────────────────────────┐
│  ANVI DECK                                        [live] ⚡  │
├─────────────┬───────────────────────────────────────────────┤
│             │                                               │
│  PROJECTS   │  FRAMEWORK HEALTH          SESSION TIMELINE   │
│  ─────────  │  ──────────────            ────────────────   │
│  ▸ sonicPi  │  Catalogues: 4/4 ✓        ┌──────────────┐   │
│    composr  │  Fatality: 3 ⚠            │ ←─────●──→   │   │
│    struCode │  Misaligned: 6            │  commit slider│   │
│    MoGraph  │  Blind spots: 1           └──────────────┘   │
│    ...      │  Hook: active ✓                               │
│             │  Last commit: 2m ago       ACTIVE SESSION     │
│             │                            ──────────────     │
│             │  CROSS-PROJECT             sonicPiWeb          │
│             │  ──────────────            SoundLayer phase    │
│             │  16 projects               dhyana: B2 scoped  │
│             │  58 memories               hook fires: 12     │
│             │  19 feedback               catches: 3         │
│             │  4 sessions today                             │
│             │                                               │
└─────────────┴───────────────────────────────────────────────┘
```

#### 2. Project Deep Dive
Click any project. See its full cognitive state.

**Catalogues panel:**
- Each catalogue (hetvabhasa, vyapti, krama, dharana) as a collapsible tree
- Entry count, last modified, staleness indicators
- Click any entry → full content with provenance (ORIGIN/WHY/HOW)
- Diff against previous version (from git history)

**Dharana panel:**
- Boundary map: visual diagram of system boundaries with error pattern counts
- Color-coded: green (clean), yellow (approaching threshold), red (fatality)
- Invariant spans: which modules each invariant touches, ALIGNED/MISALIGNED badges
- Org health: fatality test results as a traffic light
- Composition pairs: table with verification status (verified/pending/failed)
- Observation tools: exists/to-build/blind-spot inventory

**Memory panel:**
- All memory entries for this project, sorted by type (feedback, session, project, reference)
- Recurrence counts for entries approaching dharana promotion
- Session memory → dharana promotion pipeline visible

#### 3. Session Timeline
The timeline slider at the bottom of every view.

**Data source:** `~/.claude/.git` history.

- Each commit = a point on the timeline
- Slide to any point → the entire dashboard shows framework state AT THAT COMMIT
- Diff mode: select two points → see what changed between them
- Hover any point → commit message + files changed
- Annotations: "fatality detected," "new axis created," "entry pruned"

**How it works technically:**
```
User slides to commit abc123
  → git show abc123:CLAUDE.md → render principles state
  → git show abc123:memory/ → render memory state
  → git show abc123:projects/{hash}/memory/ → render project memory
  → Compare with HEAD → highlight what's different
```

#### 4. Cognitive Trace (Real-Time Session View)
When a Claude Code session is active, show what the framework is doing.

**Hook activity log:**
- Every time `catalogue-context-injector.js` fires → logged with: file, matched boundaries, injected context
- Color-coded: red (fatality boundary touched), yellow (warning boundary), green (clean)
- Click any entry → see the dharana entry that triggered it

**Dhyana state:**
- Currently scoped boundaries (loaded from dharana at session start)
- Active hetvabhasa patterns for those boundaries
- Active vyapti invariants
- How many times each check has fired this session
- Whether any check caught something (contribution tracking for system lens)

**Lens chain trace:**
- If a diagnosis happened this session, show the lens chain:
  observation₁ → axis A → observation₂ → axis B → ... → root cause
- Each step clickable → shows the observation that activated it
- Depth indicator: surface / shallow / deep per step

**Decision log:**
- Every major decision point in the session
- What was considered, what was chosen, why
- Links to the catalogue entries or principles that informed the decision

#### 5. System Lens Dashboard
The framework's self-observation data.

**Contribution matrix:**
- Rows: catalogue entries (hetvabhasa SP1-SP14, vyapti SV1-SV13, etc.)
- Columns: sessions (last 10)
- Cells: ✓ (contributed), — (not relevant), ✗ (should have caught but didn't)
- Heat map: frequently contributing entries are hot, stale entries are cold

**Cost vs Catch:**
- Per session: how many bugs caught BY framework vs DESPITE framework
- Trend line over last 10 sessions
- Threshold alert: if "despite" exceeds "by" for 2+ consecutive sessions

**Pruning candidates:**
- Entries with 0 contributions in 5+ sessions
- Each with WHY field displayed — user decides whether to prune or keep
- "Prune" button → moves entry to archive section, adds RETIRED date

**Axis evolution:**
- Timeline of when each lens axis was created
- What blind spot triggered it
- How many times it's fired since creation

#### 6. Cross-Project Intelligence
Patterns that span multiple projects.

**Recurring error patterns:**
- Hetvabhasa entries that appear in multiple projects → structural patterns worth learning from
- "Parameter name mismatch at boundary" appears in sonicPiWeb AND struCode → this is a universal trap

**Shared invariants:**
- Vyapti entries that are structurally similar across projects
- "Observation over inference" → appears everywhere, always holds

**Memory network:**
- All memory entries across all projects, visualized as a graph
- Connections: entries that reference the same concepts
- Clusters: groups of related feedback/project memories

---

## Technical Architecture

### Stack

```
AnviDeck/
├── server/
│   ├── index.ts              ← Hono server (lightweight, TypeScript)
│   ├── routes/
│   │   ├── api.ts            ← REST API for all data
│   │   ├── ws.ts             ← WebSocket for real-time session data
│   │   └── git.ts            ← Git history queries
│   ├── readers/
│   │   ├── catalogue.ts      ← Parse .anvi/ markdown files
│   │   ├── memory.ts         ← Parse memory/ markdown files
│   │   ├── dharana.ts        ← Parse dharana.md structured sections
│   │   ├── claude-md.ts      ← Parse CLAUDE.md sections
│   │   └── git-history.ts    ← Read git log, show file at commit
│   └── watchers/
│       ├── file-watcher.ts   ← Watch .anvi/ and memory/ for changes
│       ├── hook-logger.ts    ← Read hook output logs
│       └── session-tracker.ts← Track active Claude Code sessions
├── ui/
│   ├── index.html            ← Single page app shell
│   ├── app.ts                ← Main app, routing, state
│   ├── components/
│   │   ├── CommandCenter.ts  ← Home view
│   │   ├── ProjectView.ts    ← Project deep dive
│   │   ├── Timeline.ts       ← Git commit slider
│   │   ├── CognitiveTrace.ts ← Real-time session view
│   │   ├── SystemLens.ts     ← Self-observation dashboard
│   │   ├── CrossProject.ts   ← Multi-project intelligence
│   │   ├── CatalogueTree.ts  ← Collapsible catalogue entries
│   │   ├── BoundaryMap.ts    ← Visual boundary diagram
│   │   ├── ContributionMatrix.ts ← Heat map of entry contributions
│   │   └── DiffViewer.ts     ← Side-by-side diff display
│   └── styles/
│       └── deck.css          ← Dark theme, monospace, dense info
├── shared/
│   ├── types.ts              ← Shared TypeScript types
│   └── parser.ts             ← Markdown → structured data parser
├── package.json
├── tsconfig.json
└── BUILD.md                  ← This file
```

### Why This Stack

**Hono** (server): Lightweight, TypeScript-native, zero-config. No Express boilerplate. Runs on Bun or Node.

**No React/Vue/Svelte** (UI): Plain TypeScript with DOM manipulation. The UI is information-dense and read-heavy — it doesn't need reactivity frameworks. A framework would add build complexity without proportional benefit. Components are just functions that return DOM elements.

**No build pipeline for UI**: Serve TypeScript directly via Bun, or use a single esbuild pass. No webpack, no vite config, no HMR complexity. The UI updates via WebSocket push, not client-side state management.

**Why not Electron**: This is a local dev tool. A browser tab is sufficient. No distribution, no packaging, no cross-platform concerns.

### Data Sources

All data is read from the filesystem. No database. No API keys. No external services.

| Data | Source | Access pattern |
|------|--------|---------------|
| Framework principles | `~/.claude/CLAUDE.md` | Read + parse sections |
| Global memory | `~/.claude/memory/*.md` | Read + parse frontmatter |
| Project memory | `~/.claude/projects/*/memory/*.md` | Glob + read + parse |
| Catalogues | `{project}/.anvi/*.md` or `{project}/artifacts/.anvi/*.md` | Glob + read + parse |
| Version history | `~/.claude/.git` | `git log`, `git show {commit}:{path}` |
| Hook activity | `/tmp/anvi-hook-*.log` (written by injector hook) | Tail + watch |
| Active sessions | `/tmp/claude-ctx-*.json` (written by context monitor) | Read + watch |

### Real-Time Architecture

```
catalogue-context-injector.js (hook)
    → fires on Write|Edit
    → writes to /tmp/anvi-hook-{session}.log:
      { timestamp, file, boundaries, injected, fatality }
    → AnviDeck file-watcher picks up the log entry
    → WebSocket pushes to browser
    → CognitiveTrace component updates live
```

The hook needs one addition: write a structured log line alongside the injection. Current hook only outputs to Claude's context. New behavior: also append to a log file.

### Markdown Parser

All Anvi data is markdown with structure. The parser extracts:

```typescript
interface CatalogueEntry {
  id: string          // "SP8", "SV12", "B2"
  title: string       // First line after ##
  sections: Record<string, string>  // "Root cause:", "Detection signal:", etc.
  tags: string[]      // Extracted from content: FATALITY, MISALIGNED, NOT YET IMPLEMENTED
  origin?: string     // ORIGIN field (dharana entries)
  why?: string        // WHY field (dharana entries)
  how?: string        // HOW field (dharana entries)
}

interface Catalogue {
  name: string        // "hetvabhasa", "vyapti", "krama", "dharana"
  path: string        // Absolute path to .md file
  entries: CatalogueEntry[]
  lastModified: Date
}

interface ProjectState {
  name: string
  path: string
  catalogues: Catalogue[]
  memory: MemoryEntry[]
  fatalitySignals: number
  misalignedInvariants: number
  blindSpots: number
  boundaries: BoundaryInfo[]
}
```

### Git Timeline Engine

```typescript
interface TimelinePoint {
  hash: string
  message: string
  date: Date
  filesChanged: string[]
  // Lazy-loaded: full state at this point
  stateAt?: FrameworkState
}

// Reconstruct state at any commit
async function stateAtCommit(hash: string): Promise<FrameworkState> {
  const claudeMd = await gitShow(hash, 'CLAUDE.md')
  const memories = await gitLsTree(hash, 'memory/')
  const projectMemories = await gitLsTree(hash, 'projects/')
  // Parse each file, build state
  return { principles: parse(claudeMd), memories: parseAll(memories), ... }
}
```

---

## Build Phases

### Phase 1: Data Layer + API (foundation)
**Goal:** Read all framework data from filesystem, expose via REST API.

- Markdown parser (catalogue entries, memory files, CLAUDE.md sections)
- Git history reader (log, show at commit, diff between commits)
- File watcher for live updates
- Hono server with REST routes
- API: `GET /api/projects`, `GET /api/project/:name/catalogues`, `GET /api/timeline`, `GET /api/state-at/:hash`

**Verification:** `curl localhost:3000/api/projects` returns all projects with catalogue counts.

### Phase 2: Command Center + Project View (core UI)
**Goal:** Open browser, see everything, click into projects.

- Single HTML page with embedded TypeScript
- Command Center: project list, framework health summary, active session indicator
- Project View: catalogue trees, dharana panel, memory panel
- Dark theme, monospace, dense layout (think Grafana, not marketing page)
- No timeline yet — just current state

**Verification:** Open browser, see all projects, click into sonicPiWeb, see all 14 hetvabhasa entries.

### Phase 3: Timeline Slider (version history)
**Goal:** Slide to any point in framework history, see state at that point.

- Timeline component at bottom of every view
- Git commit points rendered as interactive markers
- Slide → state reconstructed from git → UI updates
- Diff mode: select two points, see what changed
- Annotations for significant events (fatality detected, new axis, entry pruned)

**Verification:** Slide to first commit → see framework state before today's session. Slide to HEAD → see current state. Diff shows everything we added.

### Phase 4: Real-Time Session Trace (live observability)
**Goal:** Watch the framework operate in real-time during a Claude Code session.

- Update hook to also write structured log to `/tmp/anvi-hook-{session}.log`
- WebSocket connection from server to browser
- File watcher on hook log → WebSocket push → UI update
- Cognitive Trace component: hook fires, boundary matches, injections, catches
- Dhyana state: currently scoped boundaries and invariants

**Verification:** Start a Claude Code session, edit AudioInterpreter.ts. AnviDeck shows: "DHYANA: B2 touched. FATALITY. SP9, SP10, SP12 active."

### Phase 5: System Lens Dashboard (self-observation)
**Goal:** Visualize whether the framework is actually helping.

- Contribution matrix: entries × sessions heat map
- Cost vs Catch trend line
- Pruning candidates with WHY display
- Axis evolution timeline

**Verification:** After 3 sessions of SoundLayer work, the dashboard shows which catalogue entries contributed and which are candidates for pruning.

### Phase 6: Cross-Project Intelligence (pattern recognition)
**Goal:** Find patterns that span multiple projects.

- Scan all projects' catalogues for structurally similar entries
- Memory network visualization (graph of related entries)
- Recurring error pattern detection

**Verification:** If "parameter name mismatch" appears in both sonicPiWeb and struCode, the dashboard surfaces it as a cross-project pattern.

---

## Design Principles for AnviDeck Itself

**Information density over visual flair.** This is an engineering instrument, not a marketing page. Every pixel conveys data. Think: Grafana dashboards, Bloomberg terminal, aircraft cockpit — not Notion or Linear.

**Read-heavy, write-light.** The dashboard observes. It doesn't modify catalogues (that's Claude's job). The only write actions: mark entries as "reviewed" for staleness tracking, and "prune" for system lens.

**Zero config.** Point it at `~/.claude/` and it works. No environment variables, no API keys, no database setup. All data comes from the filesystem.

**Offline-first.** Everything is local. No external services, no cloud, no telemetry. The framework's data never leaves the machine.

**Fast startup.** The server reads files lazily. The UI renders immediately with cached state. Git operations are deferred until the timeline is actually opened.

**Dark theme, monospace.** Consistent with terminal aesthetics. The user switches between Claude Code (terminal) and AnviDeck (browser) — visual continuity matters.

---

## Open Questions (to resolve during implementation)

1. **Session identification:** How to reliably identify which Claude Code session is active? The context monitor hook writes `/tmp/claude-ctx-{session_id}.json` — can we use the same session ID?

2. **Project discovery:** How to find all projects? Currently: scan `~/.claude/projects/` directory names (they encode paths). Alternative: maintain a registry file.

3. **Catalogue location variance:** Some projects use `.anvi/`, others use `artifacts/.anvi/`. The readers need to handle both. Possibly configurable per project.

4. **Large git histories:** `~/.claude/.git` could grow large over many sessions. The timeline should paginate and lazy-load. Git operations should be async.

5. **Multi-session concurrent:** If two Claude Code sessions are active simultaneously, the hook logger needs to distinguish them. Session ID in the log filename handles this.

---

## Success Criteria

AnviDeck is successful when:

1. **At any point in a conversation**, the user can open the browser and see exactly what the framework is doing — which boundaries are scoped, which checks are firing, what dharana says about the current file.

2. **At session end**, the system lens dashboard shows concrete data: contribution counts, stale candidates, cost vs catch — not guesses.

3. **Across sessions**, the timeline slider shows the framework's evolution — when entries were added, when fatality was detected, when the SoundLayer consolidation was decided.

4. **Across projects**, recurring patterns are surfaced automatically — the user doesn't need to manually compare catalogues.

5. **Zero friction:** Opening `localhost:3000` shows everything. No login, no config, no waiting.
