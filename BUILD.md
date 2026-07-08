# AnviDeck — Cognitive Framework Observability Deck

## What This Is

A browser-based observability dashboard for the Ānvīkṣikī cognitive framework. The primary observation instrument for watching the framework operate across all projects, all sessions, in real-time and historically.

Open `localhost:4000` in a browser. See everything. Click anything. Slide the timeline. Understand what led to every cognition and action.

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
│   ├── index.ts              ✅ Hono + WebSocket server, file watchers, broadcast
│   ├── routes/
│   │   ├── api.ts            ✅ REST API (projects, catalogues, hook-logs, cross-project, routing-architecture, entry-dates)
│   │   └── ws.ts             ✅ WebSocket server (hono/bun upgradeWebSocket, client tracking, heartbeat)
│   ├── readers/
│   │   ├── catalogue.ts      ✅ Parse .anvi/ markdown files + boundary extraction
│   │   ├── memory.ts         ✅ Parse memory/ markdown files with frontmatter
│   │   └── git-history.ts    ✅ Read git log, show file at commit, diff
│   └── watchers/
│       ├── file-watcher.ts   ✅ Watch .anvi/ and memory/ for changes
│       └── hook-logger.ts    ✅ Tail /tmp/anvi-hook-*.log + anvi-route-*.log, parse JSON, broadcast
├── hooks/ (symlinks to ~/.claude/hooks/)
│   ├── catalogue-context-injector.js → ~/.claude/hooks/catalogue-context-injector.js  ✅ + AnviDeck logging
│   ├── anvi-route-logger.js  → ~/.claude/hooks/anvi-route-logger.js  ✅ PostToolUse Read detection
│   └── settings.json         → ~/.claude/settings.json
├── ui/
│   ├── index.html            ✅ Single page app shell
│   ├── app.ts                ✅ Main app — selective DOM updates, Nav API, WebSocket, cross-linking
│   ├── api.ts                ✅ Typed API client (all endpoints)
│   ├── components/
│   │   ├── CommandCenter.ts  ✅ Quick actions, insights banner, project list with badges
│   │   ├── ProjectView.ts    ✅ Project deep dive + breadcrumb + quick links to other views
│   │   ├── CatalogueTree.ts  ✅ Collapsible entries with tags + provenance
│   │   ├── Timeline.ts       ✅ Git commit slider with diff mode + markers
│   │   ├── DiffViewer.ts     ✅ Syntax-highlighted diff display
│   │   ├── CognitiveTrace.ts ✅ 3-panel live: Hook Activity, Dhyana State, Routing Decisions
│   │   ├── ContextBudget.ts  ✅ Three-tier context usage bar visualization
│   │   ├── SystemLens.ts     ✅ Contribution matrix, pruning candidates, entry timeline
│   │   ├── CrossProject.ts   ✅ Recurring patterns, shared invariants, memory network
│   │   ├── RoutingView.ts    ✅ Three-tier diagram, routing table, coverage verification
│   │   ├── BrainView.ts      🔲 Phase 8: State + Flow + Evolution tabs
│   │   └── GitHubTrace.ts    🔲 Phase 9: Knowledge → artifact → outcome loop
│   └── styles/
│       └── deck.css          ✅ Dark theme, monospace, all component styles (~2,400 lines)
├── shared/
│   ├── types.ts              ✅ Full type definitions (~170 lines)
│   └── parser.ts             ✅ Markdown → structured data parser (161 lines)
├── .planning/                ✅ Phase plans + research (phases 4-7)
├── ref/
│   ├── ANVI_THESIS.md        ✅ Framework thesis (923 lines, includes Part VIII)
│   └── DATA_EXAMPLES.md      ✅ Parsed data examples for every type
├── build.ts                  ✅ Single esbuild pass via Bun
├── package.json              ✅ Hono + TypeScript + Bun
├── tsconfig.json             ✅
├── CLAUDE.md                 ✅ Project instructions (reflects all 9 phases)
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

### Phase 1: Data Layer + API (foundation) — COMPLETE
**Goal:** Read all framework data from filesystem, expose via REST API.

- [x] Markdown parser — `shared/parser.ts` (161 lines). Parses catalogue entries + memory frontmatter.
- [x] Git history reader — `server/readers/git-history.ts` (114 lines). Log, show at commit, diff.
- [x] Catalogue reader — `server/readers/catalogue.ts` (112 lines). Reads .anvi/ with boundary extraction.
- [x] Memory reader — `server/readers/memory.ts` (65 lines). Parses frontmatter + content.
- [x] File watcher — `server/watchers/file-watcher.ts` (76 lines). Watches .anvi/ and memory/.
- [x] Hono server — `server/index.ts` (66 lines). Serves API + static files.
- [x] REST API — `server/routes/api.ts` (172 lines). Projects, catalogues, memory, timeline, diff.
- [x] Types — `shared/types.ts` (86 lines). Full type definitions.

