## Project: AnviDeck

Browser-based observability dashboard for the Ānvīkṣikī cognitive framework. The primary observation instrument for watching the framework operate across all projects, all sessions, in real-time and historically.

### Required Reading
1. `BUILD.md` — Complete specification: 7 views, 7 phases (1-3 COMPLETE), architecture, data sources
2. `ref/ANVI_THESIS.md` — WHY the framework exists, Part VI covers the three-tier context architecture this dashboard observes
3. `ref/DATA_EXAMPLES.md` — Exact input/output for every data type the parser handles

### Current State

Phases 1-3 COMPLETE (2,431 lines). App builds and runs (`bun run dev`).

| Done | Remaining |
|------|-----------|
| Data layer + REST API | Phase 4: Real-time session trace (WebSocket + hook logger) |
| Command Center + Project View | Phase 5: System lens dashboard |
| Timeline slider with diff mode | Phase 6: Cross-project intelligence |
| | Phase 7: Context routing visualization |

**Next:** Phase 4 — real-time observability. See BUILD.md Phase 4 (6 subtasks: hook logger, routing logger, WebSocket, cognitive trace, dhyana panel, context budget view).

### Architecture Decisions

**Hono server** — lightweight TypeScript, zero-config. No Express.

**Plain TypeScript UI** — no React/Vue/Svelte. Components are functions returning DOM elements. The UI is information-dense and read-heavy — reactivity frameworks add build complexity without proportional benefit.

**No build pipeline** — single esbuild pass via `bun run build.ts`. No webpack, no vite.

**Filesystem-only data** — all data read from `~/.claude/` (git repo, catalogues, memory). No database, no API keys, no external services.

**Dark theme, monospace** — engineering instrument aesthetic. Grafana/Bloomberg, not Notion.

### Data Sources

| Data | Location | Access |
|------|----------|--------|
| Framework principles | `~/.claude/CLAUDE.md` | Parse markdown sections |
| Global memory | `~/.claude/memory/*.md` | Parse frontmatter + content |
| Project memory | `~/.claude/projects/*/memory/*.md` | Glob + parse |
| Catalogues | `{project}/.anvi/*.md` or `{project}/artifacts/.anvi/*.md` | Glob + parse |
| Version history | `~/.claude/.git` | git log, git show |
| Hook activity | `/tmp/anvi-hook-{session_id}.log` | Tail + watch (Phase 4) |
| Routing decisions | `/tmp/anvi-route-{session_id}.log` | PostToolUse hook (Phase 4) |
| Active sessions | `/tmp/claude-ctx-{session_id}.json` | Read + watch |

### What This Dashboard Observes (the Three-Tier Architecture)

The Anvi framework loads context in three tiers:
- **Tier 1 (always, 39k):** CLAUDE.md + project CLAUDE.md + base-layer.md
- **Tier 2 (per-action, hook):** catalogue-context-injector reads dharana from disk on Write|Edit
- **Tier 3 (per-activity, routing):** Context Routing Protocol classifies user message, loads relevant spec files

AnviDeck visualizes all three tiers: what's always loaded (static), what the hook injected (per-action), and what the routing loaded (per-activity). The Context Budget view (Phase 4.6) shows the combined context usage.

### Constraints

- Zero config — point at `~/.claude/` and it works
- Offline-first — no external services, no cloud, no telemetry
- Fast startup — lazy file reads, immediate UI render
- Read-heavy, write-light — observe, don't modify (except staleness marking and pruning)
- Bun as runtime (fast, TypeScript-native)
