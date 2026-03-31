## Project: AnviDeck

Browser-based observability dashboard for the Ānvīkṣikī cognitive framework. The primary observation instrument for watching the framework operate across all projects, all sessions, in real-time and historically.

### Required Reading
1. `BUILD.md` — Complete specification: 6 views, 6 phases, technical architecture, stack decisions, data sources
2. `~/.claude/thesis/ANVI_THESIS.md` — WHY the framework exists, every mechanism explained
3. `~/.claude/CLAUDE.md` — The framework itself (principles, catalogues, dharana, dhyana, system lens)

### What This Project Is

The Anvi framework accumulates state: catalogues, dharana entries, memory, session data. A system that accumulates state NECESSARILY needs observability. AnviDeck is that observability — design-entailed, not speculative.

The user opens `localhost:3000` and sees the complete cognitive state: which boundaries are scoped, which checks are firing, what dharana says about the current file, how the framework has evolved over time.

### Architecture Decisions

**Hono server** — lightweight TypeScript, zero-config. No Express.

**Plain TypeScript UI** — no React/Vue/Svelte. Components are functions returning DOM elements. The UI is information-dense and read-heavy — reactivity frameworks add build complexity without proportional benefit.

**No build pipeline for UI** — serve via Bun directly, or single esbuild pass. No webpack, no vite.

**Filesystem-only data** — all data read from `~/.claude/` (git repo, catalogues, memory). No database, no API keys, no external services.

**Dark theme, monospace** — engineering instrument, not marketing page. Think Grafana, Bloomberg terminal.

### Data Sources

| Data | Location | Access |
|------|----------|--------|
| Framework principles | `~/.claude/CLAUDE.md` | Parse markdown sections |
| Global memory | `~/.claude/memory/*.md` | Parse frontmatter + content |
| Project memory | `~/.claude/projects/*/memory/*.md` | Glob + parse |
| Catalogues | `{project}/.anvi/*.md` or `{project}/artifacts/.anvi/*.md` | Glob + parse |
| Version history | `~/.claude/.git` | git log, git show |
| Hook activity | `/tmp/anvi-hook-*.log` | Tail + watch |
| Active sessions | `/tmp/claude-ctx-*.json` | Read + watch |

### Build Phases (from BUILD.md)

1. **Data layer + API** — markdown parser, git reader, file watcher, Hono REST routes
2. **Command Center + Project View** — home view, project deep dive, catalogue trees
3. **Timeline Slider** — git commit slider, state reconstruction, diff mode
4. **Real-Time Session Trace** — WebSocket from hook logs, cognitive trace
5. **System Lens Dashboard** — contribution matrix, cost vs catch, pruning
6. **Cross-Project Intelligence** — recurring patterns, memory network

### Constraints

- Zero config — point at `~/.claude/` and it works
- Offline-first — no external services, no cloud, no telemetry
- Fast startup — lazy file reads, immediate UI render
- Read-heavy, write-light — observe, don't modify (except staleness marking and pruning)
- Bun as runtime (fast, TypeScript-native)

### Key Types (defined in shared/types.ts)

```typescript
interface CatalogueEntry {
  id: string; title: string; sections: Record<string, string>;
  tags: string[]; origin?: string; why?: string; how?: string;
}
interface Catalogue { name: string; path: string; entries: CatalogueEntry[]; lastModified: Date; }
interface ProjectState {
  name: string; path: string; catalogues: Catalogue[]; memory: MemoryEntry[];
  fatalitySignals: number; misalignedInvariants: number; blindSpots: number;
}
interface TimelinePoint { hash: string; message: string; date: Date; filesChanged: string[]; }
```