**Verified:** `bun run dev` starts server, API routes return data.

### Phase 2: Command Center + Project View — COMPLETE
**Goal:** Open browser, see everything, click into projects.

- [x] Command Center — `ui/components/CommandCenter.ts` (124 lines). Project list, health summary, stats.
- [x] Project View — `ui/components/ProjectView.ts` (127 lines). Catalogue trees, dharana panel, memory panel, boundaries, health indicators.
- [x] Catalogue Tree — `ui/components/CatalogueTree.ts` (114 lines). Collapsible entries with tags (FATALITY, MISALIGNED, etc.), provenance display (ORIGIN/WHY/HOW).
- [x] App shell — `ui/app.ts` (144 lines). Routing, state management, navigation.
- [x] API client — `ui/api.ts` (20 lines). Typed fetch wrapper.
- [x] CSS — `ui/styles/deck.css` (763 lines). Full dark theme, all component styles.
- [x] Build — `build.ts` (21 lines). Single esbuild pass via Bun.

**Verified:** Browser shows all projects, click into sonicPiWeb, see catalogue entries with tags.

### Phase 3: Timeline Slider — COMPLETE
**Goal:** Slide to any point in framework history, see state at that point.

- [x] Timeline component — `ui/components/Timeline.ts` (226 lines). Interactive markers per commit.
- [x] Diff viewer — `ui/components/DiffViewer.ts` (41 lines). Syntax-highlighted diff display.
- [x] Diff mode — select two commits, show what changed between them.
- [x] Marker annotations — color-coded by content (red for fatality, yellow for warning, cyan for new axis).
- [x] Tooltip on hover — commit hash, message, date, files changed.

**Verified:** Slider shows 10 framework commits, diff between any two points works.

### Phase 4: Real-Time Session Trace (live observability) — COMPLETE
**Goal:** Watch the framework operate in real-time during a Claude Code session. See which boundaries are active, which checks fire, which files get loaded by the context routing protocol.

**4.1 Hook logger** — update `catalogue-context-injector.js` to write structured log:
- Append to `/tmp/anvi-hook-{session_id}.log` on every fire
- Format: `{ timestamp, session_id, file, relPath, boundaries: string[], fatality: boolean, injected: string }`
- Session ID from the hook's stdin JSON (`data.session_id`)
- Zero-impact on hook performance (append, not read-write)

**4.2 Context routing logger** — new mechanism to capture routing decisions:
- When the Context Routing Protocol fires (activity classification), log:
  `{ timestamp, session_id, activity_type, files_loaded: string[], message_excerpt }`
- This shows WHICH spec files were loaded for WHICH user message
- Implementation: a lightweight PostToolUse hook that detects Read tool calls to spec files

**4.3 WebSocket server** — `server/routes/ws.ts`:
- Upgrade route at `/ws`
- File watcher on `/tmp/anvi-hook-*.log` and `/tmp/anvi-route-*.log`
- On new line → parse JSON → push to all connected clients
- Heartbeat to detect disconnects

**4.4 Cognitive Trace component** — `ui/components/CognitiveTrace.ts`:
- Two-panel layout: **Hook Activity** (left) + **Routing Decisions** (right)
- Hook Activity: live feed of boundary matches, color-coded (red = fatality, green = clean)
  - Click any entry → expand to show full injected context
  - Counter: total fires this session, fatality fires, unique boundaries touched
- Routing Decisions: live feed of activity classifications + file loads
  - Shows: "DIAGNOSE → loaded adaptive-observation.md + diagnose.md + hetvabhasa.md"
  - Click → expand to show the user message that triggered the classification

**4.5 Dhyana state panel** — part of CognitiveTrace:
- Currently scoped boundaries (from dharana)
- Active hetvabhasa patterns per boundary
- Active vyapti invariants per boundary
- Fire count per check this session (how many times each boundary was touched)
- Contribution flag: did any fire CATCH something (diverged from expected)?

**4.6 Three-tier context view** — `ui/components/ContextBudget.ts`:
- Visual breakdown of what's loaded per prompt:
  ```
  Tier 1 (always): ██████████████░░░░░░ 39k / 150k
  Tier 2 (hook):   ██░░░░░░░░░░░░░░░░░ ~2k (last injection)
  Tier 3 (routed): ████████░░░░░░░░░░░ ~18k (DIAGNOSE loaded)
  Total:           ████████████████████░ 59k / 150k
  ```
- Updates live as routing decisions and hook injections occur
- Warning when approaching context limits

