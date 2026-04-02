## Project: AnviDeck

Browser-based observability dashboard for the Ānvīkṣikī cognitive framework. The primary observation instrument for watching the framework operate across all projects, all sessions, in real-time and historically.

### Required Reading
1. `BUILD.md` — Complete specification: 6 views, 9 phases (1-7 COMPLETE), architecture, data sources
2. `ref/ANVI_THESIS.md` — WHY the framework exists, Part VI covers the three-tier context architecture this dashboard observes
3. `ref/DATA_EXAMPLES.md` — Exact input/output for every data type the parser handles

### v1.1.0 Ground Truth Awareness

AnviDeck now understands the three-layer grounding abstraction:
- `CatalogueEntry.ref` — the `**REF:**` field from catalogue entries (links to Ground Truth docs)
- `CatalogueEntry.grounded` — boolean, true if entry has a non-UNGROUNDED REF
- `GroundingStatus` — per-project stats: grounded/ungrounded counts, Ground Truth doc inventory
- `ProjectSummary.groundingPercent` — percentage of entries with Ground Truth refs
- Parser extracts `**REF:**` lines from catalogue markdown

**Still needed (future phases):**
- Server reader for Ground Truth doc inventory (scan `artifacts/ref/GROUND_TRUTH_*.md`)
- ProjectView grounding status panel (bar chart: grounded vs ungrounded)
- CatalogueTree REF display (clickable links to Ground Truth docs)
- BrainView Ground Truth layer (show which boundaries have Ground Truth docs)
- Command Center grounding health metric

### Current State

Phases 1-7 COMPLETE (~7,000 lines). UX polish pass done. App builds and runs (`bun run dev`).

| Done | Remaining |
|------|-----------|
| Data layer + REST API | Phase 8: Brain View (project cognitive state — situation map + flow + evolution) |
| Command Center + Project View | Phase 9: GitHub Trace (knowledge → artifact → outcome loop via `gh` CLI) |
| Timeline slider with diff mode | Phase 10: Ground Truth Visualization (three-layer grounding observability) |
| Real-time session trace (WebSocket + hooks) | |
| System Lens dashboard (contribution matrix) | |
| Cross-project intelligence (pattern recognition) | |
| Context routing visualization (three-tier diagram) | |
| UX polish (selective re-render, loading states, cross-linking) | |

**6 views in sidebar:** Command Center, Live Trace, System Lens, Cross-Project, Routing, + Project Deep Dive (via project click)

**Next:** Phase 8 — Brain View. Three tabs: State (situation map with strata), Flow (cognitive trace timeline with activation spikes), Evolution (learning across sessions). See BUILD.md Phase 8.

### Architecture Decisions

**Hono server** — lightweight TypeScript, zero-config. No Express.

**Plain TypeScript UI** — no React/Vue/Svelte. Components are functions returning DOM elements. The UI is information-dense and read-heavy — reactivity frameworks add build complexity without proportional benefit.

**No build pipeline** — single esbuild pass via `bun run build.ts`. No webpack, no vite.

**Filesystem-only data** — all data read from `~/.claude/` (git repo, catalogues, memory). No database, no API keys, no external services.

**No Neo4j/graph DB** — investigated (2026-04-01): catalogue data is 41 nodes, 27 edges, 1.6% density. Stratified by cognitive function, not networked. Tables and strata are the correct representation.

**Dark theme, monospace** — engineering instrument aesthetic. Grafana/Bloomberg, not Notion.

**Selective DOM updates** — app.ts preserves header, sidebar, timeline across navigations. Only main content area swaps. No full-page flicker.

**Nav object for cross-linking** — all components receive a `Nav` object with `toHome()`, `toProject()`, `toTrace()`, `toSystemLens()`, `toCrossProject()`, `toRouting()`. Enables click-through between views.

### Data Sources

| Data | Location | Access |
|------|----------|--------|
| Framework principles | `~/.claude/CLAUDE.md` | Parse markdown sections |
| Global memory | `~/.claude/memory/*.md` | Parse frontmatter + content |
| Project memory | `~/.claude/projects/*/memory/*.md` | Glob + parse |
| Catalogues | `{project}/.anvi/*.md` or `{project}/artifacts/.anvi/*.md` | Glob + parse |
| Version history | `~/.claude/.git` | git log, git show |
| Hook activity | `/tmp/anvi-hook-{session_id}.log` | Tail + watch via WebSocket |
| Routing decisions | `/tmp/anvi-route-{session_id}.log` | PostToolUse hook via WebSocket |
| Active sessions | `/tmp/claude-ctx-{session_id}.json` | Read + watch |
| GitHub artifacts | `gh` CLI (issues, PRs, commits) | Phase 9 — on-demand query |

### What This Dashboard Observes (the Three-Tier Architecture)

The Anvi framework loads context in three tiers:
- **Tier 1 (always, ~7k tokens):** CLAUDE.md + project CLAUDE.md + base-layer.md
- **Tier 2 (per-action, hook):** catalogue-context-injector reads dharana from disk on Write|Edit
- **Tier 3 (per-activity, routing):** Context Routing Protocol classifies user message, loads relevant spec files

AnviDeck visualizes all three tiers: what's always loaded (static), what the hook injected (per-action), and what the routing loaded (per-activity). The Context Budget view shows the combined context usage. The Brain View (Phase 8) will show the full cognitive trace timeline.

### The Cognitive Loop (Phase 9 will close this)

```
OBSERVE (session) → LEARN (new entry) → ACTIVATE (hook fires)
  → ACT (Claude uses it) → PRODUCE (issue/PR/commit)
    → VERIFY (fix works?) → REFINE (entry updated) → loop
```

### Constraints

- Zero config — point at `~/.claude/` and it works
- Offline-first — no external services, no cloud, no telemetry
- Fast startup — lazy file reads, immediate UI render
- Read-heavy, write-light — observe, don't modify (except staleness marking and pruning)
- Bun as runtime (fast, TypeScript-native)
- No external databases — filesystem + `gh` CLI only