**Verification:** Start a Claude Code session on sonicPiWeb, edit SuperSonicBridge.ts. AnviDeck shows:
- Hook Activity: "B2 touched. FATALITY. 5 patterns cluster here."
- If user said "debug this": Routing shows "DIAGNOSE → loaded 4 files"
- Context Budget: Tier 1 (39k) + Tier 3 (25k) = 64k used
- Dhyana panel: B2 active, SP8/SP9/SP10/SP11/SP12 listed, SV12/SV13 invariants flagged

### Phase 5: System Lens Dashboard (self-observation) — COMPLETE
**Goal:** Visualize whether the framework is actually helping.

- Contribution matrix: entries × sessions heat map
  - Rows: catalogue entries (SP1-SP14, SV1-SV13, B1-B4)
  - Columns: last N sessions
  - Cells: contributed (green), not relevant (gray), should-have-caught (red)
- Cost vs Catch trend line
  - X: sessions, Y: count
  - Two lines: "caught by framework" vs "caught despite framework"
  - Alert threshold: if "despite" > "by" for 2+ consecutive sessions
- Pruning candidates with WHY display
  - List entries with 0 contributions in 5+ sessions
  - Show WHY field inline — user decides keep or retire
  - "Retire" button → archives entry with RETIRED date
- Axis evolution timeline
  - When each lens axis was created
  - What blind spot triggered it
  - Fire count since creation

**Verification:** After 3+ sessions, the matrix shows which entries pulled their weight.

### Phase 6: Cross-Project Intelligence (pattern recognition) — COMPLETE
**Goal:** Find patterns that span multiple projects.

- Recurring error patterns: scan all projects' hetvabhasa for structurally similar entries
  - Similarity: same root cause category (data-flow/timing/ownership/boundary) + similar detection signal
  - Display: "Parameter name mismatch appears in sonicPiWeb (SP9) and struCode (SC3)"
- Shared invariants: vyapti entries that hold across projects
- Memory network: graph visualization of related memory entries across projects
  - Nodes: memory entries, Edges: shared concepts/references
  - Clusters reveal cross-project knowledge themes

**Verification:** Cross-project patterns surfaced automatically without manual comparison.

### Phase 7: Context Routing Visualization — COMPLETE
**Goal:** Visualize the three-tier context architecture and routing decisions.

- Architecture diagram: interactive view of Tier 1/2/3 with file sizes
- Routing decision log: every classification with the files it loaded
- Prompt budget tracker: how much context is used per prompt over the session
- Lossless verification: for any activity type, show the complete file chain that would be loaded
- Chicken-and-egg visualization: show the classify→load→reason pipeline

**Verification:** User can see that every activity type has a complete, lossless context path.

### Phase 8: Brain View (project cognitive state) — NEXT
**Goal:** Single dense screen showing everything the framework knows about a project, how it's operating, and how understanding has evolved. The "virtual brain" of a project.

Three tabs within one "Brain" view:

**8.1 State — Situation Map:**
- Four horizontal strata: Boundaries (top) → Traps (hetvabhasa) → Rules (vyapti) → Sequences (krama)
- Each boundary as a box: size = pattern count, color = severity (red = fatality, yellow = warning, green = clean)
- Each entry shows which boundary it belongs to (dot indicator)
- Sidebar: memory entries + session activity summary
- Everything on one screen, zero clicks to understand

**8.2 Flow — Cognitive Trace Timeline:**
- Horizontal time axis with vertical lanes for each tier
- Tier 1: solid bar (always active)
- Tier 3: colored blocks showing routing decisions (DIAGNOSE, PLAN, IMPLEMENT, REVIEW)
- Tier 2: spike marks showing hook fires with boundary labels
- Below spikes: pattern IDs that activated (SP8, SP9, etc.)
- Click any spike → drill down to full activation chain (what was injected, why, which entries)
- Stars marking new entries created during session

**8.3 Evolution — Learning Over Time:**
- Entry count growth over sessions (from git history of .anvi/ files)
- When specific entries were created/modified
- Fire rates per entry over time (from hook logs)
- Key moments: "fatality detected", "new axis created", "consolidation planned"
- Shows the system literally getting smarter session over session

**Verification:** Open Brain view for sonicPiWeb → see all 41 entries across 4 strata with severity coloring. Click a boundary → see activation history. Evolution tab shows growth from 0 to 41 entries with key moments annotated.

### Phase 9: GitHub Trace (knowledge → artifact → outcome loop) — TODO
**Goal:** Close the loop from brain knowledge to GitHub artifacts. For any catalogue entry, see which issues/PRs/commits it informed. For any GitHub artifact, see which brain entries were active when it was created.

**9.1 Correlation Engine:**
- Scan commit messages for catalogue IDs (SP8, SV12, B2) → high confidence link
- Scan issue/PR bodies for catalogue keywords → high confidence
- Match commit file paths with hook fire file paths → medium confidence
- Temporal proximity: entry created → commit within 24h on same files → medium confidence
- Uses `gh` CLI (already authenticated) + local `git log`

**9.2 Entry → Artifact View:**
- For each catalogue entry: linked issues, PRs, commits with confidence scores
- Shows the full lifecycle: knowledge created → hook activated → bug found → fix merged → knowledge refined

**9.3 Artifact → Entry View (reverse):**
- For each GitHub issue/PR: which brain entries were active when it was created
- "This PR was informed by SP8, SP9, and SV12 — the framework caught the param mismatch"

**9.4 Cognitive Loop Visualization:**
```
OBSERVE → LEARN → ACTIVATE → ACT → PRODUCE → VERIFY → REFINE → loop
(session)  (entry)  (hook)    (Claude) (issue/PR)  (test)  (update)
```
- Each step traceable
- Click any node → see the data at that step

**Verification:** Click SP8 in Brain view → see Issue #47, PR #48, commit abc123 linked with "high" confidence. Click Issue #47 → see SP8, SP9 as informing entries. The loop is visible end to end.

**Data model decision: NO Neo4j.** Investigated graph visualization (2026-04-01): 41 nodes, 27 edges, 1.6% density — too sparse for graph layout. Data is stratified by cognitive function, not networked. Tables and strata represent it correctly. `gh` CLI + local git provide all needed data. Zero external infrastructure maintained.

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

1. **Session identification:** ~~How to reliably identify which Claude Code session is active?~~ **RESOLVED:** The hook receives `session_id` in stdin JSON. Log files use `/tmp/anvi-hook-{session_id}.log`. Context monitor uses `/tmp/claude-ctx-{session_id}.json`. Same ID across all.

2. **Project discovery:** ~~How to find all projects?~~ **RESOLVED in Phase 1:** Scan `~/.claude/projects/` directory names (path-encoded). Decode with `name.replace(/^-/, '/').replace(/-/g, '/')`. Implemented in `server/routes/api.ts`.

3. **Catalogue location variance:** ~~Some projects use `.anvi/`, others use `artifacts/.anvi/`.~~ **RESOLVED in Phase 1:** Reader checks both locations. Implemented in `server/readers/catalogue.ts`.

4. **Large git histories:** `~/.claude/.git` could grow large over many sessions. The timeline should paginate and lazy-load. Git operations should be async. **STILL OPEN** — current implementation loads all commits. Needs pagination for 100+ commits.

5. **Multi-session concurrent:** ~~If two Claude Code sessions are active simultaneously~~ **RESOLVED:** Session ID in log filenames distinguishes them. Each WebSocket client can filter by session.

6. **Context routing logging (NEW):** ~~The routing protocol fires inside Claude's reasoning — not via a hook.~~ **RESOLVED in Phase 4:** PostToolUse hook (`anvi-route-logger.js`) detects Read calls to spec files. Logs to `/tmp/anvi-route-{session_id}.log`. Option (a) implemented.

7. **Contribution tracking data model (NEW):** ~~The system lens needs "did this entry contribute?" data per session.~~ **RESOLVED in Phase 5:** Derive from hook logs + catalogues at render time. No new persistent file needed. "Should-have-caught" (red cells) deferred to future session report annotation.

8. **GitHub trace confidence scoring (NEW):** How reliable are the correlations between catalogue entries and GitHub artifacts? High confidence = explicit ID mention (SP8 in commit message). Medium = file overlap + temporal proximity. Low = keyword only. **Needs calibration during Phase 9 implementation.**

---

## Success Criteria

AnviDeck is successful when:

1. **At any point in a conversation**, the user can open the browser and see exactly what the framework is doing — which boundaries are scoped, which checks are firing, what dharana says about the current file. ✅ (Phase 4: Live Trace)

2. **At session end**, the system lens dashboard shows concrete data: contribution counts, stale candidates, cost vs catch — not guesses. ✅ (Phase 5: System Lens)

3. **Across sessions**, the timeline slider shows the framework's evolution — when entries were added, when fatality was detected, when the SoundLayer consolidation was decided. ✅ (Phase 3: Timeline + Phase 5: Entry Timeline)

4. **Across projects**, recurring patterns are surfaced automatically — the user doesn't need to manually compare catalogues. ✅ (Phase 6: Cross-Project Intelligence)

5. **Zero friction:** Opening `localhost:4000` shows everything. No login, no config, no waiting. ✅ (All phases)

6. **Brain View** (Phase 8): For any project, see the complete cognitive state on one screen — what the brain knows (state), what it's doing right now (flow), and how it got here (evolution).

7. **Full traceability** (Phase 9): For any catalogue entry, trace to the GitHub artifacts it informed. For any issue/PR, trace back to the brain entries that were active. The full loop from knowledge to artifact is visible.
